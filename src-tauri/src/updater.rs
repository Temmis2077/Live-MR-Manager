use serde::Serialize;
use tauri::{AppHandle, Emitter};
use std::time::Duration;

// OSW는 원본에서 분리된 별개의 앱이라 자체 릴리즈로만 업데이트한다 —
// 원본 레포를 보면 원본 버전이 최신으로 잡혀 엉뚱한 곳으로 유도된다.
const GITHUB_OWNER: &str = "Temmis2077";
const GITHUB_REPO: &str = "OSW";
const USER_AGENT: &str = "OSW-UpdateChecker";
/// 앱 최초 기동 후 한 번만 자동 확인 (이후는 설정의 「업데이트 확인」 버튼)
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub has_update: bool,
}

fn default_release_url() -> String {
    format!("https://github.com/{}/{}/releases", GITHUB_OWNER, GITHUB_REPO)
}

fn strip_version_prefix(tag: &str) -> String {
    tag.trim().trim_start_matches('v').trim_start_matches('V').to_string()
}

fn version_gt(a: &str, b: &str) -> bool {
    let a = strip_version_prefix(a);
    let b = strip_version_prefix(b);
    match (semver::Version::parse(&a), semver::Version::parse(&b)) {
        (Ok(va), Ok(vb)) => va > vb,
        _ => a != b && a > b,
    }
}

async fn github_get_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

/// 릴리즈 목록(JSON 배열)에서 가장 높은 semver 릴리즈를 고른다 → (태그, URL).
///
/// semver로 파싱되지 않는 태그는 건너뛴다 — 이 레포에는 AI 모델 배포용
/// 릴리즈(`ai-align-model-v1` 등)가 함께 있어서, 그대로 버전으로 쓰면
/// 문자열 비교상 "s..." > "0.6.0"이 되어 모델 릴리즈를 새 앱 버전으로
/// 오인한다. draft도 제외.
fn pick_best_release(releases: &[serde_json::Value]) -> Option<(String, String)> {
    let mut best: Option<(semver::Version, String, String)> = None;
    for release in releases {
        if release.get("draft").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(tag) = release.get("tag_name").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(version) = semver::Version::parse(&strip_version_prefix(tag)) else {
            continue;
        };
        let html_url = release
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let replace = best.as_ref().map(|(cur, _, _)| version > *cur).unwrap_or(true);
        if replace {
            best = Some((version, tag.to_string(), html_url));
        }
    }

    let (_, tag, html_url) = best?;
    let release_url = if html_url.is_empty() { default_release_url() } else { html_url };
    Some((tag, release_url))
}

/// 릴리즈 **목록**을 훑어 최신 버전을 찾는다.
///
/// GitHub의 `/releases/latest`는 prerelease를 제외하므로 베타로만 배포하는
/// 이 모드에서는 쓸 수 없다(모델 릴리즈가 대신 잡힌다). 목록을 직접 봐야
/// 베타 → 베타 업데이트가 이어진다.
async fn fetch_from_latest_release(client: &reqwest::Client) -> Option<(String, String)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=30",
        GITHUB_OWNER, GITHUB_REPO
    );
    let json = github_get_json(client, &url).await?;
    pick_best_release(json.as_array()?)
}

async fn fetch_from_tags(client: &reqwest::Client) -> Option<(String, String)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/tags?per_page=30",
        GITHUB_OWNER, GITHUB_REPO
    );
    let json = github_get_json(client, &url).await?;
    let tags = json.as_array()?;

    let mut best: Option<(semver::Version, String)> = None;
    for tag in tags {
        let name = tag.get("name")?.as_str()?;
        let normalized = strip_version_prefix(name);
        let Ok(version) = semver::Version::parse(&normalized) else {
            continue;
        };
        let replace = best
            .as_ref()
            .map(|(current, _)| version > *current)
            .unwrap_or(true);
        if replace {
            best = Some((version, name.to_string()));
        }
    }

    let (_, tag_name) = best?;
    Some((tag_name, default_release_url()))
}

async fn fetch_latest_release() -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    if let Some(found) = fetch_from_latest_release(&client).await {
        return Ok(found);
    }

    fetch_from_tags(&client)
        .await
        .ok_or_else(|| "GitHub에서 최신 버전 정보를 가져오지 못했습니다.".to_string())
}

pub async fn build_update_info() -> Result<AppUpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let (latest_tag, release_url) = fetch_latest_release().await?;
    let latest_version = strip_version_prefix(&latest_tag);
    let has_update = version_gt(&latest_version, &current_version);

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        release_url,
        has_update,
    })
}

#[tauri::command]
pub async fn check_for_app_update() -> Result<AppUpdateInfo, String> {
    build_update_info().await
}

#[tauri::command]
pub async fn open_app_update_page(url: String) -> Result<(), String> {
    let target = if url.trim().is_empty() {
        default_release_url()
    } else {
        url
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &target])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn check_and_notify(app: AppHandle) {
    match build_update_info().await {
        Ok(info) if info.has_update => {
            crate::audio_player::sys_log(&format!(
                "[Updater] New version available: {} (current {})",
                info.latest_version, info.current_version
            ));
            let _ = app.emit("app-update-available", info);
        }
        Ok(_) => {}
        Err(e) => {
            crate::audio_player::sys_log(&format!("[Updater] Check skipped: {}", e));
        }
    }
}

pub fn start_update_checker(app: AppHandle) {
    if cfg!(debug_assertions) {
        crate::audio_player::sys_log("[Updater] Skipping auto-check in debug build");
        return;
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_CHECK_DELAY).await;
        check_and_notify(app).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 실제 이 레포의 /releases 응답 형태 — 베타 2개 + AI 모델 릴리즈 3개.
    fn sample_releases() -> Vec<serde_json::Value> {
        vec![
            json!({"tag_name":"v0.6.0-beta.2","prerelease":true,"draft":false,
                   "html_url":"https://github.com/o/r/releases/tag/v0.6.0-beta.2"}),
            json!({"tag_name":"v0.6.0-beta.1","prerelease":true,"draft":false,
                   "html_url":"https://github.com/o/r/releases/tag/v0.6.0-beta.1"}),
            json!({"tag_name":"separation-model-deux-v1","prerelease":false,"draft":false,
                   "html_url":"https://github.com/o/r/releases/tag/separation-model-deux-v1"}),
            json!({"tag_name":"align-model-en-v1","prerelease":false,"draft":false,
                   "html_url":"https://github.com/o/r/releases/tag/align-model-en-v1"}),
            json!({"tag_name":"ai-align-model-v1","prerelease":false,"draft":false,
                   "html_url":"https://github.com/o/r/releases/tag/ai-align-model-v1"}),
        ]
    }

    #[test]
    fn picks_highest_beta_and_ignores_model_releases() {
        let (tag, url) = pick_best_release(&sample_releases()).unwrap();
        assert_eq!(tag, "v0.6.0-beta.2");
        assert!(url.ends_with("v0.6.0-beta.2"));
    }

    #[test]
    fn beta_ordering_is_semver_not_lexicographic() {
        // beta.10 > beta.9 (문자열 비교였다면 "10" < "9"로 뒤집힌다)
        let releases = vec![
            json!({"tag_name":"v0.6.0-beta.9","draft":false,"html_url":"u9"}),
            json!({"tag_name":"v0.6.0-beta.10","draft":false,"html_url":"u10"}),
        ];
        assert_eq!(pick_best_release(&releases).unwrap().0, "v0.6.0-beta.10");
    }

    #[test]
    fn stable_release_beats_its_own_prerelease() {
        let releases = vec![
            json!({"tag_name":"v0.6.0-beta.3","draft":false,"html_url":"a"}),
            json!({"tag_name":"v0.6.0","draft":false,"html_url":"b"}),
        ];
        assert_eq!(pick_best_release(&releases).unwrap().0, "v0.6.0");
    }

    #[test]
    fn skips_drafts_and_returns_none_without_semver_tags() {
        let drafted = vec![json!({"tag_name":"v9.9.9","draft":true,"html_url":"x"})];
        assert!(pick_best_release(&drafted).is_none());
        let only_models = vec![json!({"tag_name":"ai-align-model-v1","draft":false,"html_url":"x"})];
        assert!(pick_best_release(&only_models).is_none());
    }

    #[test]
    fn beta_updates_to_next_beta_but_not_to_itself() {
        assert!(version_gt("v0.6.0-beta.3", "0.6.0-beta.2"));
        assert!(!version_gt("v0.6.0-beta.3", "0.6.0-beta.3"));
        // 원본(0.5.x)보다 우리 베타가 높다 — 원본 릴리즈로 유도되지 않아야 함
        assert!(version_gt("v0.6.0-beta.1", "0.5.1"));
    }
}
