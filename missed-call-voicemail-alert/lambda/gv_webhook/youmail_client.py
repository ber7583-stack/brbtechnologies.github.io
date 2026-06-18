"""YouMail voicemail download via legacy v4 API (phone + PIN).

Also supports dashboard session cookies as a fallback.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

API_BASE = "https://api.youmail.com/api/v4/"
USER_AGENT = "Mozilla/5.0 (compatible; MissedCallAlert/1.0)"


class YouMailSessionError(Exception):
    """YouMail credentials missing, invalid, or expired."""


def load_credentials(secret_json: str) -> dict[str, str]:
    data = json.loads(secret_json or "{}")
    phone = data.get("phone") or data.get("user") or ""
    pin = str(data.get("pin") or data.get("password") or "")
    if phone and pin:
        return {"phone": phone, "pin": pin}
    cookies = data.get("cookies")
    if cookies:
        return {"cookies": cookies}
    raise YouMailSessionError("YouMail credentials not configured")


def _request(url: str, headers: dict[str, str] | None = None) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, **(headers or {})},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        raise YouMailSessionError(f"YouMail request failed ({exc.code})") from exc


def authenticate(phone: str, pin: str) -> str:
    user = urllib.parse.quote(re.sub(r"\D", "", phone), safe="")
    url = f"{API_BASE}authenticate/{user}/{pin}"
    content = _request(url)
    token = ET.fromstring(content).text
    if not token:
        raise YouMailSessionError("YouMail authentication returned empty token")
    return token


def list_voicemail_entries(auth_token: str, page_length: int = 50) -> list[dict[str, Any]]:
    fields = (
        "id,created,source,status,length,folderId,callerName,"
        "messageDataUrl,messageDataFormat"
    )
    params = urllib.parse.urlencode(
        {
            "auth": auth_token,
            "folderId": -1,
            "deleteType": 0,
            "dataFormat": "MP3",
            "securedDataUrl": "true",
            "pageLength": page_length,
            "fields": fields,
        }
    )
    url = f"{API_BASE}messagebox/entry/query?{params}"
    content = _request(url)
    tree = ET.fromstring(content)
    entries: list[dict[str, Any]] = []
    for entry in tree.iter("entry"):
        item = {child.tag: (child.text or "") for child in entry}
        if item.get("messageDataUrl"):
            entries.append(item)
    return entries


def phone_digits(number: str) -> str:
    digits = re.sub(r"\D", "", number or "")
    if len(digits) == 11 and digits.startswith("1"):
        return digits[1:]
    return digits


def parse_created_ms(value: str) -> datetime | None:
    try:
        # YouMail v4 created is epoch milliseconds
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def extract_message_token(play_url: str) -> str:
    match = re.search(r"/messages/view/([A-Za-z0-9._-]+)", play_url or "")
    return match.group(1) if match else ""


def find_entry(
    entries: list[dict[str, Any]],
    caller: str,
    *,
    around: datetime | None = None,
    message_token: str = "",
    window_seconds: int = 3600,
) -> dict[str, Any] | None:
    target = phone_digits(caller)

    if message_token:
        for entry in entries:
            data_url = entry.get("messageDataUrl") or ""
            entry_id = entry.get("id") or ""
            if message_token in data_url or message_token == entry_id:
                return entry

    best: dict[str, Any] | None = None
    best_delta = float("inf")
    latest_from_caller: dict[str, Any] | None = None
    latest_created = 0

    for entry in entries:
        source = phone_digits(entry.get("source") or "")
        if target and source != target:
            continue
        created_ms = int(entry.get("created") or "0")
        if created_ms > latest_created:
            latest_from_caller = entry
            latest_created = created_ms
        if around:
            created = parse_created_ms(entry.get("created") or "")
            if not created:
                continue
            delta = abs((created - around).total_seconds())
            if delta > window_seconds:
                continue
            if delta < best_delta:
                best = entry
                best_delta = delta
        elif best is None:
            best = entry

    return best or latest_from_caller


def download_audio(url: str) -> bytes:
    data = _request(url)
    if len(data) < 500:
        raise YouMailSessionError("Downloaded voicemail was empty")
    return data


def fetch_voicemail_audio(
    secret_json: str,
    caller: str,
    *,
    around: datetime | None = None,
    play_url: str = "",
) -> tuple[bytes, str] | None:
    """Return (mp3 bytes, filename) for matching YouMail voicemail."""
    try:
        creds = load_credentials(secret_json)
    except YouMailSessionError as exc:
        logger.warning("YouMail credentials: %s", exc)
        return None

    message_token = extract_message_token(play_url)

    try:
        if "phone" in creds:
            token = authenticate(creds["phone"], creds["pin"])
            entries = list_voicemail_entries(token)
        else:
            logger.warning("YouMail cookie download not implemented yet")
            return None

        match = find_entry(
            entries, caller, around=around, message_token=message_token
        )
        if not match:
            logger.info("No YouMail voicemail match for caller %s", caller)
            return None

        audio = download_audio(match["messageDataUrl"])
        who = phone_digits(caller) or phone_digits(match.get("source") or "") or "unknown"
        return audio, f"voicemail-{who}.mp3"
    except YouMailSessionError as exc:
        logger.warning("YouMail audio fetch failed: %s", exc)
        return None
