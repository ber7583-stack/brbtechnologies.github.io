"""
Process Amazon Connect voicemail recordings and send MMS/SMS alert via AWS 10DLC.
Triggered by S3 ObjectCreated on the Connect recordings bucket.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote_plus

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
sms = boto3.client("pinpoint-sms-voice-v2")
connect = boto3.client("connect")
dynamodb = boto3.resource("dynamodb")

RECIPIENT_PHONE = os.environ["RECIPIENT_PHONE"]
ORIGINATION_IDENTITY = os.environ["ORIGINATION_IDENTITY"]
MMS_BUCKET = os.environ["MMS_BUCKET"]
CONNECT_INSTANCE_ARN = os.environ["CONNECT_INSTANCE_ARN"]
OPT_OUT_TABLE = os.environ.get("OPT_OUT_TABLE", "")
PRESIGNED_URL_EXPIRY_DAYS = int(os.environ.get("PRESIGNED_URL_EXPIRY_DAYS", "7"))
MMS_MAX_AUDIO_BYTES = int(os.environ.get("MMS_MAX_AUDIO_BYTES", "614400"))
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

CONTACT_ID_PATTERN = re.compile(r"/([0-9a-f-]{36})_")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    results = []
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = unquote_plus(record["s3"]["object"]["key"])
        if not key.lower().endswith(".wav"):
            logger.info("Skipping non-wav object: %s", key)
            continue
        try:
            results.append(process_voicemail(bucket, key))
        except Exception:
            logger.exception("Failed to process %s/%s", bucket, key)
            raise
    return {"processed": len(results), "results": results}


def process_voicemail(source_bucket: str, source_key: str) -> dict[str, Any]:
    if is_opted_out():
        logger.info("Recipient opted out; skipping notification")
        return {"status": "skipped", "reason": "opted_out"}

    contact_id = extract_contact_id(source_key)
    caller, call_time = get_call_metadata(contact_id)

    mp3_key = build_mms_key(contact_id)
    mp3_path = transcode_to_mp3(source_bucket, source_key)

    try:
        mp3_size = Path(mp3_path).stat().st_size
        s3.upload_file(
            mp3_path,
            MMS_BUCKET,
            mp3_key,
            ExtraArgs={"ContentType": "audio/mpeg"},
        )
    finally:
        Path(mp3_path).unlink(missing_ok=True)

    body = format_message_body(caller, call_time)
    media_uri = f"s3://{MMS_BUCKET}/{mp3_key}"

    if mp3_size <= MMS_MAX_AUDIO_BYTES:
        message_id, delivery = send_mms(body, media_uri, mp3_key)
    else:
        presigned_url = presigned_playback_url(mp3_key)
        body = f"{body}\nVoicemail: {presigned_url}"
        message_id = send_sms(body)
        delivery = "sms_link"

    return {
        "status": "sent",
        "delivery": delivery,
        "messageId": message_id,
        "caller": caller,
        "contactId": contact_id,
    }


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
        if initiation:
            call_time = initiation if isinstance(initiation, datetime) else initiation
            if not isinstance(call_time, datetime):
                call_time = datetime.fromisoformat(str(call_time).replace("Z", "+00:00"))
        else:
            call_time = datetime.now(timezone.utc)
        return format_phone(caller), call_time.astimezone(timezone.utc)
    except ClientError:
        logger.warning("Could not describe contact %s; using defaults", contact_id)
        return "Unknown", datetime.now(timezone.utc)


def format_phone(number: str) -> str:
    digits = re.sub(r"\D", "", number or "")
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    return number or "Unknown"


def format_message_body(caller: str, call_time: datetime) -> str:
    local = call_time.astimezone()
    time_str = local.strftime("%b %d, %Y %I:%M %p %Z").strip()
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
                [
                    ffmpeg,
                    "-y",
                    "-i",
                    str(wav_path),
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-b:a",
                    "32k",
                    str(mp3_path),
                ],
                check=True,
                capture_output=True,
            )
            return persist_temp_mp3(mp3_path)
        logger.warning("ffmpeg not found; using raw wav (may exceed MMS limit)")
        return persist_temp_mp3(wav_path)


def shutil_which(cmd: str) -> str | None:
    for path in os.environ.get("PATH", "").split(os.pathsep) + ["/opt/bin", "/usr/bin"]:
        candidate = Path(path) / cmd
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def persist_temp_mp3(path: Path) -> str:
    dest = tempfile.NamedTemporaryFile(suffix=path.suffix or ".mp3", delete=False)
    dest.close()
    Path(dest.name).write_bytes(path.read_bytes())
    return dest.name


def presigned_playback_url(mp3_key: str) -> str:
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": MMS_BUCKET, "Key": mp3_key},
        ExpiresIn=PRESIGNED_URL_EXPIRY_DAYS * 86400,
    )


def send_mms(body: str, media_uri: str, mp3_key: str) -> tuple[str, str]:
    try:
        response = sms.send_media_message(
            DestinationPhoneNumber=RECIPIENT_PHONE,
            OriginationIdentity=ORIGINATION_IDENTITY,
            MessageBody=body,
            MediaUrls=[media_uri],
            MessageType="TRANSACTIONAL",
        )
        return response["MessageId"], "mms"
    except ClientError as exc:
        logger.warning("MMS failed (%s); falling back to SMS link", exc)
        presigned_url = presigned_playback_url(mp3_key)
        message_id = send_sms(f"{body}\nVoicemail: {presigned_url}")
        return message_id, "sms_link"


def send_sms(body: str) -> str:
    response = sms.send_text_message(
        DestinationPhoneNumber=RECIPIENT_PHONE,
        OriginationIdentity=ORIGINATION_IDENTITY,
        MessageBody=body,
        MessageType="TRANSACTIONAL",
    )
    return response["MessageId"]
