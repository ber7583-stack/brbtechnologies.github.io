#!/usr/bin/env python3
"""One-time Google Voice browser login — saves session cookies for AWS Lambda."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import platform
import subprocess
import sys
import time

ORIGIN = "https://voice.google.com"
DEFAULT_DIR = pathlib.Path.home() / ".googlevoice"
DEFAULT_SESSION = DEFAULT_DIR / "session.json"
DEFAULT_PROFILE = DEFAULT_DIR / "chrome-profile"
ESSENTIAL = {"SID", "SAPISID", "__Secure-3PSID"}

WINDOWS_CHROME_PATHS = [
    pathlib.Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
    / "Google/Chrome/Application/chrome.exe",
    pathlib.Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
    / "Google/Chrome/Application/chrome.exe",
    pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
]


def find_chrome() -> str | None:
    if platform.system() == "Windows":
        for path in WINDOWS_CHROME_PATHS:
            if path.exists():
                return str(path)
    return None


def _is_google_cookie(domain: str) -> bool:
    domain = domain.lstrip(".")
    return domain == "google.com" or domain.endswith(".google.com")


def save_session(cookies: list[dict], session_path: pathlib.Path) -> None:
    session_path.parent.mkdir(parents=True, exist_ok=True)
    session_path.write_text(json.dumps({"version": 1, "cookies": cookies}, indent=2))
    try:
        session_path.chmod(0o600)
    except OSError:
        pass
    print(f">>> Saved {len(cookies)} cookies to {session_path}")


async def _login(profile_dir: pathlib.Path, headless: bool, timeout: float) -> list[dict]:
    try:
        import nodriver as uc
    except ImportError:
        print("Install nodriver first: pip install nodriver", file=sys.stderr)
        sys.exit(1)

    profile_dir.mkdir(parents=True, exist_ok=True)
    chrome_path = find_chrome()
    if not chrome_path:
        raise RuntimeError(
            "Google Chrome not found. Install Chrome from https://www.google.com/chrome/ "
            "OR use the easy method: open scripts/save-google-session.html in your browser."
        )

    print(f">>> Using Chrome: {chrome_path}")
    print(">>> Close ALL other Chrome windows first, then wait...")

    start_kwargs: dict = {
        "headless": headless,
        "user_data_dir": str(profile_dir),
        "browser_executable_path": chrome_path,
        "browser_args": ["--no-first-run", "--no-default-browser-check"],
        "start_timeout": 30,
    }

    browser = await uc.start(**start_kwargs)
    try:
        await asyncio.sleep(2)
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


def manual_mode(session_path: pathlib.Path) -> None:
    """Open Chrome for the user; they paste cookies using save-google-session.html."""
    chrome = find_chrome()
    url = ORIGIN
    html = pathlib.Path(__file__).parent / "save-google-session.html"
    print("")
    print("=" * 60)
    print("EASY MODE (no Python browser automation)")
    print("=" * 60)
    print("")
    print("1. Chrome will open to Google Voice — sign in if needed")
    print("2. Install Cookie-Editor extension (link opens next)")
    print(f"3. Open this file in Chrome: {html}")
    print("4. Follow the 3 steps on that page")
    print("5. Paste the result into AWS Secrets Manager → GvSessionSecret")
    print("")
    if chrome:
        subprocess.Popen([chrome, url])
        subprocess.Popen([chrome, "https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm"])
        subprocess.Popen([chrome, html.as_uri()])
    else:
        print(f"Open in Chrome: {url}")
        print(f"Then open: {html}")
    print("")
    print("When done, session.json is NOT needed — paste straight into AWS.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Log in to Google Voice and save session cookies")
    parser.add_argument("--session", default=str(DEFAULT_SESSION))
    parser.add_argument("--profile", default=str(DEFAULT_PROFILE))
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument(
        "--easy",
        action="store_true",
        help="Open Chrome + instructions (no nodriver). Best for Windows.",
    )
    args = parser.parse_args()

    if args.easy:
        manual_mode(pathlib.Path(args.session))
        return

    try:
        import nodriver as uc

        cookies = uc.loop().run_until_complete(
            _login(pathlib.Path(args.profile), args.headless, args.timeout)
        )
        save_session(cookies, pathlib.Path(args.session))
        print(">>> Next: paste session.json into AWS Secrets Manager → GvSessionSecret")
    except Exception as exc:
        print(f"\nAutomatic login failed: {exc}\n")
        print("Trying EASY MODE instead...\n")
        manual_mode(pathlib.Path(args.session))


if __name__ == "__main__":
    main()
