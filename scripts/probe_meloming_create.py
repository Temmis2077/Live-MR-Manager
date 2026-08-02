#!/usr/bin/env python3
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


def load_token() -> str:
    db = sqlite3.connect(DB)
    row = db.cursor().execute(
        "SELECT value FROM Settings WHERE key='meloming_oauth_access_token'"
    ).fetchone()
    db.close()
    if not row:
        raise SystemExit("No token")
    return row[0]


def post(path: str, body: dict) -> tuple[int, str]:
    req = urllib.request.Request(
        f"https://openapi.meloming.com{path}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {load_token()}",
            "Meloming-Version": "2026-01-11",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")[:600]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:600]


def main() -> None:
    tests = [
        (f"/v1/channels/{CHANNEL_ID}/artists", {"name": "__lmrm_test_artist__"}),
        (
            f"/v1/channels/{CHANNEL_ID}/categories",
            {"name": "__lmrm_test_cat__", "color": "#3B82F6"},
        ),
    ]
    for path, body in tests:
        status, text = post(path, body)
        print(f"{path} -> HTTP {status}")
        print(text)
        print("---")


if __name__ == "__main__":
    main()
