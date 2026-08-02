#!/usr/bin/env python3
"""Quick Meloming write API smoke test using the desktop app's stored OAuth token."""
import json
import os
import sqlite3
import urllib.error
import urllib.request

def resolve_db() -> str:
    roots = ("com.osw.desktop", "com.autumncolor77.live-mr-manager")
    candidates = [
        os.path.expandvars(rf"%LOCALAPPDATA%\{root}\library.db") for root in roots
    ]
    return next((path for path in candidates if os.path.isfile(path)), candidates[0])


DB = resolve_db()
CHANNEL_ID = 2681
EXISTING_SONG_ID = 273443
CRAYON_NUT_ARTIST_ID = 168415


def load_token() -> str:
    db = sqlite3.connect(DB)
    cur = db.cursor()
    cur.execute(
        "SELECT value FROM Settings WHERE key='meloming_oauth_access_token'"
    )
    row = cur.fetchone()
    db.close()
    if not row or not row[0].strip():
        raise SystemExit("OAuth token not found — log in via the app first.")
    return row[0].strip()


def api(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, str]:
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Meloming-Version", "2026-01-11")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")[:800]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:800]


def main() -> None:
    token = load_token()
    base = f"https://openapi.meloming.com/v1/channels/{CHANNEL_ID}/songs"

    print("=== PATCH existing song ===")
    status, body = api(
        "PATCH",
        f"{base}/{EXISTING_SONG_ID}",
        token,
        {"title": "거꾸로 강을 거슬러 오르는 저 힘찬 연어들처럼"},
    )
    print(f"HTTP {status}")
    print(body[:400])
    print()

    print("=== POST new song (크라잉넛) ===")
    status, body = api(
        "POST",
        base,
        token,
        {
            "title": "OSW API test (delete me)",
            "artistId": CRAYON_NUT_ARTIST_ID,
        },
    )
    print(f"HTTP {status}")
    print(body[:400])


if __name__ == "__main__":
    main()
