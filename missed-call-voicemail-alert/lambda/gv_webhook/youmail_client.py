"""YouMail voicemail download — no login, no PIN.

Email play links like:
  https://dashboard.youmail.com/messages/view/{shareKey}?ap=y&...

Direct MP3 (same as the download button on that page):
  https://media.youmail.com/mcs/voicemail/sh/message.do?dataonly=true&mk={shareKey}&sh=1&type=2&att=true
"""

from __future__ import annotations

import logging
import re
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

USER_AGENT = "Mozilla/5.0 (compatible; MissedCallAlert/1.0)"
MEDIA_BASE = "https://media.youmail.com/mcs/voicemail/sh/message.do"


class YouMailDownloadError(Exception):
    """Could not download voicemail audio from YouMail."""


def extract_message_token(play_url: str) -> str:
    match = re.search(r"/messages/view/([A-Za-z0-9._-]+)", play_url or "")
    return match.group(1) if match else ""


def phone_digits(number: str) -> str:
    digits = re.sub(r"\D", "", number or "")
    if len(digits) == 11 and digits.startswith("1"):
        return digits[1:]
    return digits


def build_download_url(message_token: str) -> str:
    params = urllib.parse.urlencode(
        {
            "dataonly": "true",
            "mk": message_token,
            "sh": "1",
            "type": "2",
            "att": "true",
        }
    )
    return f"{MEDIA_BASE}?{params}"


def download_audio(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = resp.read()
    except urllib.error.HTTPError as exc:
        raise YouMailDownloadError(f"Download failed ({exc.code})") from exc

    if len(data) < 500:
        raise YouMailDownloadError("Downloaded voicemail was empty")
    return data


def fetch_voicemail_audio(
    _secret_json: str,
    caller: str,
    *,
    around=None,
    play_url: str = "",
) -> tuple[bytes, str] | None:
    """Return (mp3 bytes, filename). No credentials needed."""
    message_token = extract_message_token(play_url)
    if not message_token:
        logger.info("No YouMail message token in play URL")
        return None

    try:
        url = build_download_url(message_token)
        audio = download_audio(url)
        who = phone_digits(caller) or "unknown"
        logger.info("Downloaded %d bytes from YouMail for %s", len(audio), who)
        return audio, f"voicemail-{who}.mp3"
    except YouMailDownloadError as exc:
        logger.warning("YouMail download failed: %s", exc)
        return None
