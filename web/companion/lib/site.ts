export const GITHUB_REPO = "Temmis2077/OSW";
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
export const GITHUB_ISSUES_URL = `https://github.com/${GITHUB_REPO}/issues`;

export const MELOMING_DOCS_URL =
  "https://developers.meloming.com/docs/openapi/reference/songbook";

export const SITE_NAME = "OSW";

export const SITE_LOGO = "/images/logo.png";
export const SITE_ICON = "/images/app-icon.png";

export const COMPANION_BASE =
  process.env.NEXT_PUBLIC_COMPANION_BASE?.trim() || "https://lmrm.vercel.app";

export const FAQ_URL = `${COMPANION_BASE}/faq`;
export const QA_URL = `${COMPANION_BASE}/qa`;

/** Discord 초대 링크 — [LMRM] OSW */
export const DISCORD_INVITE_URL =
  process.env.NEXT_PUBLIC_DISCORD_INVITE_URL?.trim() ||
  "https://discord.gg/qfJnk3VJyf";

export const GITHUB_ISSUES_BUG_URL = `${GITHUB_ISSUES_URL}/new?template=bug_report.yml`;
export const GITHUB_ISSUES_MELOMING_URL = `${GITHUB_ISSUES_URL}/new?template=meloming_integration.yml`;
export const GITHUB_ISSUES_FEATURE_URL = `${GITHUB_ISSUES_URL}/new?template=feature_request.yml`;

/** 앱 OAuth 콜백 (웹 PKCE 쿠키가 없을 때만 사용) */
export const APP_SCHEME =
  process.env.NEXT_PUBLIC_APP_SCHEME ?? "live-mr-manager";

export function appOAuthCallbackUrl(params: {
  code?: string;
  state?: string;
}): string {
  const url = new URL(`${APP_SCHEME}://oauth/callback`);
  if (params.code) url.searchParams.set("code", params.code);
  if (params.state) url.searchParams.set("state", params.state);
  return url.toString();
}
