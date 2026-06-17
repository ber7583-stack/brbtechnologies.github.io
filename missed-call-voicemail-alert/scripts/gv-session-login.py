#!/usr/bin/env python3
"""One-time Google Voice browser login — saves session cookies for AWS Lambda.

Requires: pip install nodriver

Usage:
  python3 scripts/gv-session-login.py
  python3 scripts/upload-gv-session.sh   # uploads ~/.googlevoice/session.json to AWS
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys
import time

ORIGIN = "https://voice.google.com"
DEFAULT_DIR = pathlib.Path.home() / ".googlevoice"
DEFAULT_SESSION = DEFAULT_DIR / "session.json"
DEFAULT_PROFILE = DEFAULT_DIR / "chrome-profile"
ESSENTIAL = {"SID", "SAPISID", "__Secure-3PSID"}


def _is_google_cookie(domain: str) -> bool:
    domain = domain.lstrip(".")
    return domain == "google.com" or domain.endswith(".google.com")


async def _login(profile_dir: pathlib.Path, headless: bool, timeout: float) -> list[dict]:
    try:
        import nodriver as uc
    except ImportError:
        print("Install nodriver first: pip install nodriver", file=sys.stderr)
        sys.exit(1)

    profile_dir.mkdir(parents=True, exist_ok=True)
    browser = await uc.start(
        headless=headless,
        user_data_dir=str(profile_dir),
        browser_args=["--no-first-run", "--no-default-browser-check"],
    )
    try:
        await browser.get(ORIGIN)
        print(">>> Sign in to the Google account that owns your Google Voice number.")
        print(">>> Waiting for login on voice.google.com ...")

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            cookies = [
                {
                    "name": c.name,
                    "value": c.value,
                    "domain": c.domain,
                    "path": c.path or "/",
                }
                for c in await browser.cookies.get_all()
                if _is_google_cookie(c.domain)
            ]
            names = {c["name"] for c in cookies}
            if ESSENTIAL <= names:
                print(">>> Login detected.")
                return cookies
            await asyncio.sleep(3)
        raise RuntimeError(f"Timed out after {timeout:.0f}s waiting for login")
    finally:
        browser.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Log in to Google Voice and save session cookies")
    parser.add_argument("--session", default=str(DEFAULT_SESSION))
    parser.add_argument("--profile", default=str(DEFAULT_PROFILE))
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--timeout", type=float, default=300)
    args = parser.parse_args()

    import nodriver as uc

    cookies = uc.loop().run_until_complete(
        _login(pathlib.Path(args.profile), args.headless, args.timeout)
    )
    session_path = pathlib.Path(args.session)
    session_path.parent.mkdir(parents=True, exist_ok=True)
    session_path.write_text(json.dumps({"version": 1, "cookies": cookies}, indent=2))
    session_path.chmod(0o600)
    print(f">>> Saved {len(cookies)} cookies to {session_path}")
    print(">>> Next: bash scripts/upload-gv-session.sh")


if __name__ == "__main__":
    main()
