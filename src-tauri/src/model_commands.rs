use tauri::{Emitter, AppHandle, Manager, WebviewWindow};
use std::sync::atomic::Ordering;
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider};
use ort::execution_providers::DirectMLExecutionProvider;
use crate::model_manager::ModelManager;
use crate::types::{Status, PlaybackStatus, SongMetadata};
use crate::audio_player::sys_log;
use crate::youtube::YoutubeManager;
use ort::ep::ExecutionProvider;

use crate::youtube_url::{cache_key_variants, normalize_cache_key};

pub(crate) fn mr_separated_files_exist(paths: &crate::state::AppPaths, path: &str) -> bool {
    cache_key_variants(path).iter().any(|key| {
        let cache = paths.separated.join(urlencoding::encode(key).to_string());
        crate::mr_cache::mr_pair_exists(&cache)
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus { pub has_nvidia: bool, pub is_cuda_available: bool, pub is_directml_available: bool, pub recommend_cuda: bool }

fn directml_available() -> bool {
    DirectMLExecutionProvider::default().is_available().unwrap_or(false)
}

#[tauri::command]
pub async fn check_ai_runtime() -> Result<Vec<String>, String> {
    let mut providers = Vec::new();
    if CUDAExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CUDA".to_string()); }
    if directml_available() {
        providers.push("DirectML".to_string());
    }
    if CPUExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CPU".to_string()); }
    Ok(providers)
}

#[tauri::command]
pub async fn get_gpu_recommendation() -> Result<GpuStatus, String> {
    let mut has_nvidia = false;
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("wmic");
        cmd.creation_flags(0x08000000); // NO_WINDOW
        if let Ok(output) = cmd.args(["path", "win32_VideoController", "get", "name"]).output() {
            if String::from_utf8_lossy(&output.stdout).to_uppercase().contains("NVIDIA") { has_nvidia = true; }
        }
    }
    let cuda = CUDAExecutionProvider::default().is_available().unwrap_or(false);
    let dml = directml_available();
    Ok(GpuStatus { has_nvidia, is_cuda_available: cuda, is_directml_available: dml, recommend_cuda: has_nvidia && !cuda && !dml })
}

#[tauri::command]
pub async fn check_model_ready(handle: AppHandle, model_id: String) -> bool {
    let manager = ModelManager::new(&handle);
    let spec = match ModelManager::spec_from_id(&model_id) {
        Ok(spec) => spec,
        Err(_) => return false,
    };
    manager.resolve_model_path(&handle, &spec).is_some()
}

#[tauri::command]
pub async fn download_ai_model(window: WebviewWindow, model_id: String) -> Result<(), String> {
    let app = window.app_handle();
    let manager = ModelManager::new(app);
    let spec = ModelManager::spec_from_id(&model_id)?;

    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: format!("{} 모델 다운로드...", spec.name) }).ok();
    
    match manager.ensure_model(app, &spec.name, &spec.url).await {
        Ok(path) => {
            let _ = sys_log(&format!("[Model] Ready: id={}, path={:?}", spec.id, path));
            window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: format!("{} 모델 준비됨", spec.name) }).ok();
            Ok(())
        }
        Err(e) => {
            let _ = sys_log(&format!("[Command] [Error] download_ai_model failed: {}", e));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn delete_ai_model(window: WebviewWindow, model_id: String) -> Result<(), String> {
    let manager = ModelManager::new(window.app_handle());
    let spec = ModelManager::spec_from_id(&model_id)?;

    let path = manager.get_model_path(&spec.name);
    if path.exists() {
        std::fs::remove_file(path).ok();
        let mut engine = crate::separation::ROFORMER_ENGINE.lock();
        *engine = None;
        *crate::separation::ENGINE_MODEL_ID.lock() = None;
    }
    Ok(())
}

fn active_model_filename() -> String {
    let model_id = {
        let db = crate::state::DB.lock();
        db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0)).unwrap_or_else(|_| crate::state::DEFAULT_MODEL_ID.to_string())
    };
    ModelManager::spec_from_id(&model_id)
        .map(|spec| spec.name)
        .unwrap_or_else(|_| crate::state::MODELS[0].1.to_string())
}

/// List architecture presets available for custom models.
#[tauri::command]
pub fn list_model_presets() -> Vec<crate::custom_models::ArchPreset> {
    crate::custom_models::PRESETS.to_vec()
}

/// Combined list of built-in and custom models for the model selector.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListEntry {
    pub id: String,
    pub name: String,
    pub is_custom: bool,
    pub preset_key: Option<String>,
}

#[tauri::command]
pub fn list_all_models() -> Vec<ModelListEntry> {
    let mut out: Vec<ModelListEntry> = crate::state::MODELS.iter()
        .map(|(id, name, _)| ModelListEntry {
            id: id.to_string(),
            name: name.to_string(),
            is_custom: false,
            preset_key: None,
        })
        .collect();

    for c in crate::custom_models::list() {
        out.push(ModelListEntry {
            id: c.id,
            name: c.name,
            is_custom: true,
            preset_key: Some(c.preset_key),
        });
    }
    out
}

#[tauri::command]
pub fn list_custom_models() -> Vec<crate::custom_models::CustomModel> {
    crate::custom_models::list()
}

/// Register a custom model. `source_kind` is either `"file"` (a local path that
/// is copied into the models dir) or `"url"` (downloaded on first use).
#[tauri::command]
pub async fn add_custom_model(
    window: WebviewWindow,
    name: String,
    source_kind: String,
    source: String,
    preset_key: String,
) -> Result<crate::custom_models::CustomModel, String> {
    if name.trim().is_empty() {
        return Err("모델 이름을 입력해주세요.".into());
    }
    if crate::custom_models::preset_by_key(&preset_key).is_none() {
        return Err(format!("알 수 없는 아키텍처 프리셋: {}", preset_key));
    }
    if crate::custom_models::is_harmony_preset(&preset_key) && source_kind != "file" {
        return Err("리드/화음 모델은 라이선스 확인이 필요한 로컬 ONNX 파일로만 등록할 수 있습니다.".into());
    }

    let id = format!(
        "custom_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let filename = format!("{}.onnx", id);

    // Clone the path before any `.await` so we don't hold the `State` guard
    // across a suspension point (which would make the future non-Send).
    let models_dir = window.state::<crate::state::AppPaths>().models.clone();
    let dest = models_dir.join(&filename);

    let url = match source_kind.as_str() {
        "file" => {
            // Open a native file picker (consistent with the app's other
            // import flows). `source` is ignored for file mode.
            let _ = source;
            let picked = rfd::AsyncFileDialog::new()
                .add_filter("ONNX Model", &["onnx"])
                .pick_file()
                .await
                .ok_or_else(|| "CANCELLED".to_string())?;
            let src = picked.path().to_path_buf();
            std::fs::copy(&src, &dest).map_err(|e| format!("모델 파일 복사 실패: {}", e))?;
            String::new()
        }
        "url" => {
            if source.trim().is_empty() {
                return Err("다운로드 URL을 입력해주세요.".into());
            }
            source.trim().to_string()
        }
        other => return Err(format!("알 수 없는 소스 종류: {}", other)),
    };

    // Validate the ONNX input signature against the chosen preset (file mode
    // only; URL models surface errors on first load). RawWaveform models take
    // a rank-3 waveform input [1, 2, N]; spectrogram models take rank 4.
    if url.is_empty() {
        let preset_engine = crate::custom_models::preset_by_key(&preset_key)
            .map(|p| p.engine)
            .unwrap_or(crate::vocal_remover::EngineKind::Spectrogram);
        let expected_rank: usize = match preset_engine {
            crate::vocal_remover::EngineKind::RawWaveform => 3,
            crate::vocal_remover::EngineKind::Spectrogram => 4,
        };

        let dest_for_check = dest.clone();
        let rank_res = tokio::task::spawn_blocking(move || -> Result<usize, String> {
            let session = ort::session::Session::builder()
                .map_err(|e| e.to_string())?
                .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Disable)
                .map_err(|e| e.to_string())?
                .commit_from_file(&dest_for_check)
                .map_err(|e| format!("유효한 ONNX 파일이 아닙니다: {}", e))?;
            match session.inputs()[0].dtype() {
                ort::value::ValueType::Tensor { shape, .. } => Ok(shape.len()),
                _ => Ok(0),
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        match rank_res {
            Ok(rank) if rank == expected_rank => {}
            Ok(rank) => {
                let _ = std::fs::remove_file(&dest);
                return Err(format!(
                    "모델 입력 형식이 프리셋과 맞지 않습니다 (입력 rank {}, 기대 rank {}). 아키텍처 프리셋을 다시 확인해주세요.",
                    rank, expected_rank
                ));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&dest);
                return Err(e);
            }
        }
    }

    let model = crate::custom_models::CustomModel {
        id,
        name: name.trim().to_string(),
        filename,
        url,
        preset_key,
    };
    crate::custom_models::insert(&model)?;
    let _ = sys_log(&format!("[Model] Custom model added: id={}, preset={}", model.id, model.preset_key));
    Ok(model)
}

#[tauri::command]
pub async fn remove_custom_model(window: WebviewWindow, model_id: String) -> Result<(), String> {
    let custom = crate::custom_models::get(&model_id)
        .ok_or_else(|| format!("Unknown custom model: {}", model_id))?;

    // Remove the model file from disk.
    let paths = window.state::<crate::state::AppPaths>();
    let file = paths.models.join(&custom.filename);
    if file.exists() {
        std::fs::remove_file(&file).ok();
    }

    crate::custom_models::delete(&model_id)?;

    // If this was the active model, revert to the default built-in one and drop
    // any loaded engine so the next separation reloads.
    {
        let db = crate::state::DB.lock();
        let active: String = db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get(0)).unwrap_or_default();
        if active == model_id {
            db.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('active_model_id', ?)", [crate::state::DEFAULT_MODEL_ID]).ok();
            let mut engine = crate::separation::ROFORMER_ENGINE.lock();
            *engine = None;
            *crate::separation::ENGINE_MODEL_ID.lock() = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_mr_cache_format() -> String {
    // 형식은 Settings DB가 진실의 원천 — in-process static은 분리 스레드가
    // 빠르게 읽는 캐시일 뿐이라, 재시작 후 첫 조회 시 DB 값으로 복원한다.
    // (이전에는 static만 있어서 재시작하면 WAV 선택이 mp3로 되돌아갔음.)
    let saved: Option<String> = {
        let db = crate::state::DB.lock();
        db.query_row(
            "SELECT value FROM Settings WHERE key = 'mr_cache_format'",
            [],
            |row| row.get(0),
        )
        .ok()
    };
    if let Some(fmt) = saved {
        let _ = crate::mr_cache::set_format(&fmt);
    }
    crate::mr_cache::current_format().as_str().to_string()
}

#[tauri::command]
pub fn set_mr_cache_format(format: String) -> Result<(), String> {
    crate::mr_cache::set_format(&format)?;
    let normalized = crate::mr_cache::current_format().as_str().to_string();
    {
        let db = crate::state::DB.lock();
        db.execute(
            "INSERT OR REPLACE INTO Settings (key, value) VALUES ('mr_cache_format', ?)",
            rusqlite::params![normalized],
        )
        .map_err(|e| e.to_string())?;
    }
    sys_log(&format!("MR cache format set to: {}", normalized));
    Ok(())
}

#[tauri::command]
pub async fn set_broadcast_mode(enabled: bool) -> Result<(), String> {
    crate::separation::BROADCAST_MODE.store(enabled, Ordering::Relaxed);
    sys_log(&format!("Broadcast Mode set to: {}", enabled));
    Ok(())
}

#[tauri::command]
pub fn get_active_separations() -> Vec<String> {
    crate::separation::ACTIVE_SEPARATIONS.lock()
        .values()
        .map(|(original_path, _)| original_path.clone())
        .collect()
}

#[tauri::command]
pub async fn start_mr_separation(
    window: WebviewWindow,
    path: String,
    model_id: Option<String>,
    harmony_model_id: Option<String>,
) -> Result<(), String> {
    let norm = normalize_cache_key(&path);
    if crate::separation::ACTIVE_SEPARATIONS.lock().contains_key(&norm) {
        let _ = sys_log(&format!("[Command] [Error] start_mr_separation failed: ALREADY_PROCESSING for {}", path));
        return Err("ALREADY_PROCESSING".into());
    }

    // Per-request model choice (속도/품질 선택 모달). Validate up front so a
    // bad id fails the request instead of surfacing mid-queue as a task error.
    if let Some(ref id) = model_id {
        let spec = ModelManager::spec_from_id(id).map_err(|_| format!("알 수 없는 분리 모델: {}", id))?;
        if spec.params.as_ref().map(|_| crate::custom_models::get(id)
            .map(|m| crate::custom_models::is_harmony_preset(&m.preset_key)).unwrap_or(false)).unwrap_or(false) {
            return Err("화음 분리 모델은 1차 보컬/반주 모델로 사용할 수 없습니다.".into());
        }
    }
    if let Some(ref id) = harmony_model_id {
        ModelManager::spec_from_id(id).map_err(|_| format!("알 수 없는 화음 분리 모델: {}", id))?;
        let valid = crate::custom_models::get(id)
            .map(|m| crate::custom_models::is_harmony_preset(&m.preset_key) && m.url.trim().is_empty())
            .unwrap_or(false);
        if !valid {
            return Err("리드/화음 전용 프리셋으로 직접 등록한 로컬 ONNX 모델을 선택해주세요.".into());
        }
    }

    let cache = window.state::<crate::state::AppPaths>().separated.join(urlencoding::encode(&norm).to_string());
    let task = crate::separation::task::SeparationTask::new(window, path, cache, model_id, harmony_model_id);
    tauri::async_runtime::spawn(async move { task.run().await; });
    Ok(())
}

#[tauri::command]
pub fn cancel_separation(window: WebviewWindow, path: String) -> Result<(), String> {
    let norm = normalize_cache_key(&path);
    let removed = if let Some((original_path, flag)) = crate::separation::ACTIVE_SEPARATIONS.lock().remove(&norm) {
        flag.store(true, Ordering::Relaxed);
        window.emit("separation-progress", crate::separation::SeparationProgress {
            path: original_path,
            percentage: 0.0,
            status: "Cancelled".into(),
            provider: "SYSTEM".into(),
            model: active_model_filename(),
        }).ok();
        true
    } else {
        false
    };
    crate::audio_player::CANCEL_REQUESTS.lock().insert(norm);
    if !removed {
        window.emit("separation-progress", crate::separation::SeparationProgress {
            path,
            percentage: 0.0,
            status: "Cancelled".into(),
            provider: "SYSTEM".into(),
            model: active_model_filename(),
        }).ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn youtube_metadata_fetcher(url: String) -> Result<SongMetadata, String> {
    let metadata_res = YoutubeManager::get_video_metadata(&url).await;
    match metadata_res {
        Ok(m) => {
            let secs = m.duration.unwrap_or(0.0) as u64;
            let duration = format!("{}:{:02}", secs / 60, secs % 60);
            let raw_title = m.title.unwrap_or_else(|| "Unknown Video".into());
            // 영상 제목이 "아티스트 - 곡제목" 류의 규칙적인 패턴을 따르는 경우가
            // 많아, 그대로 쓰지 않고 추정해서 프리필한다(곡 추가 창에서 바로
            // 편집 가능하므로 잘못 추정돼도 기존 "영상 제목 그대로"보다 나쁘지 않음).
            let parsed = crate::title_parser::parse_youtube_title(&raw_title, m.uploader.as_deref());
            Ok(SongMetadata {
                id: None, title: parsed.title,
                thumbnail: m.thumbnail.unwrap_or_default(), duration,
                source: "youtube".into(), path: url, pitch: Some(0.0), tempo: Some(1.0), volume: Some(100.0),
                artist: parsed.artist, tags: None, genre: None, categories: None,
                play_count: Some(0), 
                date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
                is_mr: Some(false), is_separated: Some(false),
                has_lyrics: Some(false),
                lyric_sync_status: None,
                original_title: None, translated_title: None, curation_category: None,
                ..Default::default()
            })
        },
        Err(e) => {
            sys_log(&format!("[Youtube] Fetch failed for {}: {}", url, e));
            Err(e)
        }
    }
}

#[tauri::command]
pub fn check_mr_separated(window: WebviewWindow, path: String) -> bool {
    let paths = window.state::<crate::state::AppPaths>();
    mr_separated_files_exist(paths.inner(), &path)
}

/// 곡별 MR 분리 기록 조회 — 분리 완료 시 캐시 폴더에 함께 저장되는
/// `separation_info.json`({modelId, modelName, provider, completedAt})을
/// 읽어 반환한다. 기록이 없으면(구버전에서 분리했거나 미분리) None.
#[tauri::command]
pub fn get_separation_info(window: WebviewWindow, path: String) -> Option<serde_json::Value> {
    let separated_root = window.state::<crate::state::AppPaths>().separated.clone();
    for key in cache_key_variants(&path) {
        let info_path = separated_root
            .join(urlencoding::encode(&key).to_string())
            .join("separation_info.json");
        if let Ok(content) = std::fs::read_to_string(&info_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
                return Some(value);
            }
        }
    }
    None
}

#[tauri::command]
pub fn delete_mr(window: WebviewWindow, path: String) -> Result<(), String> {
    let separated_root = window.state::<crate::state::AppPaths>().separated.clone();
    for key in cache_key_variants(&path) {
        let cache = separated_root.join(urlencoding::encode(&key).to_string());
        if cache.exists() {
            crate::mr_cache::delete_mr_stems(&cache).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
