#!/usr/bin/env python3
"""Post a user-facing release summary to a Discord webhook (#공지)."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DISCORD_DESC_LIMIT = 3800
REPO = os.environ.get("GITHUB_REPOSITORY", "Temmis2077/OSW")
ANNOUNCE_PATH = Path("DISCORD_ANNOUNCEMENTS.md")


def extract_section(tag: str, text: str) -> str | None:
    pattern = rf"## {re.escape(tag)} \([^)]+\)\r?\n(.*?)(?=\r?\n---|\r?\n## v|\Z)"
    match = re.search(pattern, text, re.DOTALL)
    if not match:
        return None
    return match.group(1).strip()


def extract_user_announcement(tag: str) -> str:
    if ANNOUNCE_PATH.is_file():
        body = extract_section(tag, ANNOUNCE_PATH.read_text(encoding="utf-8"))
        if body:
            return body

    return (
        f"**OSW {tag}** 업데이트가 나왔습니다.\n\n"
        f"Windows 설치 파일은 GitHub Releases에서 받을 수 있습니다.\n"
        f"자세한 변경 사항은 저장소의 RELEASE_NOTES.md를 참고해 주세요.\n\n"
        f"궁금한 점은 **#질문-답변**에 남겨 주세요."
    )


def build_payload(tag: str, description: str) -> dict:
    release_url = f"https://github.com/{REPO}/releases/tag/{tag}"
    if len(description) > DISCORD_DESC_LIMIT:
        description = description[: DISCORD_DESC_LIMIT - 1].rstrip() + "\n\n…"

    return {
        "username": "OSW (Open Stem Wave)",
        "allowed_mentions": {"parse": []},
        "embeds": [
            {
                "title": f"업데이트 안내 · {tag}",
                "url": release_url,
                "description": description,
                "color": 0x8B5CF6,
                "fields": [
                    {
                        "name": "다운로드",
                        "value": f"[GitHub Releases]({release_url})",
                        "inline": True,
                    },
                    {
                        "name": "도움말",
                        "value": "[FAQ](https://lmrm.vercel.app/faq)",
                        "inline": True,
                    },
                ],
                "footer": {"text": "Windows · 베타"},
            }
        ],
    }


def post_webhook(url: str, payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "OSW-release-bot",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status >= 400:
            raise RuntimeError(f"Discord webhook HTTP {resp.status}")


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: discord_release_announce.py <tag>", file=sys.stderr)
        return 2

    tag = sys.argv[1].strip()
    if not tag.startswith("v"):
        tag = f"v{tag}"

    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook:
        print("DISCORD_WEBHOOK_URL not set - skipping Discord announce.")
        return 0

    description = extract_user_announcement(tag)
    payload = build_payload(tag, description)

    try:
        post_webhook(webhook, payload)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        print(f"Discord webhook failed: HTTP {err.code}\n{body}", file=sys.stderr)
        return 1
    except OSError as err:
        print(f"Discord webhook failed: {err}", file=sys.stderr)
        return 1

    print(f"Posted {tag} user announce to Discord.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
