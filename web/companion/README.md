# OSW — Vercel Companion

멜로밍 노래책 연동용 **사용자-facing** companion 웹 (Next.js). 앱 안내·도움말·OAuth 콜백·(테스트) 웹 로그인.

개발자용(미니앱 등록·Redirect URI 등)은 [`docs/MELOMING_SONGBOOK_INTEGRATION.md`](../../docs/MELOMING_SONGBOOK_INTEGRATION.md)에만 둡니다.

## 페이지

| 경로 | 용도 |
|------|------|
| `/` | 연동 안내, 미니앱 등록용 랜딩 |
| `/faq`, `/qa` | FAQ·문의 허브 (Discord, GitHub Issues) |
| `/privacy` | 개인정보 처리방침 (앱·웹 통합) |
| `/terms` | 이용약관 |
| `/download` | GitHub Releases 링크 |
| `/login` | (테스트) 웹 멜로밍 OAuth 시작 |
| `/account` | (테스트) 웹 로그인 세션 확인 |
| `/oauth/callback` | 멜로밍 Redirect URI — 웹 PKCE 완료 또는 앱 `osw://` 브릿지 |

## API

| 경로 | 용도 |
|------|------|
| `GET /api/oauth/login` | PKCE 생성 → 멜로밍 authorize 리다이렉트 |
| `POST /api/oauth/complete` | 웹 code 교환 → httpOnly 세션 |
| `POST /api/oauth/exchange` | **Tauri 앱** 토큰 교환 프록시 |
| `GET /api/oauth/pkce-check` | 콜백 분기(웹 vs 앱) |
| `GET /api/auth/session` | 웹 로그인 상태 |
| `POST /api/auth/logout` | 웹 세션 삭제 |

## 로컬 실행

```bash
cd web/companion
npm install
npm run dev
```

http://localhost:3000

## 환경 변수

`.env.local` (Git 커밋 금지):

```env
MELOMING_CLIENT_ID=
MELOMING_CLIENT_SECRET=
# 선택: Redirect URI 고정 (미설정 시 Origin + /oauth/callback)
# NEXT_PUBLIC_OAUTH_REDIRECT_URI=https://lmrm.vercel.app/oauth/callback
NEXT_PUBLIC_APP_SCHEME=osw
# Discord 영구 초대 (프로덕션 Vercel에도 설정)
NEXT_PUBLIC_DISCORD_INVITE_URL=https://discord.gg/qfJnk3VJyf
```

새 콜백은 `osw://`를 생성합니다. 데스크톱 앱은 기존 OAuth 세션과 구버전 웹
콜백을 위해 `live-mr-manager://`도 입력 호환용으로만 계속 받습니다.

배포 앱 로그인: **Client Secret은 Vercel에만** 두고, 데스크톱 릴리스는 GitHub secret `MELOMING_CLIENT_ID`만 바이너리에 임베드합니다. 앱은 Secret이 없으면 Companion `/api/oauth/exchange`·`/api/oauth/refresh`로 토큰을 교환합니다.

문의 채널·Discord 서버 설정: [`docs/DISCORD_SETUP.md`](../../docs/DISCORD_SETUP.md)

## GitHub Issues

버그·멜로밍 연동·기능 제안 템플릿: [`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/)

## Vercel 배포

1. Vercel에서 이 폴더(`web/companion`)를 루트로 import
2. 프로덕션 URL: `https://lmrm.vercel.app`
3. 멜로밍 개발자 센터:
   - **iframe URL**: `https://lmrm.vercel.app/`
   - **Redirect URI**: `https://lmrm.vercel.app/oauth/callback` (끝 `/` 없음, `https`)

## OAuth 상태 (2026-07, v0.5.1)

- authorize·code·콜백 분기: 동작
- **배포 앱**: Client ID는 릴리스 바이너리 임베드, Client Secret은 Vercel만 → Companion `/api/oauth/exchange`·`/api/oauth/refresh`
- `POST /oauth/token` 직접 호출: 로컬 `.env`에 Secret이 있을 때만 (개발). 멜로밍 서버 500/401은 간헐적
- 웹 `/login`은 OAuth API 검증용 (추후 정리 예정)

상세: [docs/MELOMING_SONGBOOK_INTEGRATION.md](../../docs/MELOMING_SONGBOOK_INTEGRATION.md)
