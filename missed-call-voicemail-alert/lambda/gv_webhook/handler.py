"""Webhook from Gmail (YouMail / Google Voice emails) → SMS/MMS + email."""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

import boto3
from botocore.exceptions import ClientError

from gv_client import fetch_voicemail_audio as fetch_gv_voicemail_audio
from youmail_client import fetch_voicemail_audio as fetch_youmail_voicemail_audio

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sms = boto3.client("pinpoint-sms-voice-v2")
ses = boto3.client("ses")
s3 = boto3.client("s3")
secrets = boto3.client("secretsmanager")
dynamodb = boto3.resource("dynamodb")

RECIPIENT_PHONE = os.environ["RECIPIENT_PHONE"]
RECIPIENT_EMAIL = os.environ["RECIPIENT_EMAIL"]
SENDER_EMAIL = os.environ["SENDER_EMAIL"]
ORIGINATION_IDENTITY = os.environ["ORIGINATION_IDENTITY"]
WEBHOOK_SECRET = os.environ["WEBHOOK_SECRET"]
OPT_OUT_TABLE = os.environ.get("OPT_OUT_TABLE", "")
MMS_BUCKET = os.environ.get("MMS_BUCKET", "")
MMS_MAX_AUDIO_BYTES = int(os.environ.get("MMS_MAX_AUDIO_BYTES", "614400"))
GV_SESSION_SECRET_ARN = os.environ.get("GV_SESSION_SECRET_ARN", "")
YOUMAIL_SESSION_SECRET_ARN = os.environ.get("YOUMAIL_SESSION_SECRET_ARN", "")

_gv_session_cache: dict[str, Any] = {"value": "", "loaded_at": 0.0}
_youmail_session_cache: dict[str, Any] = {"value": "", "loaded_at": 0.0}


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    headers = event.get("headers") or {}
    secret = headers.get("x-webhook-secret") or headers.get("X-Webhook-Secret", "")
    if secret != WEBHOOK_SECRET:
        return response(401, {"error": "unauthorized"})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return response(400, {"error": "invalid json"})

    if is_opted_out():
        return response(200, {"status": "skipped", "reason": "opted_out"})

    alert_type = body.get("alertType", "voicemail")
    caller = format_phone(body.get("caller", "Unknown"))
    subject = body.get("subject", "")
    snippet = body.get("snippet", "")
    play_url = body.get("playUrl", "")
    email_source = body.get("emailSource", "")
    transcript = body.get("transcript", "") or body.get("snippet", "")
    if caller == "Unknown":
        caller = extract_caller(subject, snippet)

    email_timestamp = parse_timestamp(body.get("emailTimestamp"))
    audio_bytes, audio_name, audio_type, audio_source = resolve_audio(
        body, alert_type, caller, email_timestamp, play_url, email_source
    )
    recording_url = ""
    if audio_bytes and MMS_BUCKET:
        recording_url = store_audio_and_get_play_url(audio_bytes, audio_name, audio_type)

    time_str = datetime.now(timezone.utc).astimezone().strftime("%b %d, %I:%M %p")
    sms_body, email_subject, email_body, email_html = build_messages(
        alert_type,
        caller,
        time_str,
        subject,
        snippet,
        play_url,
        transcript,
        has_audio=bool(audio_bytes),
        audio_source=audio_source,
        recording_url=recording_url,
    )

    try:
        phone_delivery = send_phone_alert(
            sms_body, audio_bytes, audio_name, audio_type, alert_type
        )
    except Exception as exc:
        logger.error("Phone alert failed (email will still send): %s", exc)
        phone_delivery = f"failed:{exc}"

    if alert_type == "voicemail" and not audio_bytes:
        logger.warning("voicemail sent without audio caller=%s playUrl=%s", caller, bool(play_url))

    try:
        email_id = send_email(
            email_subject, email_body, email_html, audio_bytes, audio_name, audio_type, caller
        )
    except Exception as exc:
        logger.error("Email send failed: %s", exc)
        return response(
            502,
            {
                "error": "email_failed",
                "detail": str(exc),
                "phoneDelivery": phone_delivery,
            },
        )

    logger.info(
        "alert caller=%s type=%s hasAudio=%s audioBytes=%d phone=%s source=%s",
        caller,
        alert_type,
        bool(audio_bytes),
        len(audio_bytes) if audio_bytes else 0,
        phone_delivery,
        email_source or "unknown",
    )

    return response(
        200,
        {
            "status": "sent",
            "alertType": alert_type,
            "caller": caller,
            "phoneDelivery": phone_delivery,
            "emailId": email_id,
            "hasAudio": bool(audio_bytes),
            "audioSource": audio_source,
            "hasPlayUrl": bool(recording_url),
        },
    )


def resolve_audio(
    body: dict[str, Any],
    alert_type: str,
    caller: str,
    email_timestamp: datetime | None,
    play_url: str,
    email_source: str,
) -> tuple[bytes | None, str, str, str]:
    audio_bytes, audio_name, audio_type = decode_audio(body)
    if audio_bytes and len(audio_bytes) >= 500:
        return audio_bytes, audio_name, audio_type, body.get("audioSource", "recording")

    if alert_type != "voicemail":
        return None, "", "", ""

    use_youmail = email_source == "youmail" or "youmail.com" in (play_url or "")
    if use_youmail and play_url:
        result = fetch_youmail_voicemail_audio("", caller, play_url=play_url)
        if result:
            audio_bytes, audio_name = result
            return audio_bytes, audio_name, "audio/mpeg", "recording"

    session_json = get_gv_session_json()
    if session_json:
        result = fetch_gv_voicemail_audio(session_json, caller, around=email_timestamp)
        if result:
            audio_bytes, audio_name = result
            return audio_bytes, audio_name, "audio/mpeg", "recording"

    if not use_youmail and play_url and "youmail.com" in play_url:
        result = fetch_youmail_voicemail_audio("", caller, play_url=play_url)
        if result:
            audio_bytes, audio_name = result
            return audio_bytes, audio_name, "audio/mpeg", "recording"

    return None, "", "", ""


def get_youmail_session_json() -> str:
    if not YOUMAIL_SESSION_SECRET_ARN:
        return ""
    now = time.time()
    if _youmail_session_cache["value"] and now - _youmail_session_cache["loaded_at"] < 300:
        return _youmail_session_cache["value"]
    try:
        resp = secrets.get_secret_value(SecretId=YOUMAIL_SESSION_SECRET_ARN)
        value = resp.get("SecretString") or ""
        _youmail_session_cache["value"] = value
        _youmail_session_cache["loaded_at"] = now
        return value
    except ClientError as exc:
        logger.warning("Could not load YouMail credentials: %s", exc)
        return ""


def get_gv_session_json() -> str:
    if not GV_SESSION_SECRET_ARN:
        return ""
    now = time.time()
    if _gv_session_cache["value"] and now - _gv_session_cache["loaded_at"] < 300:
        return _gv_session_cache["value"]
    try:
        resp = secrets.get_secret_value(SecretId=GV_SESSION_SECRET_ARN)
        value = resp.get("SecretString") or ""
        _gv_session_cache["value"] = value
        _gv_session_cache["loaded_at"] = now
        return value
    except ClientError as exc:
        logger.warning("Could not load Google Voice session: %s", exc)
        return ""


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def decode_audio(body: dict[str, Any]) -> tuple[bytes | None, str, str]:
    encoded = body.get("audioBase64")
    if not encoded:
        return None, "", ""
    try:
        audio_bytes = base64.b64decode(encoded)
    except Exception:
        logger.warning("Invalid audioBase64 payload")
        return None, "", ""
    file_name = body.get("audioFileName") or "voicemail.mp3"
    content_type = body.get("audioContentType") or guess_audio_type(file_name)
    return audio_bytes, file_name, content_type


def guess_audio_type(file_name: str) -> str:
    lower = file_name.lower()
    if lower.endswith(".wav"):
        return "audio/wav"
    if lower.endswith(".m4a"):
        return "audio/mp4"
    return "audio/mpeg"


def store_audio_and_get_play_url(
    audio_bytes: bytes,
    audio_name: str,
    audio_type: str,
) -> str:
    key = (
        f"recordings/{datetime.now(timezone.utc).strftime('%Y/%m/%d')}/"
        f"{uuid.uuid4().hex}{extension_for(audio_name)}"
    )
    s3.put_object(
        Bucket=MMS_BUCKET,
        Key=key,
        Body=audio_bytes,
        ContentType=audio_type,
        ContentDisposition=f'inline; filename="{audio_name}"',
    )
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": MMS_BUCKET, "Key": key},
        ExpiresIn=7 * 24 * 3600,
    )


def send_phone_alert(
    sms_body: str,
    audio_bytes: bytes | None,
    audio_name: str,
    audio_type: str,
    alert_type: str,
) -> str:
    if (
        alert_type == "voicemail"
        and audio_bytes
        and MMS_BUCKET
        and len(audio_bytes) <= MMS_MAX_AUDIO_BYTES
    ):
        try:
            key = (
                f"mms/{datetime.now(timezone.utc).strftime('%Y/%m/%d')}/"
                f"{uuid.uuid4().hex}{extension_for(audio_name)}"
            )
            s3.put_object(
                Bucket=MMS_BUCKET,
                Key=key,
                Body=audio_bytes,
                ContentType=audio_type,
            )
            result = sms.send_media_message(
                DestinationPhoneNumber=RECIPIENT_PHONE,
                OriginationIdentity=ORIGINATION_IDENTITY,
                MessageBody=sms_body,
                MediaUrls=[f"s3://{MMS_BUCKET}/{key}"],
            )
            return f"mms:{result['MessageId']}"
        except Exception as exc:
            logger.warning("MMS failed (%s); falling back to SMS", exc)

    try:
        result = sms.send_text_message(
            DestinationPhoneNumber=RECIPIENT_PHONE,
            OriginationIdentity=ORIGINATION_IDENTITY,
            MessageBody=sms_body,
        )
        return f"sms:{result['MessageId']}"
    except Exception as exc:
        logger.error("SMS send failed: %s", exc)
        raise


def send_email(
    subject: str,
    body: str,
    html_body: str,
    audio_bytes: bytes | None,
    audio_name: str,
    audio_type: str,
    caller: str,
) -> str:
    if audio_bytes:
        msg = MIMEMultipart("mixed")
        msg["Subject"] = subject
        msg["From"] = SENDER_EMAIL
        msg["To"] = RECIPIENT_EMAIL

        alt = MIMEMultipart("alternative")
        alt.attach(MIMEText(body, "plain"))
        alt.attach(MIMEText(html_body, "html"))
        msg.attach(alt)

        safe_name = re.sub(r"[^\w.\-]", "_", audio_name) or f"voicemail-{caller}.mp3"
        subtype = audio_type.split("/")[-1] if "/" in audio_type else "mpeg"
        attachment = MIMEBase("audio", subtype)
        attachment.set_payload(audio_bytes)
        encoders.encode_base64(attachment)
        attachment.add_header("Content-Disposition", "attachment", filename=safe_name)
        attachment.add_header("Content-Type", f"{audio_type}; name=\"{safe_name}\"")
        msg.attach(attachment)

        result = ses.send_raw_email(
            Source=SENDER_EMAIL,
            Destinations=[RECIPIENT_EMAIL],
            RawMessage={"Data": msg.as_bytes()},
        )
        return result["MessageId"]

    result = ses.send_email(
        Source=SENDER_EMAIL,
        Destination={"ToAddresses": [RECIPIENT_EMAIL]},
        Message={
            "Subject": {"Data": subject},
            "Body": {
                "Text": {"Data": body},
                "Html": {"Data": html_body},
            },
        },
    )
    return result["MessageId"]


def build_messages(
    alert_type: str,
    caller: str,
    time_str: str,
    gv_subject: str,
    snippet: str,
    play_url: str,
    transcript: str,
    has_audio: bool,
    audio_source: str,
    recording_url: str = "",
) -> tuple[str, str, str, str]:
    if alert_type == "missed_call":
        sms_body = f"Missed call from {caller} at {time_str}. No voicemail left."
        email_subject = f"Missed call from {caller}"
        email_body = (
            f"Missed call alert\n\n"
            f"Caller: {caller}\n"
            f"Time: {time_str}\n"
            f"No voicemail was left.\n"
        )
        email_html = f"<p><b>Missed call from {caller}</b><br>Time: {time_str}<br>No voicemail left.</p>"
        return sms_body, email_subject, email_body, email_html

    email_subject = f"Voicemail from {caller}"
    listen_url = recording_url or play_url
    listen_link = (
        f'<p style="margin:20px 0;"><a href="{listen_url}" '
        f'style="display:inline-block;padding:14px 24px;background:#1a73e8;'
        f'color:#fff;text-decoration:none;border-radius:6px;font-size:18px;">'
        f"<b>▶ Play voicemail</b></a></p>"
        if listen_url
        else ""
    )
    gv_link = (
        f'<p><a href="{play_url}">Open in YouMail</a></p>'
        if play_url and play_url != listen_url and "youmail.com" in play_url
        else (
            f'<p><a href="{play_url}">Also open in Google Voice</a></p>'
            if play_url and play_url != listen_url
            else ""
        )
    )
    transcript_block = transcript.strip() or snippet.strip()

    if has_audio and audio_source == "recording":
        sms_body = f"Voicemail from {caller} at {time_str}. Recording attached."
        email_body = (
            f"Voicemail alert\n\nCaller: {caller}\nTime: {time_str}\n\n"
            f"Play the original recording:\n{listen_url}\n\n"
            f"The MP3 is also attached to this email.\n"
        )
        email_html = (
            f"<p><b>Voicemail from {caller}</b><br>Time: {time_str}</p>"
            f"{listen_link}"
            f"<p>Original caller audio (MP3 also attached).</p>"
            f"{gv_link}"
        )
    else:
        sms_body = f"Voicemail from {caller} at {time_str}. Listen: check your email."
        email_body = (
            f"Voicemail alert\n\nCaller: {caller}\nTime: {time_str}\n"
        )
        if listen_url:
            email_body += f"\nPlay voicemail: {listen_url}\n"
        if transcript_block:
            email_body += f"\nTranscript:\n{transcript_block}\n"
        transcript_html = f"<pre>{transcript_block}</pre>" if transcript_block else ""
        email_html = (
            f"<p><b>Voicemail from {caller}</b><br>Time: {time_str}</p>"
            f"{listen_link}{transcript_html}"
        )

    return sms_body, email_subject, email_body, email_html


def extension_for(file_name: str) -> str:
    if "." in file_name:
        return "." + file_name.rsplit(".", 1)[-1].lower()
    return ".mp3"


def response(code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def is_opted_out() -> bool:
    if not OPT_OUT_TABLE:
        return False
    item = dynamodb.Table(OPT_OUT_TABLE).get_item(Key={"phone": RECIPIENT_PHONE}).get("Item")
    return bool(item and item.get("optedOut"))


def extract_caller(subject: str, snippet: str) -> str:
    text = f"{subject} {snippet}"
    match = re.search(r"\+?1?\s*\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})", text)
    if match:
        return f"+1{match.group(1)}{match.group(2)}{match.group(3)}"
    return "Unknown"


def format_phone(number: str) -> str:
    digits = re.sub(r"\D", "", number or "")
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    return number or "Unknown"
