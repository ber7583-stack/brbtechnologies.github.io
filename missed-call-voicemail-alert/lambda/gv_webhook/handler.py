"""Webhook from Gmail (Google Voice voicemail email) → SMS alert via 10DLC."""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sms = boto3.client("pinpoint-sms-voice-v2")
dynamodb = boto3.resource("dynamodb")

RECIPIENT_PHONE = os.environ["RECIPIENT_PHONE"]
ORIGINATION_IDENTITY = os.environ["ORIGINATION_IDENTITY"]
WEBHOOK_SECRET = os.environ["WEBHOOK_SECRET"]
OPT_OUT_TABLE = os.environ.get("OPT_OUT_TABLE", "")


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

    caller = format_phone(body.get("caller", "Unknown"))
    subject = body.get("subject", "")
    snippet = body.get("snippet", "")
    if caller == "Unknown":
        caller = extract_caller(subject, snippet)

    time_str = datetime.now(timezone.utc).astimezone().strftime("%b %d, %I:%M %p")
    message = (
        f"Missed call from {caller} at {time_str}. "
        "Voicemail in your email (ber7583@gmail.com)."
    )

    result = sms.send_text_message(
        DestinationPhoneNumber=RECIPIENT_PHONE,
        OriginationIdentity=ORIGINATION_IDENTITY,
        MessageBody=message,
        MessageType="TRANSACTIONAL",
    )
    return response(200, {"status": "sent", "messageId": result["MessageId"], "caller": caller})


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
