/**
 * Companion 웹·GitHub Issues·Discord URL (앱 설정 링크용)
 * web/companion/lib/site.ts 와 동기화 유지
 */
export const GITHUB_REPO = 'Temmis2077/OSW';
export const COMPANION_BASE = 'https://lmrm.vercel.app';

export const FAQ_URL = `${COMPANION_BASE}/faq`;
export const QA_URL = `${COMPANION_BASE}/qa`;
export const PRIVACY_URL = `${COMPANION_BASE}/privacy`;
export const TERMS_URL = `${COMPANION_BASE}/terms`;

/** Discord 초대 링크 — [LMRM] OSW */
export const DISCORD_INVITE_URL = 'https://discord.gg/qfJnk3VJyf';

const issuesBase = `https://github.com/${GITHUB_REPO}/issues`;

export const GITHUB_ISSUES_BUG_URL = `${issuesBase}/new?template=bug_report.yml`;
export const GITHUB_ISSUES_MELOMING_URL = `${issuesBase}/new?template=meloming_integration.yml`;
export const GITHUB_ISSUES_FEATURE_URL = `${issuesBase}/new?template=feature_request.yml`;

/** Discord URL이 없으면 문의 허브(/qa)로 폴백 */
export function resolveDiscordUrl() {
  return DISCORD_INVITE_URL || QA_URL;
}
