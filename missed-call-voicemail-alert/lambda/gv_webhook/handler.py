"""Webhook from Gmail (Google Voice emails) → SMS + email alerts via 10DLC/SES."""

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
ses = boto3.client("ses")
dynamodb = boto3.resource("dynamodb")

RECIPIENT_PHONE = os.environ["RECIPIENT_PHONE"]
RECIPIENT_EMAIL = os.environ["RECIPIENT_EMAIL"]
SENDER_EMAIL = os.environ["SENDER_EMAIL"]
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

    alert_type = body.get("alertType", "voicemail")
    caller = format_phone(body.get("caller", "Unknown"))
    subject = body.get("subject", "")
    snippet = body.get("snippet", "")
    if caller == "Unknown":
        caller = extract_caller(subject, snippet)

    time_str = datetime.now(timezone.utc).astimezone().strftime("%b %d, %I:%M %p")
    sms_body, email_subject, email_body = build_messages(alert_type, caller, time_str, subject)

    try:
        sms_result = sms.send_text_message(
            DestinationPhoneNumber=RECIPIENT_PHONE,
            OriginationIdentity=ORIGINATION_IDENTITY,
            MessageBody=sms_body,
            MessageType="TRANSACTIONAL",
        )
    except sms.exceptions.ConflictException as exc:
        logger.error("SMS send failed: %s", exc)
        return response(
            502,
            {
                "error": "sms_failed",
                "detail": str(exc),
                "hint": "Verify +13477987583 in AWS SMS sandbox or request production access",
            },
        )

    try:
        ses.send_email(
            Source=SENDER_EMAIL,
            Destination={"ToAddresses": [RECIPIENT_EMAIL]},
            Message={
                "Subject": {"Data": email_subject},
                "Body": {"Text": {"Data": email_body}},
            },
        )
    except Exception as exc:
        logger.error("Email send failed: %s", exc)
        return response(
            502,
            {
                "error": "email_failed",
                "detail": str(exc),
                "smsMessageId": sms_result["MessageId"],
            },
        )

    return response(
        200,
        {
            "status": "sent",
            "alertType": alert_type,
            "caller": caller,
            "smsMessageId": sms_result["MessageId"],
        },
    )


def build_messages(
    alert_type: str, caller: str, time_str: str, gv_subject: str
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
    else:
        sms_body = (
            f"Voicemail from {caller} at {time_str}. "
            f"Listen in Gmail ({RECIPIENT_EMAIL})."
        )
        email_subject = f"Voicemail from {caller}"
        email_body = (
            f"Voicemail alert\n\n"
            f"Caller: {caller}\n"
            f"Time: {time_str}\n"
            f"Open Gmail for the Google Voice message with the recording.\n\n"
            f"Google Voice subject: {gv_subject}"
        )
    return sms_body, email_subject, email_body


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
