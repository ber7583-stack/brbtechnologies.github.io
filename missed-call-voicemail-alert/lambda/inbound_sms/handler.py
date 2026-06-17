"""
Handle inbound SMS keywords (STOP / HELP / START) for 10DLC compliance.
Wire this Lambda to the SNS topic that receives inbound messages on +19452025796.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sms = boto3.client("pinpoint-sms-voice-v2")
dynamodb = boto3.resource("dynamodb")

OWNER_PHONE = os.environ["OWNER_PHONE"]
ORIGINATION_IDENTITY = os.environ["ORIGINATION_IDENTITY"]
OPT_OUT_TABLE = os.environ["OPT_OUT_TABLE"]
HELP_MESSAGE = os.environ.get(
    "HELP_MESSAGE",
    "Missed-call alerts: transactional voicemail notifications. Reply STOP to opt out.",
)
STOP_MESSAGE = os.environ.get(
    "STOP_MESSAGE",
    "You are unsubscribed from missed-call alerts. Reply START to re-enable.",
)
START_MESSAGE = os.environ.get(
    "START_MESSAGE",
    "Missed-call alerts re-enabled.",
)

STOP_KEYWORDS = {"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"}
HELP_KEYWORDS = {"HELP", "INFO"}
START_KEYWORDS = {"START", "UNSTOP"}


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    table = dynamodb.Table(OPT_OUT_TABLE)
    handled = []

    for record in event.get("Records", []):
        message = json.loads(record["Sns"]["Message"])
        origination = message.get("originationNumber", "")
        destination = message.get("destinationNumber", ORIGINATION_IDENTITY)
        body = (message.get("messageBody") or "").strip()
        keyword = normalize_keyword(body)

        if origination != OWNER_PHONE:
            logger.info("Ignoring inbound SMS from non-owner %s", origination)
            continue

        if keyword in STOP_KEYWORDS:
            table.put_item(Item={"phone": OWNER_PHONE, "optedOut": True})
            reply = STOP_MESSAGE
        elif keyword in START_KEYWORDS:
            table.put_item(Item={"phone": OWNER_PHONE, "optedOut": False})
            reply = START_MESSAGE
        elif keyword in HELP_KEYWORDS:
            reply = HELP_MESSAGE
        else:
            logger.info("No keyword match for body: %s", body)
            continue

        sms.send_text_message(
            DestinationPhoneNumber=OWNER_PHONE,
            OriginationIdentity=destination,
            MessageBody=reply,
            MessageType="TRANSACTIONAL",
        )
        handled.append(keyword)

    return {"handled": handled}
