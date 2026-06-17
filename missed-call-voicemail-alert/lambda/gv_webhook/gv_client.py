"""Minimal Google Voice voiceclient API client for downloading voicemail recordings.

Uses the same internal API as voice.google.com (clients6.google.com/voice/v1/voiceclient).
Authentication is cookie-based SAPISIDHASH, not OAuth.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

ORIGIN = "https://voice.google.com"
API_KEY = "AIzaSyDTYc1N4xiODyrQYK0Kl6g_y279LjYkrBg"
API_BASE = "https://clients6.google.com/voice/v1/voiceclient/"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
_HASH_COOKIES = (
    ("SAPISIDHASH", "SAPISID"),
    ("SAPISID1PHASH", "__Secure-1PAPISID"),
    ("SAPISID3PHASH", "__Secure-3PAPISID"),
)
FOLDER_VOICEMAIL = 4


class GvSessionError(Exception):
    """Google Voice session is missing, invalid, or expired."""


def load_session(secret_json: str) -> list[dict[str, Any]]:
    data = json.loads(secret_json or "{}")
    cookies = data.get("cookies") if isinstance(data, dict) else None
    if not cookies:
        raise GvSessionError("Google Voice session not configured")
    return cookies


def phone_digits(number: str) -> str:
    digits = re.sub(r"\D", "", number or "")
    if len(digits) == 11 and digits.startswith("1"):
        return digits[1:]
    return digits


def sapisid_hash(cookies: list[dict[str, Any]], *, now: float | None = None) -> str:
    ts = int(time.time() if now is None else now)
    by_name = {c["name"]: c["value"] for c in cookies}
    parts: list[str] = []
    for label, name in _HASH_COOKIES:
        secret = by_name.get(name)
        if secret:
            digest = hashlib.sha1(f"{ts} {secret} {ORIGIN}".encode()).hexdigest()
            parts.append(f"{label} {ts}_{digest}")
    if not parts:
        raise GvSessionError("Google Voice session cookies are invalid or expired")
    return " ".join(parts)


def _cookie_header(cookies: list[dict[str, Any]]) -> str:
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


def auth_headers(cookies: list[dict[str, Any]]) -> dict[str, str]:
    return {
        "Authorization": sapisid_hash(cookies),
        "Content-Type": "application/json+protobuf",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-AuthUser": "0",
        "X-Origin": ORIGIN,
        "X-Referer": ORIGIN,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": USER_AGENT,
        "Cookie": _cookie_header(cookies),
    }


def _post(cookies: list[dict[str, Any]], endpoint: str, body: Any) -> dict[str, Any]:
    url = f"{API_BASE}{endpoint}?alt=json&key={API_KEY}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers=auth_headers(cookies),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise GvSessionError("Google Voice session expired — re-run gv-session-login") from exc
        raise GvSessionError(f"Google Voice API error {exc.code}: {exc.read()[:200]!r}") from exc


def list_voicemail_messages(cookies: list[dict[str, Any]], count: int = 20) -> list[dict[str, Any]]:
    body = [FOLDER_VOICEMAIL, count, 15, None, None, [None, 1, 1, 1]]
    data = _post(cookies, "api2thread/list", body)
    messages: list[dict[str, Any]] = []
    for thread in data.get("thread", []):
        for item in thread.get("item", []):
            if "voicemail" in (item.get("type") or "").lower():
                contact = item.get("contact") or {}
                item["_contact_phone"] = contact.get("phoneNumber")
                messages.append(item)
    return messages


def _ms_to_datetime(ms: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def find_voicemail(
    messages: list[dict[str, Any]],
    caller: str,
    *,
    around: datetime | None = None,
    window_seconds: int = 600,
) -> dict[str, Any] | None:
    target = phone_digits(caller)
    if not target:
        return None

    best: dict[str, Any] | None = None
    best_delta = float("inf")

    for msg in messages:
        msg_phone = phone_digits(msg.get("_contact_phone") or "")
        if not msg_phone or msg_phone != target:
            continue
        if not msg.get("recordingUrl"):
            continue

        start = _ms_to_datetime(msg.get("startTime"))
        if around and start:
            delta = abs((start - around).total_seconds())
            if delta > window_seconds:
                continue
            if delta < best_delta:
                best = msg
                best_delta = delta
        elif best is None:
            best = msg

    return best


def download_recording(cookies: list[dict[str, Any]], url: str) -> bytes:
    req = urllib.request.Request(url, headers=auth_headers(cookies), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
    except urllib.error.HTTPError as exc:
        raise GvSessionError(f"Recording download failed ({exc.code})") from exc

    if len(data) < 500:
        raise GvSessionError("Downloaded recording was empty")
    return data


def fetch_voicemail_audio(
    session_json: str,
    caller: str,
    *,
    around: datetime | None = None,
) -> tuple[bytes, str] | None:
    """Return (mp3 bytes, filename) for the matching voicemail, or None."""
    try:
        cookies = load_session(session_json)
        messages = list_voicemail_messages(cookies)
        match = find_voicemail(messages, caller, around=around)
        if not match:
            logger.info("No matching voicemail found for caller %s", caller)
            return None

        url = match["recordingUrl"]
        audio = download_recording(cookies, url)
        caller_safe = phone_digits(caller) or "unknown"
        return audio, f"voicemail-{caller_safe}.mp3"
    except GvSessionError as exc:
        logger.warning("Google Voice audio fetch failed: %s", exc)
        return None
