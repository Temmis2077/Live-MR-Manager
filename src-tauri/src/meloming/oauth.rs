//! OAuth 2.0 Authorization Code + PKCE for Meloming write APIs.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use getrandom::getrandom;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

static OAUTH_CALLBACK_DEDUP: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

use super::client::{MelomingClient, MelomingError, BASE_URL};
use super::settings::{
    clear_setting, get_setting, set_setting, KEY_ACCESS_TOKEN, KEY_API_KEY, KEY_CHANNEL_ID,
    KEY_CHANNEL_INPUT, KEY_CLIENT_ID, KEY_CLIENT_SECRET, KEY_EXPIRES_AT, KEY_OAUTH_STATE,
    KEY_OAUTH_VERIFIER, KEY_REFRESH_TOKEN,
};

pub const REDIRECT_URI: &str = "https://lmrm.vercel.app/oauth/callback";
pub const COMPANION_EXCHANGE_URL: &str = "https://lmrm.vercel.app/api/oauth/exchange";
pub const COMPANION_REFRESH_URL: &str = "https://lmrm.vercel.app/api/oauth/refresh";
/// 개발자 센터 OAuth Client 생성 시 허용한 scope와 동일하게 맞출 것.
pub const OAUTH_SCOPE: &str = "profile:read channels:read songbook:read songbook:write";

fn embedded_client_id() -> Option<&'static str> {
    option_env!("EMBEDDED_MELOMING_CLIENT_ID").and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

/// Settings → 런타임 env → 빌드 임베드 순.
pub fn resolve_client_id() -> Option<String> {
    get_setting(KEY_CLIENT_ID)
        .or_else(|| std::env::var("MELOMING_CLIENT_ID").ok())
        .or_else(|| embedded_client_id().map(|s| s.to_string()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Settings → 런타임 env. Secret은 바이너리에 임베드하지 않음.
pub fn resolve_client_secret() -> Option<String> {
    get_setting(KEY_CLIENT_SECRET)
        .or_else(|| std::env::var("MELOMING_CLIENT_SECRET").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 로컬 Secret이 있으면 멜로밍 직접 교환, 없으면 Companion 프록시(배포 기본).
/// `MELOMING_USE_COMPANION_EXCHANGE`로 강제 on/off 가능.
pub fn use_companion_exchange() -> bool {
    if let Ok(v) = std::env::var("MELOMING_USE_COMPANION_EXCHANGE") {
        let t = v.trim();
        if matches!(t, "0" | "false" | "no") {
            return false;
        }
        if matches!(t, "1" | "true" | "yes") {
            return true;
        }
    }
    resolve_client_secret().is_none()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatus {
    pub has_client_id: bool,
    pub logged_in: bool,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IntrospectResponse {
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserInfo {
    #[serde(default)]
    pub sub: Option<String>,
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
}

fn random_pkce_verifier() -> String {
    let mut bytes = [0u8; 32];
    getrandom(&mut bytes).expect("getrandom");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn random_state() -> String {
    let mut bytes = [0u8; 16];
    getrandom(&mut bytes).expect("getrandom");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `src-tauri/.env` / 빌드 임베드 → Settings (UI 표시·일관성)
pub fn sync_credentials_from_env() {
    if get_setting(KEY_CLIENT_ID).is_none() {
        if let Some(id) = resolve_client_id() {
            let _ = set_setting(KEY_CLIENT_ID, &id);
        }
    }
    if let Ok(secret) = std::env::var("MELOMING_CLIENT_SECRET") {
        if !secret.trim().is_empty() && get_setting(KEY_CLIENT_SECRET).is_none() {
            let _ = set_setting(KEY_CLIENT_SECRET, secret.trim());
        }
    }
    if let Ok(key) = std::env::var("MELOMING_API_KEY") {
        if !key.trim().is_empty() && get_setting(KEY_API_KEY).is_none() {
            let _ = set_setting(KEY_API_KEY, key.trim());
        }
    }
}

/// authorize용 Client ID. Secret은 Companion 경로에서 불필요.
pub fn require_client_id() -> Result<String, String> {
    resolve_client_id().ok_or_else(|| {
        "OAuth 설정이 없습니다. 앱을 최신 버전으로 업데이트해 주세요.".to_string()
    })
}

/// 직접 토큰 교환용. Companion 사용 시 secret은 빈 문자열일 수 있음.
pub fn credentials() -> Result<(String, String), String> {
    let client_id = require_client_id()?;
    let client_secret = resolve_client_secret().unwrap_or_default();
    if !use_companion_exchange() && client_secret.is_empty() {
        return Err(
            "OAuth Client Secret이 없습니다. src-tauri/.env 또는 Companion 교환을 확인해 주세요."
                .into(),
        );
    }
    Ok((client_id, client_secret))
}

pub fn oauth_status() -> OAuthStatus {
    let has_client_id = resolve_client_id().is_some();
    let access = get_setting(KEY_ACCESS_TOKEN);
    let expires_at = get_setting(KEY_EXPIRES_AT).and_then(|s| s.parse().ok());
    OAuthStatus {
        has_client_id,
        logged_in: access.is_some_and(|t| !t.is_empty()),
        expires_at,
    }
}

fn store_tokens(access: &str, refresh: Option<&str>, expires_in: i64) -> Result<(), String> {
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        + expires_in;
    set_setting(KEY_ACCESS_TOKEN, access)?;
    if let Some(r) = refresh.filter(|s| !s.is_empty()) {
        set_setting(KEY_REFRESH_TOKEN, r)?;
    }
    set_setting(KEY_EXPIRES_AT, &expires_at.to_string())?;
    Ok(())
}

fn token_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("OSW")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn parse_token_response(
    status: reqwest::StatusCode,
    body: String,
    via: &str,
) -> Result<TokenResponse, MelomingError> {
    if !status.is_success() {
        let _ = crate::audio_player::sys_log(&format!(
            "[Meloming OAuth] token HTTP {} via {via}: {}",
            status.as_u16(),
            body.chars().take(400).collect::<String>()
        ));
        return Err(MelomingError::Http(status.as_u16(), body));
    }
    serde_json::from_str(&body).map_err(|e| MelomingError::Message(format!("token JSON: {e}; {body}")))
}

async fn post_token_form(params: &[(&str, String)]) -> Result<TokenResponse, MelomingError> {
    let res = token_http_client()
        .post(format!("{BASE_URL}/oauth/token"))
        .header("Accept", "application/json")
        .form(params)
        .send()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    parse_token_response(status, body, "form").await
}

async fn introspect_token(access_token: &str) -> Result<IntrospectResponse, MelomingError> {
    let res = token_http_client()
        .post(format!("{BASE_URL}/oauth/introspect"))
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "token": access_token,
            "token_type_hint": "access_token",
        }))
        .send()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    if !status.is_success() {
        return Err(MelomingError::Http(status.as_u16(), body));
    }
    serde_json::from_str(&body)
        .map_err(|e| MelomingError::Message(format!("introspect JSON: {e}; {body}")))
}

pub async fn fetch_userinfo(access_token: &str) -> Result<UserInfo, MelomingError> {
    let res = token_http_client()
        .get(format!("{BASE_URL}/oauth/userinfo"))
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    if !status.is_success() {
        return Err(MelomingError::Http(status.as_u16(), body));
    }
    serde_json::from_str(&body)
        .map_err(|e| MelomingError::Message(format!("userinfo JSON: {e}; {body}")))
}

async fn try_persist_channel_from_userinfo(access_token: &str) {
    if get_setting(KEY_CHANNEL_ID).is_some() {
        return;
    }
    let Ok(info) = fetch_userinfo(access_token).await else {
        return;
    };
    let Some(sub) = info.sub.filter(|s| !s.trim().is_empty()) else {
        return;
    };
    if let Ok(resolved) = MelomingClient::resolve_channel(&sub).await {
        let _ = set_setting(KEY_CHANNEL_INPUT, sub.trim());
        let _ = set_setting(KEY_CHANNEL_ID, &resolved.id.to_string());
    }
}

async fn log_token_scope(access_token: &str, token_scope: Option<&str>) {
    if let Some(scope) = token_scope.filter(|s| !s.trim().is_empty()) {
        let _ = crate::audio_player::sys_log(&format!(
            "[Meloming OAuth] token scope (from /oauth/token): {scope}"
        ));
    }

    match introspect_token(access_token).await {
        Ok(info) => {
            let active = info.active.unwrap_or(false);
            let scope = info.scope.as_deref().unwrap_or("(none)");
            let subject = info
                .username
                .as_deref()
                .or(info.sub.as_deref())
                .unwrap_or("—");
            let _ = crate::audio_player::sys_log(&format!(
                "[Meloming OAuth] introspect active={active} scope={scope} subject={subject}"
            ));
            if !scope.split_whitespace().any(|s| s == "songbook:write") {
                let _ = crate::audio_player::sys_log(
                    "[Meloming OAuth] warning: songbook:write scope missing — 보내기(Push)가 403으로 실패할 수 있습니다.",
                );
            }
        }
        Err(e) => {
            let _ = crate::audio_player::sys_log(&format!("[Meloming OAuth] introspect failed: {e}"));
        }
    }
}

async fn post_token_via_companion(code: &str, verifier: &str) -> Result<TokenResponse, MelomingError> {
    let res = token_http_client()
        .post(COMPANION_EXCHANGE_URL)
        .json(&serde_json::json!({
            "code": code,
            "codeVerifier": verifier,
        }))
        .send()
        .await
        .map_err(|e| MelomingError::Message(format!("companion proxy: {e}")))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    parse_token_response(status, body, "companion").await
}

async fn post_refresh_via_companion(refresh_token: &str) -> Result<TokenResponse, MelomingError> {
    let res = token_http_client()
        .post(COMPANION_REFRESH_URL)
        .json(&serde_json::json!({
            "refreshToken": refresh_token,
        }))
        .send()
        .await
        .map_err(|e| MelomingError::Message(format!("companion refresh: {e}")))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| MelomingError::Message(e.to_string()))?;
    parse_token_response(status, body, "companion-refresh").await
}

pub fn format_oauth_error(err: &MelomingError) -> String {
    match err {
        MelomingError::Http(500, body) if body.contains("INTERNAL_ERROR") => {
            "멜로밍 서버 내부 오류(500)입니다. 개발자 센터에서 OAuth 앱이 「활성」 상태인지 확인하고, \
             Client Secret을 재발급한 뒤 앱 설정에 다시 저장해 주세요. \
             문제가 계속되면 멜로밍 개발자 지원에 OAuth Client ID와 오류 시각을 전달해 주세요."
                .into()
        }
        MelomingError::Http(400, body) if body.contains("invalid_grant") => {
            "인증 코드가 만료되었거나 이미 사용되었습니다. 「멜로밍 로그인」을 처음부터 다시 시도해 주세요.".into()
        }
        MelomingError::Http(_, body) => {
            format!(
                "멜로밍 API 오류: {}",
                body.chars().take(240).collect::<String>()
            )
        }
        MelomingError::Message(m) => m.clone(),
    }
}

async fn exchange_code_tokens(
    code: &str,
    verifier: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<TokenResponse, MelomingError> {
    let form_params = [
        ("grant_type", "authorization_code".into()),
        ("code", code.trim().to_string()),
        ("client_id", client_id.to_string()),
        ("client_secret", client_secret.to_string()),
        ("redirect_uri", REDIRECT_URI.into()),
        ("code_verifier", verifier.to_string()),
    ];

    let via = if use_companion_exchange() {
        "companion"
    } else {
        "form"
    };
    let _ = crate::audio_player::sys_log(&format!(
        "[Meloming OAuth] exchanging code (len={}, verifier_len={}, via={via})",
        code.trim().len(),
        verifier.len(),
    ));

    // 인증 code는 1회용. 500이 나와도 서버에서 소비될 수 있으므로 같은 code로 재시도하지 않음.
    if use_companion_exchange() {
        post_token_via_companion(code, verifier).await
    } else {
        post_token_form(&form_params).await
    }
}

pub async fn exchange_code(code: &str, state: &str) -> Result<(), MelomingError> {
    let dedupe_key = format!("{}:{}", code.trim(), state);
    {
        let mut guard = OAUTH_CALLBACK_DEDUP.lock();
        if guard.as_deref() == Some(dedupe_key.as_str()) {
            return Err(MelomingError::Message(
                "이미 처리된 인증 코드입니다. 500 오류 후 같은 code로는 재시도할 수 없으니 「멜로밍 로그인」을 처음부터 다시 시작해 주세요.".into(),
            ));
        }
        *guard = Some(dedupe_key);
    }

    let expected_state = get_setting(KEY_OAUTH_STATE).ok_or_else(|| {
        MelomingError::Message("OAuth state가 없습니다. 다시 로그인을 시작해 주세요.".into())
    })?;
    if expected_state != state {
        return Err(MelomingError::Message("OAuth state가 일치하지 않습니다.".into()));
    }
    let verifier = get_setting(KEY_OAUTH_VERIFIER).ok_or_else(|| {
        MelomingError::Message("PKCE verifier가 없습니다. 다시 로그인을 시작해 주세요.".into())
    })?;
    let (client_id, client_secret) = credentials().map_err(MelomingError::Message)?;

    let token = exchange_code_tokens(code, &verifier, &client_id, &client_secret).await?;

    store_tokens(
        &token.access_token,
        token.refresh_token.as_deref(),
        token.expires_in,
    )
    .map_err(MelomingError::Message)?;

    log_token_scope(&token.access_token, token.scope.as_deref()).await;
    try_persist_channel_from_userinfo(&token.access_token).await;

    let _ = clear_setting(KEY_OAUTH_VERIFIER);
    let _ = clear_setting(KEY_OAUTH_STATE);
    Ok(())
}

async fn refresh_access_token() -> Result<String, MelomingError> {
    let refresh = get_setting(KEY_REFRESH_TOKEN).ok_or_else(|| {
        MelomingError::Message("Refresh Token이 없습니다. 다시 로그인해 주세요.".into())
    })?;

    let token = if use_companion_exchange() {
        let _ = crate::audio_player::sys_log("[Meloming OAuth] refreshing via companion");
        post_refresh_via_companion(&refresh).await?
    } else {
        let (client_id, client_secret) = credentials().map_err(MelomingError::Message)?;
        post_token_form(&[
            ("grant_type", "refresh_token".into()),
            ("refresh_token", refresh),
            ("client_id", client_id),
            ("client_secret", client_secret),
        ])
        .await?
    };

    store_tokens(
        &token.access_token,
        token.refresh_token.as_deref(),
        token.expires_in,
    )
    .map_err(MelomingError::Message)?;
    Ok(get_setting(KEY_ACCESS_TOKEN).unwrap_or(token.access_token))
}

pub async fn access_token() -> Result<String, MelomingError> {
    let expires_at = get_setting(KEY_EXPIRES_AT).and_then(|s| s.parse::<i64>().ok());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let access = get_setting(KEY_ACCESS_TOKEN).filter(|s| !s.is_empty());
    if let (Some(token), Some(exp)) = (access, expires_at) {
        if now + 60 < exp {
            return Ok(token);
        }
    }

    if get_setting(KEY_REFRESH_TOKEN).is_some() {
        return refresh_access_token().await;
    }

    Err(MelomingError::Message(
        "로그인이 필요합니다. 우측 상단에서 멜로밍 로그인을 실행해 주세요.".into(),
    ))
}

pub fn build_authorize_url() -> Result<(String, String), String> {
    *OAUTH_CALLBACK_DEDUP.lock() = None;
    sync_credentials_from_env();
    let client_id = require_client_id()?;

    let verifier = random_pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let state = random_state();

    set_setting(KEY_OAUTH_VERIFIER, &verifier)?;
    set_setting(KEY_OAUTH_STATE, &state)?;

    let mut url =
        url::Url::parse(&format!("{BASE_URL}/oauth/authorize")).map_err(|e| e.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("response_type", "code");
        pairs.append_pair("client_id", client_id.trim());
        pairs.append_pair("redirect_uri", REDIRECT_URI);
        pairs.append_pair("scope", OAUTH_SCOPE);
        pairs.append_pair("state", &state);
        pairs.append_pair("code_challenge", &challenge);
        pairs.append_pair("code_challenge_method", "S256");
    }
    let url_string = url.to_string();
    let _ = crate::audio_player::sys_log(&format!(
        "[Meloming OAuth] authorize ready (client_id len={}, companion={})",
        client_id.trim().len(),
        use_companion_exchange()
    ));
    Ok((url_string, state))
}

pub fn open_authorize_url(app: &AppHandle, url: &str) -> Result<(), String> {
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        let _ = crate::audio_player::sys_log(&format!(
            "[Meloming OAuth] opener failed ({e}); using shell fallback"
        ));
        open_url_fallback(url)?;
    }
    Ok(())
}

fn open_url_fallback(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let escaped = url.replace('\'', "''");
        let ps = format!("Start-Process '{escaped}'");
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn logout() -> Result<(), String> {
    for key in [
        KEY_ACCESS_TOKEN,
        KEY_REFRESH_TOKEN,
        KEY_EXPIRES_AT,
        KEY_OAUTH_VERIFIER,
        KEY_OAUTH_STATE,
    ] {
        let _ = clear_setting(key);
    }
    Ok(())
}

pub fn handle_deep_link(app: &AppHandle, url: &str) {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(e) => {
            let _ = app.emit("meloming-oauth-complete", serde_json::json!({ "ok": false, "error": e.to_string() }));
            return;
        }
    };
    if parsed.scheme() != "live-mr-manager" {
        return;
    }
    if parsed.host_str() != Some("oauth") || parsed.path() != "/callback" {
        return;
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(err) = error {
        let _ = app.emit(
            "meloming-oauth-complete",
            serde_json::json!({ "ok": false, "error": err }),
        );
        return;
    }
    let (code, state) = match (code, state) {
        (Some(c), Some(s)) => (c, s),
        _ => {
            let _ = app.emit(
                "meloming-oauth-complete",
                serde_json::json!({ "ok": false, "error": "code 또는 state가 없습니다." }),
            );
            return;
        }
    };

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = exchange_code(&code, &state).await;
        let payload = match result {
            Ok(()) => serde_json::json!({ "ok": true }),
            Err(e) => serde_json::json!({ "ok": false, "error": format_oauth_error(&e) }),
        };
        let _ = handle.emit("meloming-oauth-complete", payload);
    });
}
