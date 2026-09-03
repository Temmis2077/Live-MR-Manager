use std::path::PathBuf;

use tauri::{AppHandle, Manager, WebviewWindow, State};
use cpal::traits::{HostTrait, DeviceTrait};
use crate::types::SongMetadata;
use crate::library;

/// 저장 대화상자가 프로젝트(src-tauri) 폴더를 열면 dev 모드에서 앱이 재시작됩니다.
fn user_documents_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let docs = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .map(|p| p.join("Documents"));
        if docs.as_ref().is_some_and(|p| p.is_dir()) {
            return docs;
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            let docs = home.join("Documents");
            if docs.is_dir() {
                return Some(docs);
            }
        }
    }
    None
}

fn file_dialog_in_documents() -> rfd::AsyncFileDialog {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(dir) = user_documents_dir() {
        dialog = dialog.set_directory(dir);
    }
    dialog
}

#[tauri::command]
pub fn get_app_paths(handle: AppHandle) -> crate::state::AppPaths {
    handle.state::<crate::state::AppPaths>().inner().clone()
}

/// 가사 호버창을 연다 — 번들된 lyrics-view.html을 `?hover=1`로 띄운 별도 창.
/// 항상 위 + 투명 배경(페이지에서 알파 조절) + 크기 조절 + 헤더 드래그 이동.
/// 이미 열려 있으면 새로 만들지 않고 앞으로 가져온다.
#[tauri::command]
pub async fn open_lyrics_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("lyrics-hover") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "lyrics-hover",
        tauri::WebviewUrl::App("lyrics-view.html?hover=1".into()),
    )
    .title("가사 뷰")
    .inner_size(420.0, 620.0)
    .min_inner_size(260.0, 220.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 노래 추가 UI의 "로컬 파일 선택" — 오디오 파일 다중 선택 대화상자.
/// 취소하면 빈 벡터.
#[tauri::command]
pub async fn pick_audio_files() -> Result<Vec<String>, String> {
    let picked = file_dialog_in_documents()
        .add_filter("오디오 파일", &["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma"])
        .pick_files()
        .await;
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .map(|f| f.path().to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
pub async fn get_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for d in devices {
        if let Ok(desc) = d.description() {
            let config = d.default_output_config().map(|c| format!("{}Hz, {}ch", u32::from(c.sample_rate()), c.channels())).unwrap_or_else(|_| "N/A".into());
            names.push(format!("{} ({})", desc.name(), config));
        }
    }
    Ok(names)
}

/// MR 캐시(separated) 저장 위치 정보. `configured`는 오버라이드 파일에 저장된
/// 값(재시작 후 적용될 경로), `current`는 이번 세션에서 실제로 쓰고 있는 경로.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrCacheDirInfo {
    pub current: String,
    pub configured: Option<String>,
    pub default_dir: String,
}

#[tauri::command]
pub fn get_mr_cache_dir(window: WebviewWindow) -> MrCacheDirInfo {
    let paths = window.state::<crate::state::AppPaths>();
    let config_path = crate::state::separated_override_config_path(&paths.root);
    let configured = std::fs::read_to_string(&config_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    MrCacheDirInfo {
        current: paths.separated.to_string_lossy().to_string(),
        configured,
        default_dir: paths.cache.join("separated").to_string_lossy().to_string(),
    }
}

/// 폴더 선택 대화상자를 열어 MR 캐시 저장 위치를 변경한다. 선택한 폴더에
/// 쓰기 검사를 한 뒤 오버라이드 파일에 저장 — **재시작 후 적용**(세션 중에
/// 경로가 바뀌면 이미 진행 중인 분리/재생과 어긋나므로 의도적으로 고정).
/// 기존 캐시는 자동 이동하지 않는다(프론트에서 안내).
#[tauri::command]
pub async fn set_mr_cache_dir(window: WebviewWindow) -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new().pick_folder().await;
    let Some(folder) = picked else { return Ok(None) }; // 사용자가 취소
    let dir = folder.path().to_path_buf();

    // 쓰기 가능한지 실제로 검사 (네트워크 공유의 읽기 전용 마운트 등 방지)
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더를 사용할 수 없습니다: {}", e))?;
    let probe = dir.join(".livemr_write_test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("폴더에 쓸 수 없습니다 (권한 확인): {}", e))?;
    let _ = std::fs::remove_file(&probe);

    let paths = window.state::<crate::state::AppPaths>();
    let config_path = crate::state::separated_override_config_path(&paths.root);
    std::fs::write(&config_path, dir.to_string_lossy().as_bytes())
        .map_err(|e| format!("설정 저장 실패: {}", e))?;
    Ok(Some(dir.to_string_lossy().to_string()))
}

/// MR 캐시 저장 위치를 기본값(앱 데이터 폴더)으로 되돌린다. 재시작 후 적용.
#[tauri::command]
pub fn reset_mr_cache_dir(window: WebviewWindow) -> Result<(), String> {
    let paths = window.state::<crate::state::AppPaths>();
    let config_path = crate::state::separated_override_config_path(&paths.root);
    if config_path.exists() {
        std::fs::remove_file(&config_path).map_err(|e| format!("설정 초기화 실패: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_cache_folder(window: WebviewWindow) -> Result<(), String> {
    let path = window.state::<crate::state::AppPaths>().separated.clone();
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer")
        .arg(path.to_string_lossy().to_string())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 로그 폴더를 파일 탐색기로 연다.
///
/// 버그 신고 양식이 로그를 요구하는데 정작 앱 어디에도 위치를 알려주는 곳이
/// 없었다. 로그는 audio_player::sys_log가 `<앱폴더>/logs/app.log`에 쌓는다.
/// 아직 한 줄도 안 쌓였으면 폴더가 없으므로 만들어서 연다 — "폴더가
/// 없습니다"라는 에러는 신고하려는 사람에게 아무 도움이 안 된다.
#[tauri::command]
pub async fn open_log_folder(window: WebviewWindow) -> Result<(), String> {
    let dir = window.state::<crate::state::AppPaths>().root.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("로그 폴더를 만들지 못했습니다: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(dir.to_string_lossy().to_string())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 이 곡의 MR 분리 결과가 들어있는 폴더를 파일 탐색기로 연다.
/// 캐시 폴더 이름은 경로를 정규화·URL 인코딩한 값이라 사용자가 직접 찾기
/// 어려우므로(유튜브 URL이 그대로 인코딩됨), 여기서 해석해 열어준다.
/// 아직 분리하지 않은 곡이면 폴더가 없으므로 에러를 돌려준다.
#[tauri::command]
pub async fn open_mr_folder(window: WebviewWindow, path: String) -> Result<(), String> {
    let separated_root = window.state::<crate::state::AppPaths>().separated.clone();
    // get_separation_info와 같은 방식으로 실제 존재하는 캐시 폴더를 찾는다
    // (경로 표기 변형 — youtu.be / youtube.com 등 — 을 모두 시도).
    let dir = crate::youtube_url::cache_key_variants(&path)
        .into_iter()
        .map(|key| separated_root.join(urlencoding::encode(&key).to_string()))
        .find(|d| d.is_dir())
        .ok_or_else(|| "아직 MR 분리가 되지 않은 곡입니다.".to_string())?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(dir.to_string_lossy().to_string())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 백업 파일 형식 v2.
///
/// v1은 곡 배열만 담은 JSON이었다. 그래서 백업을 들고 새 PC로 옮겨도 테마·
/// 오버레이 디자인·라이브 대기열 같은 앱 설정은 전부 처음부터 다시 맞춰야
/// 했다(그 값들은 프런트의 localStorage에 있고 DB에 없다).
///
/// v2는 설정을 함께 담는다. 설정의 의미는 프런트만 알고 백엔드는 문자열
/// 맵으로 통과시키기만 한다 — 키가 늘어도 여기를 고칠 일이 없다.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct BackupFileV2 {
    pub format_version: u32,
    pub songs: Vec<SongMetadata>,
    #[serde(default)]
    pub app_settings: std::collections::HashMap<String, String>,
}

/// 옛 백업(곡 배열)과 새 백업(객체)을 모두 읽는다.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum BackupFile {
    V2(BackupFileV2),
    /// v1 — 곡 배열만. 설정은 없는 것으로 친다.
    V1(Vec<SongMetadata>),
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBackupResult {
    pub added: usize,
    /// 프런트가 localStorage에 되돌릴 설정. v1 백업이면 비어 있다.
    pub app_settings: std::collections::HashMap<String, String>,
}

#[tauri::command]
pub async fn export_backup(
    paths: State<'_, crate::state::AppPaths>,
    app_settings: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    if let Some(path) = file_dialog_in_documents()
        .add_filter("JSON", &["json"])
        .set_file_name("OSW_Backup.json")
        .save_file()
        .await
    {
        let backup = BackupFileV2 {
            format_version: 2,
            songs: library::get_songs_internal(paths.inner().clone()).await?,
            app_settings: app_settings.unwrap_or_default(),
        };
        let json = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
        std::fs::write(path.path(), json).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("CANCELLED".into())
    }
}

#[tauri::command]
pub async fn import_backup(
    _app: AppHandle,
    paths: State<'_, crate::state::AppPaths>,
) -> Result<ImportBackupResult, String> {
    if let Some(path) = file_dialog_in_documents()
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
    {
        let json = std::fs::read_to_string(path.path()).map_err(|e| e.to_string())?;
        let (backup_songs, app_settings) = match serde_json::from_str::<BackupFile>(&json)
            .map_err(|e| format!("백업 파일을 읽을 수 없습니다: {}", e))?
        {
            BackupFile::V2(v2) => (v2.songs, v2.app_settings),
            BackupFile::V1(songs) => (songs, std::collections::HashMap::new()),
        };

        let mut current_songs = library::get_songs_internal(paths.inner().clone()).await?;
        let current_paths: std::collections::HashSet<String> = current_songs.iter().map(|s| s.path.clone()).collect();

        let mut added = 0;
        for song in backup_songs {
            if !current_paths.contains(&song.path) {
                current_songs.push(song);
                added += 1;
            }
        }

        library::save_library_internal(current_songs).await?;
        Ok(ImportBackupResult { added, app_settings })
    } else {
        Err("CANCELLED".into())
    }
}
#[tauri::command]
pub async fn export_library_spreadsheet(
    paths: State<'_, crate::state::AppPaths>,
    template_only: Option<bool>,
) -> Result<(), String> {
    let template = template_only.unwrap_or(false);
    let bytes = crate::spreadsheet::export_library_csv(paths.inner(), template).await?;
    let default_name = if template {
        "LiveMR_Import_Template.csv"
    } else {
        "LiveMR_Library.csv"
    };
    if let Some(path) = file_dialog_in_documents()
        .add_filter("CSV (Excel)", &["csv"])
        .set_file_name(default_name)
        .save_file()
        .await
    {
        std::fs::write(path.path(), bytes).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("CANCELLED".into())
    }
}

#[tauri::command]
pub async fn import_library_spreadsheet(
    paths: State<'_, crate::state::AppPaths>,
) -> Result<crate::spreadsheet::SpreadsheetImportResult, String> {
    if let Some(path) = file_dialog_in_documents()
        .add_filter("스프레드시트", &["csv", "xlsx", "xls", "xlsm"])
        .pick_file()
        .await
    {
        let rows = crate::spreadsheet::parse_spreadsheet_file(path.path())?;
        crate::spreadsheet::merge_rows_into_library(paths.inner(), rows).await
    } else {
        Err("CANCELLED".into())
    }
}

#[tauri::command]
pub async fn remote_js_log(msg: String) {
    let _ = crate::audio_player::sys_log(&format!("[JS] {}", msg));
}
