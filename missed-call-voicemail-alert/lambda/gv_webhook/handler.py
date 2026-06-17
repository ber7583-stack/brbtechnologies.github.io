"""Webhook from Gmail (Google Voice emails) → SMS/MMS + email with audio attachment."""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sms = boto3.client("pinpoint-sms-voice-v2")
ses = boto3.client("ses")
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

RECIPIENT_PHONE = os.environ["RECIPIENT_PHONE"]
RECIPIENT_EMAIL = os.environ["RECIPIENT_EMAIL"]
SENDER_EMAIL = os.environ["SENDER_EMAIL"]
ORIGINATION_IDENTITY = os.environ["ORIGINATION_IDENTITY"]
WEBHOOK_SECRET = os.environ["WEBHOOK_SECRET"]
OPT_OUT_TABLE = os.environ.get("OPT_OUT_TABLE", "")
MMS_BUCKET = os.environ.get("MMS_BUCKET", "")
MMS_MAX_AUDIO_BYTES = int(os.environ.get("MMS_MAX_AUDIO_BYTES", "614400"))


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
    if caller == "Unknown":
        caller = extract_caller(subject, snippet)

    audio_bytes, audio_name, audio_type = decode_audio(body)
    time_str = datetime.now(timezone.utc).astimezone().strftime("%b %d, %I:%M %p")
    sms_body, email_subject, email_body = build_messages(
        alert_type, caller, time_str, subject, has_audio=bool(audio_bytes)
    )

    phone_delivery = send_phone_alert(sms_body, audio_bytes, audio_name, audio_type, alert_type)

    try:
        email_id = send_email(email_subject, email_body, audio_bytes, audio_name, audio_type, caller)
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

    return response(
        200,
        {
            "status": "sent",
            "alertType": alert_type,
            "caller": caller,
            "phoneDelivery": phone_delivery,
            "emailId": email_id,
            "hasAudio": bool(audio_bytes),
        },
    )


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
            key = f"mms/{datetime.now(timezone.utc).strftime('%Y/%m/%d')}/{uuid.uuid4().hex}{extension_for(audio_name)}"
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
                MessageType="TRANSACTIONAL",
            )
            return f"mms:{result['MessageId']}"
        except ClientError as exc:
            logger.warning("MMS failed (%s); falling back to SMS", exc)

    try:
        result = sms.send_text_message(
            DestinationPhoneNumber=RECIPIENT_PHONE,
            OriginationIdentity=ORIGINATION_IDENTITY,
            MessageBody=sms_body,
            MessageType="TRANSACTIONAL",
        )
        return f"sms:{result['MessageId']}"
    except sms.exceptions.ConflictException as exc:
        logger.error("SMS send failed: %s", exc)
        raise


def send_email(
    subject: str,
    body: str,
    audio_bytes: bytes | None,
    audio_name: str,
    audio_type: str,
    caller: str,
) -> str:
    if audio_bytes:
        msg = MIMEMultipart()
        msg["Subject"] = subject
        msg["From"] = SENDER_EMAIL
        msg["To"] = RECIPIENT_EMAIL
        msg.attach(MIMEText(body, "plain"))

        subtype = audio_type.split("/")[-1] if "/" in audio_type else "mpeg"
        attachment = MIMEApplication(audio_bytes, _subtype=subtype)
        safe_name = re.sub(r"[^\w.\-]", "_", audio_name) or f"voicemail-{caller}.mp3"
        attachment.add_header("Content-Disposition", "attachment", filename=safe_name)
        msg.attach(attachment)

        result = ses.send_raw_email(
            Source=SENDER_EMAIL,
            Destinations=[RECIPIENT_EMAIL],
            RawMessage={"Data": msg.as_string()},
        )
        return result["MessageId"]

    result = ses.send_email(
        Source=SENDER_EMAIL,
        Destination={"ToAddresses": [RECIPIENT_EMAIL]},
        Message={
            "Subject": {"Data": subject},
            "Body": {"Text": {"Data": body}},
        },
    )
    return result["MessageId"]


def build_messages(
    alert_type: str, caller: str, time_str: str, gv_subject: str, has_audio: bool
) -> tuple[str, str, str]:
    if alert_type == "missed_call":
        sms_body = f"Missed call from {caller} at {time_str}. No voicemail left."
        email_subject = f"Missed call from {caller}"
        email_body = (
            f"Missed call alert\n\n"
            f"Caller: {caller}\n"
            f"Time: {time_str}\n"
            f"No voicemail was left.\n\n"
            f"Google Voice subject: {gv_subject}"
        )
    elif has_audio:
        sms_body = f"Voicemail from {caller} at {time_str}. Audio attached."
        email_subject = f"Voicemail from {caller}"
        email_body = (
            f"Voicemail alert\n\n"
            f"Caller: {caller}\n"
            f"Time: {time_str}\n"
            f"The recording is attached to this email."
        )
    else:
        sms_body = f"Voicemail from {caller} at {time_str}. Check Gmail for audio."
        email_subject = f"Voicemail from {caller}"
        email_body = (
            f"Voicemail alert\n\n"
            f"Caller: {caller}\n"
            f"Time: {time_str}\n"
            f"Audio was not found in the Google Voice email."
        )
    return sms_body, email_subject, email_body


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
