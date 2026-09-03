import crypto from "crypto";

export const MELOMING_BASE = "https://openapi.meloming.com";
export const TOKEN_URL = `${MELOMING_BASE}/oauth/token`;
export const INTROSPECT_URL = `${MELOMING_BASE}/oauth/introspect`;
export const USERINFO_URL = `${MELOMING_BASE}/oauth/userinfo`;
export const AUTHORIZE_URL = `${MELOMING_BASE}/oauth/authorize`;
export const API_VERSION = "2026-01-11";

export const OAUTH_SCOPE =
  "profile:read channels:read songbook:read songbook:write";

// 멜로밍 OAuth는 오픈 베타에서 UI가 숨겨져 있다. 다시 공개하기 전에는 이 URI가
// 멜로밍 콘솔의 등록값과 일치하는지 별도로 확인해야 한다.
export const PRODUCTION_REDIRECT_URI =
  "https://companion-six-kappa.vercel.app/oauth/callback";

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
};

export type IntrospectResponse = {
  active?: boolean;
  sub?: string;
  scope?: string;
  exp?: number;
  client_id?: string;
  username?: string;
  [key: string]: unknown;
};

export type UserInfoResponse = {
  sub?: string;
  email?: string;
  name?: string;
  nickname?: string;
  picture?: string;
  email_verified?: boolean;
  is_pro_subscriber?: boolean;
  is_ambassador?: boolean;
};

export function randomBase64Url(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function melomingCredentials():
  | { clientId: string; clientSecret: string }
  | { error: string } {
  const clientId = process.env.MELOMING_CLIENT_ID?.trim();
  const clientSecret = process.env.MELOMING_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return {
      error:
        "MELOMING_CLIENT_ID/MELOMING_CLIENT_SECRET이 설정되지 않았습니다.",
    };
  }
  return { clientId, clientSecret };
}

export function resolveRedirectUri(requestOrigin?: string): string {
  const fromEnv = process.env.NEXT_PUBLIC_OAUTH_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  if (requestOrigin) {
    return `${requestOrigin.replace(/\/$/, "")}/oauth/callback`;
  }
  return PRODUCTION_REDIRECT_URI;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ ok: true; token: TokenResponse } | { ok: false; status: number; body: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code.trim(),
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier.trim(),
  });

  return postTokenRequest(body);
}

export async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ ok: true; token: TokenResponse } | { ok: false; status: number; body: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken.trim(),
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  return postTokenRequest(body);
}

async function postTokenRequest(
  body: URLSearchParams,
): Promise<{ ok: true; token: TokenResponse } | { ok: false; status: number; body: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text };
  }

  try {
    const token = JSON.parse(text) as TokenResponse;
    if (!token.access_token) {
      return { ok: false, status: 502, body: "access_token 없음" };
    }
    return { ok: true, token };
  } catch {
    return { ok: false, status: 502, body: `JSON 파싱 실패: ${text}` };
  }
}

export async function fetchUserInfo(
  accessToken: string,
): Promise<UserInfoResponse | null> {
  const res = await fetch(USERINFO_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as UserInfoResponse;
  } catch {
    return null;
  }
}

export async function introspectToken(
  token: string,
): Promise<IntrospectResponse | null> {
  const res = await fetch(INTROSPECT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      token,
      token_type_hint: "access_token",
    }),
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as IntrospectResponse;
  } catch {
    return null;
  }
}

export function formatTokenError(status: number, body: string): string {
  if (status === 500 && body.includes("INTERNAL_ERROR")) {
    return "멜로밍 서버 내부 오류(500)입니다. OAuth 앱이 활성 상태인지 확인해 주세요.";
  }
  if (status === 400 && body.includes("invalid_grant")) {
    return "인증 코드가 만료되었거나 이미 사용되었습니다. 다시 로그인해 주세요.";
  }
  return `멜로밍 토큰 교환 실패 (${status}): ${body.slice(0, 240)}`;
}
