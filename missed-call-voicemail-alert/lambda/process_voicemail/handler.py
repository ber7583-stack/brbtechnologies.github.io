"""Process Connect voicemail → email (always) + MMS/SMS (phone)."""

from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any
from urllib.parse import unquote_plus

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
sms = boto3.client("pinpoint-sms-voice-v2")
ses = boto3.client("ses")
connect = boto3.client("connect")
dynamodb = boto3.resource("dynamodb")

RECIPIENT_PHONE = os.environ["RECIPIENT_PHONE"]
RECIPIENT_EMAIL = os.environ["RECIPIENT_EMAIL"]
SENDER_EMAIL = os.environ["SENDER_EMAIL"]
ORIGINATION_IDENTITY = os.environ["ORIGINATION_IDENTITY"]
MMS_BUCKET = os.environ["MMS_BUCKET"]
CONNECT_INSTANCE_ARN = os.environ["CONNECT_INSTANCE_ARN"]
OPT_OUT_TABLE = os.environ.get("OPT_OUT_TABLE", "")
MMS_MAX_AUDIO_BYTES = int(os.environ.get("MMS_MAX_AUDIO_BYTES", "614400"))

CONTACT_ID_PATTERN = re.compile(r"/([0-9a-f-]{36})_")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    results = []
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = unquote_plus(record["s3"]["object"]["key"])
        if not key.lower().endswith(".wav"):
            continue
        results.append(process_voicemail(bucket, key))
    return {"processed": len(results), "results": results}


def process_voicemail(source_bucket: str, source_key: str) -> dict[str, Any]:
    if is_opted_out():
        return {"status": "skipped", "reason": "opted_out"}

    contact_id = extract_contact_id(source_key)
    caller, call_time = get_call_metadata(contact_id)
    body = format_message_body(caller, call_time)

    mp3_key = build_mms_key(contact_id)
    mp3_path = transcode_to_mp3(source_bucket, source_key)
    try:
        mp3_size = Path(mp3_path).stat().st_size
        mp3_bytes = Path(mp3_path).read_bytes()
        s3.upload_file(
            mp3_path,
            MMS_BUCKET,
            mp3_key,
            ExtraArgs={"ContentType": "audio/mpeg"},
        )
    finally:
        Path(mp3_path).unlink(missing_ok=True)

    email_id = send_email(body, caller, call_time, mp3_bytes, contact_id)

    if mp3_size <= MMS_MAX_AUDIO_BYTES:
        phone_delivery = send_mms(body, f"s3://{MMS_BUCKET}/{mp3_key}")
    else:
        phone_delivery = send_sms(f"{body} Audio too large for text — check your email.")

    return {
        "status": "sent",
        "emailId": email_id,
        "phoneDelivery": phone_delivery,
        "caller": caller,
        "contactId": contact_id,
    }


def send_email(
    body: str, caller: str, call_time: datetime, mp3_bytes: bytes, contact_id: str
) -> str:
    subject = f"Missed call from {caller} — {call_time.astimezone().strftime('%b %d %I:%M %p')}"
    msg = MIMEMultipart()
    msg["Subject"] = subject
    msg["From"] = SENDER_EMAIL
    msg["To"] = RECIPIENT_EMAIL
    msg.attach(MIMEText(body, "plain"))

    attachment = MIMEApplication(mp3_bytes, _subtype="mpeg")
    attachment.add_header(
        "Content-Disposition", "attachment", filename=f"voicemail-{contact_id[:8]}.mp3"
    )
    msg.attach(attachment)

    response = ses.send_raw_email(
        Source=SENDER_EMAIL,
        Destinations=[RECIPIENT_EMAIL],
        RawMessage={"Data": msg.as_string()},
    )
    return response["MessageId"]


def is_opted_out() -> bool:
    if not OPT_OUT_TABLE:
        return False
    table = dynamodb.Table(OPT_OUT_TABLE)
    item = table.get_item(Key={"phone": RECIPIENT_PHONE}).get("Item")
    return bool(item and item.get("optedOut"))


def extract_contact_id(key: str) -> str:
    match = CONTACT_ID_PATTERN.search(key)
    if not match:
        raise ValueError(f"Could not extract contact ID from key: {key}")
    return match.group(1)


def get_call_metadata(contact_id: str) -> tuple[str, datetime]:
    try:
        response = connect.describe_contact(
            InstanceId=CONNECT_INSTANCE_ARN.split("/")[-1],
            ContactId=contact_id,
        )
        contact = response.get("Contact", {})
        caller = contact.get("CustomerEndpoint", {}).get("Address", "Unknown")
        initiation = contact.get("InitiationTimestamp")
        if initiation and not isinstance(initiation, datetime):
            call_time = datetime.fromisoformat(str(initiation).replace("Z", "+00:00"))
        elif isinstance(initiation, datetime):
            call_time = initiation
        else:
            call_time = datetime.now(timezone.utc)
        return format_phone(caller), call_time.astimezone(timezone.utc)
    except ClientError:
        return "Unknown", datetime.now(timezone.utc)


def format_phone(number: str) -> str:
    digits = re.sub(r"\D", "", number or "")
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    return number or "Unknown"


def format_message_body(caller: str, call_time: datetime) -> str:
    time_str = call_time.astimezone().strftime("%b %d, %Y %I:%M %p %Z").strip()
    return f"Missed call from {caller} at {time_str}. Voicemail attached."


def build_mms_key(contact_id: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    return f"mms/{stamp}/{contact_id}.mp3"


def transcode_to_mp3(source_bucket: str, source_key: str) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "input.wav"
        mp3_path = Path(tmp) / "output.mp3"
        s3.download_file(source_bucket, source_key, str(wav_path))
        ffmpeg = shutil_which("ffmpeg")
        if ffmpeg:
            subprocess.run(
                [ffmpeg, "-y", "-i", str(wav_path), "-ac", "1", "-ar", "16000", "-b:a", "32k", str(mp3_path)],
                check=True,
                capture_output=True,
            )
            return persist_temp(mp3_path)
        return persist_temp(wav_path)


def shutil_which(cmd: str) -> str | None:
    for path in os.environ.get("PATH", "").split(os.pathsep) + ["/opt/bin", "/usr/bin"]:
        candidate = Path(path) / cmd
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def persist_temp(path: Path) -> str:
    dest = tempfile.NamedTemporaryFile(suffix=path.suffix or ".mp3", delete=False)
    dest.close()
    Path(dest.name).write_bytes(path.read_bytes())
    return dest.name


def send_mms(body: str, media_uri: str) -> str:
    try:
        response = sms.send_media_message(
            DestinationPhoneNumber=RECIPIENT_PHONE,
            OriginationIdentity=ORIGINATION_IDENTITY,
            MessageBody=body,
            MediaUrls=[media_uri],
            MessageType="TRANSACTIONAL",
        )
        return f"mms:{response['MessageId']}"
    except ClientError as exc:
        logger.warning("MMS failed (%s); sending text-only SMS", exc)
        return f"sms:{send_sms(body + ' Full audio is in your email.')}"


def send_sms(body: str) -> str:
    response = sms.send_text_message(
        DestinationPhoneNumber=RECIPIENT_PHONE,
        OriginationIdentity=ORIGINATION_IDENTITY,
        MessageBody=body,
        MessageType="TRANSACTIONAL",
    )
    return response["MessageId"]
