use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering, AtomicU32, AtomicU64};
use std::path::PathBuf;
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sha2::{Digest, Sha256};
use tauri::{Emitter, WebviewWindow, Manager};
use tokio::sync::oneshot;

use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use crate::model_manager::{ModelManager, ModelSpec};
use crate::youtube::YoutubeManager;
use crate::audio_player::sys_log;
use crate::youtube_url::normalize_cache_key;
use super::{EngineLifecycle, SeparationProgress, ROFORMER_ENGINE, ENGINE_MODEL_ID, AI_QUEUE_LOCK, ACTIVE_SEPARATIONS, MODEL_INIT_LOCK, MODEL_INIT_COOLDOWN_UNTIL, log_resource_snapshot, mark_engine_used, release_cached_engine, schedule_engine_idle_release, set_engine_lifecycle};

static MODEL_INIT_ATTEMPT_SEQ: AtomicU64 = AtomicU64::new(1);
static MODEL_INIT_INFLIGHT: AtomicU32 = AtomicU32::new(0);
static MODEL_INIT_TIMEOUT_STREAK: AtomicU32 = AtomicU32::new(0);

/// Ensures every terminal path (success, error, cancellation, or panic unwind)
/// removes the task and starts the same idle GPU cleanup policy.
struct ActiveSeparationGuard {
    normalized_path: String,
}

impl Drop for ActiveSeparationGuard {
    fn drop(&mut self) {
        ACTIVE_SEPARATIONS.lock().remove(&self.normalized_path);
        schedule_engine_idle_release();
    }
}

pub struct SeparationTask {
    window: WebviewWindow,
    path: String,
    cache_dir: PathBuf,
    /// Per-request model choice (e.g. "빠른 분리" vs "고품질 분리" from the
    /// separation-method picker). None falls back to the global
    /// `active_model_id` setting. Captured at enqueue time so later changes
    /// to the global setting don't retroactively affect queued tasks.
    model_override: Option<String>,
    /// Optional second-pass model that splits the combined vocal into
    /// lead/backing stems. It must use the dedicated karaoke preset.
    harmony_model_override: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::SeparationTask;

    fn test_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "osw-separation-task-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn publishes_lead_and_backing_as_one_complete_pair() {
        let dir = test_dir("publish");
        std::fs::create_dir_all(&dir).unwrap();
        let tmp_lead = dir.join("tmp-lead.wav");
        let tmp_backing = dir.join("tmp-backing.wav");
        let lead = dir.join("lead_vocal.wav");
        let backing = dir.join("backing_vocal.wav");
        std::fs::write(&tmp_lead, b"new lead").unwrap();
        std::fs::write(&tmp_backing, b"new backing").unwrap();
        std::fs::write(&lead, b"old lead").unwrap();
        std::fs::write(&backing, b"old backing").unwrap();

        SeparationTask::publish_harmony_stems(&tmp_lead, &tmp_backing, &lead, &backing).unwrap();

        assert_eq!(std::fs::read(&lead).unwrap(), b"new lead");
        assert_eq!(std::fs::read(&backing).unwrap(), b"new backing");
        assert!(!dir.join("lead_vocal.wav.part").exists());
        assert!(!dir.join("backing_vocal.wav.part").exists());
        assert!(!dir.join("lead_vocal.wav.bak").exists());
        assert!(!dir.join("backing_vocal.wav.bak").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cached_base_requires_the_same_model_id() {
        let dir = test_dir("cache-model");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("separation_info.json"),
            r#"{"schemaVersion":2,"modelId":"base-a","base":{"status":"finished","vocalFile":"vocal.wav","instrumentalFile":"inst.wav"}}"#,
        ).unwrap();
        std::fs::write(dir.join("vocal.wav"), b"vocal").unwrap();
        std::fs::write(dir.join("inst.wav"), b"inst").unwrap();
        assert!(SeparationTask::cached_base_matches(&dir, "base-a"));
        assert!(!SeparationTask::cached_base_matches(&dir, "base-b"));
        std::fs::remove_file(dir.join("vocal.wav")).unwrap();
        assert!(!SeparationTask::cached_base_matches(&dir, "base-a"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

impl SeparationTask {
    fn model_init_timeout_secs() -> u64 {
        90
    }

    pub fn new(
        window: WebviewWindow,
        path: String,
        cache_dir: PathBuf,
        model_override: Option<String>,
        harmony_model_override: Option<String>,
    ) -> Self {
        Self { window, path, cache_dir, model_override, harmony_model_override }
    }

    /// Orchestrates the entire separation process.
    pub async fn run(self) {
        let window = self.window;
        let path = self.path;
        let cache_dir = self.cache_dir;
        let harmony_model_id = self.harmony_model_override;
        // Resolve the model for this task once, up front: explicit override
        // (per-request 속도/품질 choice) wins, else the global setting.
        let task_model_id = self.model_override.unwrap_or_else(Self::read_active_model_id);
        let task_model_name = Self::model_name_for(&task_model_id);
        let mut base_actual_model_id = task_model_id.clone();

        // 1. Normalize path and register in active map immediately to prevent duplicates.
        // Must match the exact same normalization `cancel_separation`/`start_mr_separation`
        // use (model_commands.rs), or a cancel request for a queued-but-not-yet-started
        // task silently misses its `ACTIVE_SEPARATIONS`/`CANCEL_REQUESTS` entry (this was
        // previously a bare backslash replace, which diverges from `normalize_cache_key`
        // for YouTube URLs — e.g. `youtu.be/...` short links or `watch?v=...&list=...`
        // links — letting a "cancelled" queued job start anyway once its turn came up).
        let norm_p = normalize_cache_key(&path);

        // If a cancel was already requested before the task reached this point, abort immediately.
        if crate::audio_player::CANCEL_REQUESTS.lock().remove(&norm_p) {
            window.emit("separation-progress", SeparationProgress {
                path: path.clone(),
                percentage: 0.0,
                status: "Cancelled".into(),
                provider: "SYSTEM".into(),
                model: task_model_name.clone(),
            }).ok();
            return;
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut active = ACTIVE_SEPARATIONS.lock();
            active.insert(norm_p.clone(), (path.clone(), cancel_flag.clone()));
        }
        let _active_guard = ActiveSeparationGuard { normalized_path: norm_p.clone() };

        // 2. Initial status: Queued (Waiting for Lock)
        let default_model = task_model_name.clone();
        window.emit("separation-progress", SeparationProgress {
            path: path.clone(),
            percentage: 0.0,
            status: "Queued".into(),
            provider: "SYSTEM".into(),
            model: default_model.clone(),
        }).ok();

        // 3. Wait for Global AI Queue Lock (One task at a time)
        let queue_wait_started = std::time::Instant::now();
        let _permit = AI_QUEUE_LOCK.lock().await;
        sys_log(&format!(
            "[AI-QUEUE] lock acquired: wait_ms={}, active_separations={}",
            queue_wait_started.elapsed().as_millis(),
            ACTIVE_SEPARATIONS.lock().len()
        ));

        // 3.1. Check if cancelled while waiting
        if cancel_flag.load(Ordering::Relaxed) {
            return; // Already removed from map by cancel_separation
        }

        let existing_pair = crate::mr_cache::resolve_mr_pair(&cache_dir);
        let reuse_base = harmony_model_id.is_some()
            && existing_pair.is_some()
            && Self::cached_base_matches(&cache_dir, &task_model_id);
        let base_result = if reuse_base {
            sys_log("[AI-ENGINE] Existing vocal/inst pair reused for harmony pass");
            existing_pair.unwrap()
        } else {
            let engine = match Self::ensure_engine(&window, &path, &task_model_id, true).await {
                Ok(e) => e,
                Err(_) => { ACTIVE_SEPARATIONS.lock().remove(&norm_p); return; }
            };
            base_actual_model_id = ENGINE_MODEL_ID.lock().clone().unwrap_or_else(|| task_model_id.clone());
            let source_path = match Self::prepare_source(&window, &path).await {
                Ok(p) => p,
                Err(_) => { ACTIVE_SEPARATIONS.lock().remove(&norm_p); return; }
            };
            window.emit("separation-progress", SeparationProgress {
                path: path.clone(), percentage: 0.0, status: "보컬/반주 분리".into(),
                provider: engine.get_provider(), model: engine.get_model_name(),
            }).ok();
            let progress_end = if harmony_model_id.is_some() { 70.0 } else { 100.0 };
            match Self::execute_pass(
                &window, &path, source_path, cache_dir.clone(), engine.clone(),
                cancel_flag.clone(), 0.0, progress_end, "보컬/반주 분리",
            ).await {
                Ok(pair) => {
                    // A newly generated combined vocal invalidates every old
                    // lead/backing derivative. If pass 2 fails we intentionally
                    // fall back to this clean 2-stem pair.
                    let _ = crate::mr_cache::delete_harmony_stems(&cache_dir);
                    pair
                },
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&cache_dir);
                    Self::emit_pass_error(&window, &path, &e, &engine);
                    let gpu_removed = Self::is_gpu_device_removed_error(&e);
                    drop(engine);
                    if gpu_removed {
                        release_cached_engine("gpu-device-removed").await;
                    }
                    ACTIVE_SEPARATIONS.lock().remove(&norm_p);
                    return;
                }
            }
        };

        let mut harmony_info = None;
        if let Some(harmony_id) = harmony_model_id.as_deref() {
            // Do not keep the first large model resident while loading the
            // second one. `base_result` is already safely written to disk.
            release_cached_engine("switch-to-harmony").await;
            match Self::ensure_engine(&window, &path, harmony_id, false).await {
                Ok(harmony_engine) => {
                    let temp_dir = cache_dir.join("._harmony_tmp");
                    let _ = std::fs::remove_dir_all(&temp_dir);
                    let result = Self::execute_pass(
                        &window, &path, base_result.0.clone(), temp_dir.clone(),
                        harmony_engine.clone(), cancel_flag.clone(), 70.0, 100.0,
                        "리드/화음 분리",
                    ).await;
                    match result {
                        Ok((tmp_lead, tmp_backing)) => {
                            match harmony_engine.validate_harmony_stems(&base_result.0, &tmp_lead, &tmp_backing) {
                                Ok(metrics) => {
                                    let format = crate::mr_cache::current_format();
                                    let (lead, backing) = crate::mr_cache::harmony_output_paths_for(&cache_dir, format);
                                    if let Err(e) = Self::publish_harmony_stems(&tmp_lead, &tmp_backing, &lead, &backing) {
                                        harmony_info = Some(serde_json::json!({ "status": "failed", "reason": e }));
                                    } else {
                                        sys_log(&format!(
                                            "[AI-ENGINE] Harmony validation: lead_ratio={:.4}, backing_ratio={:.4}, reconstruction_error={:.4}",
                                            metrics.0, metrics.1, metrics.2
                                        ));
                                        harmony_info = Some(serde_json::json!({
                                            "status": "finished", "modelId": harmony_id,
                                            "modelName": harmony_engine.get_model_name(),
                                            "provider": harmony_engine.get_provider(),
                                            "leadFile": lead.file_name().and_then(|x| x.to_str()),
                                            "backingFile": backing.file_name().and_then(|x| x.to_str()),
                                            "leadEnergyRatio": metrics.0,
                                            "backingEnergyRatio": metrics.1,
                                            "reconstructionError": metrics.2,
                                        }));
                                    }
                                }
                                Err(e) => {
                                    let reason = e.to_string();
                                    sys_log(&format!("[AI-ENGINE] Harmony output rejected by quality gate: {}", reason));
                                    harmony_info = Some(serde_json::json!({
                                        "status": "rejected_quality",
                                        "reason": reason,
                                    }));
                                },
                            }
                        }
                        Err(e) => harmony_info = Some(serde_json::json!({ "status": "failed", "reason": e })),
                    }
                    let _ = std::fs::remove_dir_all(&temp_dir);
                }
                Err(e) => harmony_info = Some(serde_json::json!({ "status": "failed", "reason": e })),
            }
        }

        // A cancelled second pass must not be reported as a successful base
        // separation with a harmony warning. The first-pass files remain
        // valid and reusable, but this request itself ended by cancellation.
        if cancel_flag.load(Ordering::Relaxed) {
            window.emit("separation-progress", SeparationProgress {
                path: path.clone(), percentage: 0.0, status: "Cancelled".into(),
                provider: "SYSTEM".into(), model: task_model_name,
            }).ok();
            ACTIVE_SEPARATIONS.lock().remove(&norm_p);
            return;
        }

        let base_spec = Self::model_name_for(&base_actual_model_id);
        let base_model_file = Self::model_file_metadata(&window, &base_actual_model_id).await;
        if let Some(harmony_id) = harmony_model_id.as_deref() {
            if let Some(object) = harmony_info.as_mut().and_then(|v| v.as_object_mut()) {
                object.entry("modelId").or_insert_with(|| serde_json::json!(harmony_id));
                object.entry("modelName").or_insert_with(|| serde_json::json!(Self::model_name_for(harmony_id)));
            }
            if harmony_info.as_ref().and_then(|v| v.get("status")).and_then(|v| v.as_str()) == Some("finished") {
                let model_file = Self::model_file_metadata(&window, harmony_id).await;
                if let Some(object) = harmony_info.as_mut().and_then(|v| v.as_object_mut()) {
                    object.insert("modelFile".into(), model_file);
                }
            }
        }
        Self::write_separation_info(
            &cache_dir, &base_actual_model_id, &base_spec, "local", &base_result,
            base_model_file, harmony_info.as_ref(),
        );
        let harmony_failed = harmony_info.as_ref()
            .and_then(|v| v.get("status"))
            .and_then(|v| v.as_str())
            .map(|status| status != "finished")
            .unwrap_or(false);
        window.emit("separation-progress", SeparationProgress {
            path: path.clone(), percentage: 100.0, status: "Finished".into(),
            provider: "local".into(),
            model: if harmony_failed { format!("{} · 화음 분리 실패", base_spec) } else { base_spec },
        }).ok();
        ACTIVE_SEPARATIONS.lock().remove(&norm_p);
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn read_active_model_id() -> String {
        let db = crate::state::DB.lock();
        db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0))
            .unwrap_or_else(|_| crate::state::DEFAULT_MODEL_ID.to_string())
    }

    fn model_name_for(model_id: &str) -> String {
        crate::model_manager::ModelManager::spec_from_id(model_id)
            .map(|spec| spec.name)
            .unwrap_or_else(|_| crate::state::MODELS[0].1.to_string())
    }

    /// Returns the cached engine only if it was built with `wanted_model_id`;
    /// a per-task model override can differ from whatever the cache holds, in
    /// which case the stale engine is dropped so it gets rebuilt below.
    fn cached_engine_for(wanted_model_id: &str) -> Option<Arc<dyn InferenceEngine>> {
        let engine_guard = ROFORMER_ENGINE.lock();
        let engine = engine_guard.as_ref()?;
        let id_guard = ENGINE_MODEL_ID.lock();
        match id_guard.as_deref() {
            Some(cached_id) if cached_id == wanted_model_id => {
                mark_engine_used();
                Some(engine.clone())
            },
            _ => None,
        }
    }

    async fn ensure_engine(window: &WebviewWindow, path: &str, wanted_model_id: &str, emit_errors: bool) -> Result<Arc<dyn InferenceEngine>, String> {
        if let Some(engine) = Self::cached_engine_for(wanted_model_id) {
            return Ok(engine);
        }

        // Single-flight model init: one initializer at a time across all tasks.
        let init_lock_wait_started = std::time::Instant::now();
        let _init_guard = MODEL_INIT_LOCK.lock().await;
        sys_log(&format!(
            "[AI-ENGINE] model-init lock acquired: wait_ms={}, inflight_init_tasks={}",
            init_lock_wait_started.elapsed().as_millis(),
            MODEL_INIT_INFLIGHT.load(Ordering::Relaxed)
        ));

        // Re-check after waiting for lock in case another task initialized it
        // (only usable if it was built with the model this task wants).
        if let Some(engine) = Self::cached_engine_for(wanted_model_id) {
            return Ok(engine);
        }

        // The queue lock guarantees no separation pass is using the cached
        // engine here. Free an incompatible GPU session before loading the
        // replacement, otherwise both large models can coexist temporarily.
        let cached_model_id = ENGINE_MODEL_ID.lock().clone();
        if cached_model_id.as_deref().is_some_and(|id| id != wanted_model_id) {
            let stale_engine = ROFORMER_ENGINE.lock().take();
            *ENGINE_MODEL_ID.lock() = None;
            if let Some(stale_engine) = stale_engine {
                sys_log(&format!(
                    "[AI-ENGINE] Releasing incompatible cached model before load: old={}, new={}",
                    cached_model_id.as_deref().unwrap_or("unknown"),
                    wanted_model_id
                ));
                let _ = tokio::task::spawn_blocking(move || drop(stale_engine)).await;
            }
        }

        let now = Self::now_secs();
        let cooldown_until = MODEL_INIT_COOLDOWN_UNTIL.load(Ordering::Relaxed);
        if cooldown_until > now {
            let wait_sec = cooldown_until - now;
            let err = format!(
                "Error: 모델 초기화 재시도 대기 중 ({}초 후 가능). 앱 재시작 또는 모델 재다운로드를 권장합니다.",
                wait_sec
            );
            if emit_errors { Self::emit_error(window, path, &err, "SYSTEM", &Self::model_name_for(wanted_model_id)); }
            return Err(err);
        }

        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: "AI 모델 로딩 중...".into(),
            provider: "SYSTEM".into(),
            model: Self::model_name_for(wanted_model_id),
        }).ok();

        let app = window.app_handle();
        let manager = ModelManager::new(app);
        let primary_model_id = wanted_model_id.to_string();
        let mut attempt_specs: Vec<ModelSpec> = Vec::new();
        if let Ok(primary_spec) = ModelManager::spec_from_id(&primary_model_id) {
            attempt_specs.push(primary_spec);
        }
        let harmony_only = crate::custom_models::get(&primary_model_id)
            .map(|model| crate::custom_models::is_harmony_preset(&model.preset_key))
            .unwrap_or(false);
        if !harmony_only {
            if let Some(fallback_spec) = ModelManager::fallback_spec(&primary_model_id) {
                if attempt_specs.iter().all(|s| s.id != fallback_spec.id) {
                    attempt_specs.push(fallback_spec);
                }
            }
        }

        // 이미 오염됐다면 파일 확인·다운로드까지 갈 필요가 없다. 무엇을 해도
        // 세션을 못 만드는 상태라, 재시작만이 답이라는 걸 바로 알린다.
        if crate::onnx_engine::ort_runtime_broken() {
            return Err(crate::onnx_engine::ORT_BROKEN_MSG.to_string());
        }

        let mut last_error = String::new();
        for (idx, spec) in attempt_specs.iter().enumerate() {
            if idx > 0 {
                window.emit("separation-progress", SeparationProgress {
                    path: path.to_string(),
                    percentage: 0.0,
                    status: format!("Fallback 모델 시도 중... ({})", spec.name),
                    provider: "SYSTEM".into(),
                    model: spec.name.clone(),
                }).ok();
            }

            match manager.ensure_model_by_id(app, &spec.id).await {
                Ok(resolution) => {
                    let attempt_id = MODEL_INIT_ATTEMPT_SEQ.fetch_add(1, Ordering::Relaxed);
                    let file_size = resolution.path.metadata().map(|m| m.len()).unwrap_or(0);
                    sys_log(&format!(
                        "[AI-ENGINE] Init start: attempt={}, id={}, source={}, path={:?}, size={} bytes",
                        attempt_id,
                        resolution.spec.id,
                        resolution.source,
                        resolution.path,
                        file_size
                    ));

                    let model_path_for_spawn = resolution.path.clone();
                    let model_id_for_spawn = resolution.spec.id.clone();
                    let model_params_for_spawn = resolution.spec.params.clone();
                    let init_started = std::time::Instant::now();
                    // Large raw-waveform models (Mel-Band RoFormer, ~1GB) can
                    // take far longer than 90s to load onto the GPU.
                    let timeout_secs = if resolution.spec.params.as_ref()
                        .map_or(false, |p| p.engine == crate::vocal_remover::EngineKind::RawWaveform)
                    {
                        300
                    } else {
                        Self::model_init_timeout_secs()
                    };
                    let spawn_wait_started = std::time::Instant::now();
                    MODEL_INIT_INFLIGHT.fetch_add(1, Ordering::Relaxed);
                    set_engine_lifecycle(EngineLifecycle::Loading, Some(&resolution.spec.id));
                    log_resource_snapshot("model-load-start", Some(&resolution.spec.id));
                    sys_log(&format!(
                        "[AI-ENGINE] Init spawn: attempt={}, timeout_secs={}, inflight_now={}",
                        attempt_id,
                        timeout_secs,
                        MODEL_INIT_INFLIGHT.load(Ordering::Relaxed)
                    ));
                    let mut init_handle = tokio::task::spawn_blocking(move || {
                        WaveformRemover::new_with_params(&model_path_for_spawn, Some(&model_id_for_spawn), model_params_for_spawn)
                    });
                    let timed_wait = tokio::time::timeout(
                        Duration::from_secs(timeout_secs),
                        &mut init_handle,
                    ).await;
                    let (init_result, exceeded_soft_limit) = match timed_wait {
                        Ok(result) => (result, false),
                        Err(_) => {
                            // spawn_blocking cannot be cancelled. Starting a
                            // fallback here used to overlap two ORT loaders.
                            // Keep the init lock and wait for this one loader.
                            let status = format!(
                                "모델 로딩이 {}초를 넘었습니다. 중복 로딩을 막기 위해 현재 로딩을 기다립니다.",
                                timeout_secs
                            );
                            sys_log(&format!(
                                "[AI-ENGINE] Init soft timeout: attempt={}, id={}, timeout_secs={}; waiting for same loader",
                                attempt_id, resolution.spec.id, timeout_secs
                            ));
                            let _ = window.emit("separation-progress", SeparationProgress {
                                path: path.to_string(), percentage: 0.0, status,
                                provider: "SYSTEM".into(), model: resolution.spec.name.clone(),
                            });
                            (init_handle.await, true)
                        }
                    };
                    let inflight_after_wait = MODEL_INIT_INFLIGHT.fetch_sub(1, Ordering::Relaxed).saturating_sub(1);
                    sys_log(&format!(
                        "[AI-ENGINE] Init wait done: attempt={}, wait_ms={}, inflight_now={}, exceeded_soft_limit={}",
                        attempt_id,
                        spawn_wait_started.elapsed().as_millis(),
                        inflight_after_wait,
                        exceeded_soft_limit
                    ));

                    match init_result {
                        Ok(join_res) => match join_res {
                            Ok(remover) => {
                                MODEL_INIT_TIMEOUT_STREAK.store(0, Ordering::Relaxed);
                                sys_log(&format!(
                                    "[AI-ENGINE] Init success: attempt={}, id={}, elapsed_ms={}",
                                    attempt_id,
                                    resolution.spec.id,
                                    init_started.elapsed().as_millis()
                                ));
                                let engine_arc = Arc::new(remover);
                                let mut guard = ROFORMER_ENGINE.lock();
                                *guard = Some(engine_arc.clone());
                                *ENGINE_MODEL_ID.lock() = Some(resolution.spec.id.clone());
                                set_engine_lifecycle(EngineLifecycle::Ready, Some(&resolution.spec.id));
                                log_resource_snapshot("model-load-done", Some(&resolution.spec.id));
                                mark_engine_used();
                                MODEL_INIT_COOLDOWN_UNTIL.store(0, Ordering::Relaxed);
                                return Ok(engine_arc);
                            }
                            Err(e) => {
                                last_error = format!("모델 초기화 실패 ({}): {}", resolution.spec.name, e);
                                sys_log(&format!("[AI-ENGINE] {}", last_error));
                                set_engine_lifecycle(EngineLifecycle::Failed, Some(&resolution.spec.id));
                            }
                        },
                        Err(e) => {
                                // ort의 전역 락이 오염되면(앞선 세션 생성이 패닉)
                                // 이 프로세스에서는 어떤 모델도 다시 못 연다.
                                // 폴백 모델을 계속 시도해 봐야 같은 패닉만 반복하고,
                                // 사용자에겐 "Mutex poisoned"만 보인다. 바로 멈춘다.
                                let raw = e.to_string();
                                if crate::onnx_engine::note_possible_ort_poisoning(&raw) {
                                    last_error = crate::onnx_engine::ORT_BROKEN_MSG.to_string();
                                    sys_log(&format!(
                                        "[AI-ENGINE] ONNX 런타임 오염 감지 — 폴백 시도를 중단합니다 ({}): {}",
                                        resolution.spec.name, raw
                                    ));
                                    break;
                                }
                                last_error = format!("모델 로딩 스레드 실패 ({}): {}", resolution.spec.name, e);
                                sys_log(&format!("[AI-ENGINE] {}", last_error));
                                set_engine_lifecycle(EngineLifecycle::Failed, Some(&resolution.spec.id));
                        }
                    }
                }
                Err(e) => {
                    last_error = format!("모델 준비 실패 ({}): {}", spec.name, e);
                    sys_log(&format!("[AI-ENGINE] {}", last_error));
                }
            }
        }

        let err = format!("Error: {}", if last_error.is_empty() { "모델 초기화 실패" } else { &last_error });
        if emit_errors { Self::emit_error(window, path, &err, "SYSTEM", &Self::get_configured_model_name()); }
        Err(err)
    }

    async fn prepare_source(window: &WebviewWindow, path: &str) -> Result<PathBuf, String> {
        if !path.starts_with("http") {
            let p = PathBuf::from(path);
            if !p.exists() {
                let err = "Error: 소스 파일 없음".to_string();
                Self::emit_error(window, path, &err, "SYSTEM", &Self::get_configured_model_name());
                return Err(err);
            }
            return Ok(p);
        }

        // YouTube Handling
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: "다운로드 중... (준비 중)".into(),
            provider: "NETWORK".into(),
            model: Self::get_configured_model_name(),
        }).ok();

        match YoutubeManager::get_video_metadata(path).await {
            Ok(metadata) => {
                let paths = window.state::<crate::state::AppPaths>();
                let temp_dir = paths.temp.clone();
                let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
                
                if final_path.exists() {
                    return Ok(final_path);
                }

                match YoutubeManager::download_audio(window, path, final_path.clone(), true).await {
                    Ok(_) => Ok(final_path),
                    Err(e) => {
                        Self::emit_error(window, path, &format!("YT Error: {}", e), "NETWORK", &Self::get_configured_model_name());
                        Err(e)
                    }
                }
            },
            Err(e) => {
                Self::emit_error(window, path, &format!("YT Metadata Error: {}", e), "NETWORK", &Self::get_configured_model_name());
                Err(e)
            }
        }
    }

    async fn execute_pass(
        window: &WebviewWindow,
        path: &str,
        source_path: PathBuf,
        cache_dir: PathBuf,
        engine: Arc<dyn InferenceEngine>,
        cancel_flag: Arc<AtomicBool>,
        progress_start: f32,
        progress_end: f32,
        stage: &'static str,
    ) -> Result<(PathBuf, PathBuf), String> {
        let window_clone = window.clone();
        let path_clone = path.to_string();
        let cache_dir_clone = cache_dir.clone();
        let engine_info = engine.get_provider();
        let engine_model = engine.get_model_name();
        let engine_for_spawn = engine.clone();
        set_engine_lifecycle(EngineLifecycle::InUse, ENGINE_MODEL_ID.lock().as_deref());

        let (tx, rx) = oneshot::channel::<Result<(PathBuf, PathBuf), String>>();
        // We already have cancel_flag passed in
        let cancel_flag_for_separate = cancel_flag.clone();
        let cancel_flag_for_progress = cancel_flag.clone();

        // High-performance separation thread
        std::thread::spawn(move || {
            let w = window_clone;
            let p_for_progress = path_clone.clone();
            let info = engine_info;
            let model = engine_model;

            let last_percentage = Arc::new(AtomicU32::new(f32::to_bits(-1.0)));
            let last_p_progress = last_percentage.clone();
            let progress_started = std::time::Instant::now();
            let last_emit_ms = Arc::new(AtomicU64::new(0));
            let last_emit_progress = last_emit_ms.clone();

            let w_first = w.clone();
            let path_first = p_for_progress.clone();
            let info_first = info.clone();
            let model_first = model.clone();
            let cancel_first = cancel_flag_for_progress.clone();
            let cancel_separate_first = cancel_flag_for_separate.clone();
            sys_log(&format!("[AI-ENGINE] {} start", stage));
            log_resource_snapshot("separation-start", ENGINE_MODEL_ID.lock().as_deref());
            let separation_result = engine_for_spawn.separate(
                &source_path,
                &cache_dir_clone,
                cancel_separate_first,
                Box::new(move |percentage| {
                    if cancel_first.load(Ordering::Relaxed) { return; }
                    
                    let last = f32::from_bits(last_p_progress.load(Ordering::Relaxed));
                    let now_ms = progress_started.elapsed().as_millis() as u64;
                    let previous_ms = last_emit_progress.load(Ordering::Relaxed);
                    let terminal = percentage >= 100.0 || percentage <= 0.0;
                    if ((percentage - last).abs() >= 0.5 && now_ms.saturating_sub(previous_ms) >= 100) || terminal {
                        last_p_progress.store(f32::to_bits(percentage), Ordering::Relaxed);
                        last_emit_progress.store(now_ms, Ordering::Relaxed);
                        let mapped = progress_start + (percentage.clamp(0.0, 100.0) / 100.0) * (progress_end - progress_start);
                        let _ = w_first.emit("separation-progress", SeparationProgress {
                            path: path_first.clone(),
                            percentage: mapped,
                            status: stage.into(),
                            provider: info_first.clone(),
                            model: model_first.clone(),
                        });
                    }
                })
            ).map_err(|e| e.to_string());

            if let Err(e) = &separation_result {
                sys_log(&format!("[AI-ENGINE] Separation failed: {}", e));
            }
            log_resource_snapshot("separation-done", ENGINE_MODEL_ID.lock().as_deref());

            let _ = tx.send(separation_result);
        });
        rx.await.map_err(|_| "Process panicked".to_string())?
    }

    fn emit_pass_error(window: &WebviewWindow, path: &str, e: &str, engine: &Arc<dyn InferenceEngine>) {
        let status = if e.contains("Cancelled") { "Cancelled".to_string() }
        else if Self::is_gpu_device_removed_error(e) {
            set_engine_lifecycle(EngineLifecycle::Failed, ENGINE_MODEL_ID.lock().as_deref());
            "Error: GPU 처리 중 그래픽 드라이버가 응답하지 않아 중단되었습니다.".to_string()
        } else { format!("Error: {}", e) };
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(), percentage: 0.0, status,
            provider: engine.get_provider(), model: engine.get_model_name(),
        }).ok();
    }

    fn publish_harmony_stems(tmp_lead: &PathBuf, tmp_backing: &PathBuf, lead: &PathBuf, backing: &PathBuf) -> Result<(), String> {
        let lead_part = lead.with_extension(format!("{}.part", lead.extension().and_then(|x| x.to_str()).unwrap_or("wav")));
        let backing_part = backing.with_extension(format!("{}.part", backing.extension().and_then(|x| x.to_str()).unwrap_or("wav")));
        let lead_backup = lead.with_extension(format!("{}.bak", lead.extension().and_then(|x| x.to_str()).unwrap_or("wav")));
        let backing_backup = backing.with_extension(format!("{}.bak", backing.extension().and_then(|x| x.to_str()).unwrap_or("wav")));
        for stale in [&lead_part, &backing_part, &lead_backup, &backing_backup] {
            if stale.is_file() { let _ = std::fs::remove_file(stale); }
        }
        let had_lead = lead.is_file();
        let had_backing = backing.is_file();

        let publish_result = (|| -> Result<(), String> {
            std::fs::copy(tmp_lead, &lead_part).map_err(|e| e.to_string())?;
            std::fs::copy(tmp_backing, &backing_part).map_err(|e| e.to_string())?;
            if lead.is_file() { std::fs::rename(lead, &lead_backup).map_err(|e| e.to_string())?; }
            if backing.is_file() { std::fs::rename(backing, &backing_backup).map_err(|e| e.to_string())?; }
            std::fs::rename(&lead_part, lead).map_err(|e| e.to_string())?;
            std::fs::rename(&backing_part, backing).map_err(|e| e.to_string())?;
            Ok(())
        })();

        if let Err(error) = publish_result {
            // Restore the last complete pair if either final rename failed.
            if lead_backup.is_file() {
                if lead.is_file() { let _ = std::fs::remove_file(lead); }
                let _ = std::fs::rename(&lead_backup, lead);
            } else if !had_lead && lead.is_file() {
                let _ = std::fs::remove_file(lead);
            }
            if backing_backup.is_file() {
                if backing.is_file() { let _ = std::fs::remove_file(backing); }
                let _ = std::fs::rename(&backing_backup, backing);
            } else if !had_backing && backing.is_file() {
                let _ = std::fs::remove_file(backing);
            }
            let _ = std::fs::remove_file(&lead_part);
            let _ = std::fs::remove_file(&backing_part);
            return Err(error);
        }
        let _ = std::fs::remove_file(&lead_backup);
        let _ = std::fs::remove_file(&backing_backup);
        if let Some(dir) = lead.parent() {
            for name in ["lead_vocal_dr.mp3", "lead_vocal_dr.wav"] {
                let stale = dir.join(name);
                if stale.is_file() { let _ = std::fs::remove_file(stale); }
            }
        }
        Ok(())
    }

    fn cached_base_matches(cache_dir: &PathBuf, model_id: &str) -> bool {
        let path = cache_dir.join("separation_info.json");
        let Ok(raw) = std::fs::read_to_string(path) else { return false; };
        let Ok(info) = serde_json::from_str::<serde_json::Value>(&raw) else { return false; };
        if info.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0) < 2
            || info.get("modelId").and_then(|v| v.as_str()) != Some(model_id)
        {
            return false;
        }
        let Some(base) = info.get("base") else { return false; };
        if base.get("status").and_then(|v| v.as_str()) != Some("finished") {
            return false;
        }
        let Some(vocal_file) = base.get("vocalFile").and_then(|v| v.as_str()) else { return false; };
        let Some(inst_file) = base.get("instrumentalFile").and_then(|v| v.as_str()) else { return false; };
        cache_dir.join(vocal_file).is_file() && cache_dir.join(inst_file).is_file()
    }

    async fn model_file_metadata(window: &WebviewWindow, model_id: &str) -> serde_json::Value {
        let app = window.app_handle();
        let manager = ModelManager::new(app);
        let Some(resolution) = ModelManager::spec_from_id(model_id).ok()
            .and_then(|spec| manager.resolve_model_path(app, &spec)) else {
            return serde_json::Value::Null;
        };
        let path = resolution.path;
        let source = resolution.source;
        let filename = path.file_name().and_then(|v| v.to_str()).unwrap_or_default().to_string();
        let size_bytes = path.metadata().map(|m| m.len()).unwrap_or(0);
        let hash_path = path.clone();
        let sha256 = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let mut file = std::fs::File::open(&hash_path).map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if read == 0 { break; }
                hasher.update(&buffer[..read]);
            }
            Ok(format!("{:x}", hasher.finalize()))
        }).await.ok().and_then(Result::ok);
        sys_log(&format!(
            "[AI-ENGINE] Model fingerprint: id={}, file={}, size={}, sha256={}",
            model_id, filename, size_bytes, sha256.as_deref().unwrap_or("unavailable")
        ));
        serde_json::json!({
            "filename": filename,
            "sizeBytes": size_bytes,
            "sha256": sha256,
            "source": source,
        })
    }

    /// Persists which model produced this song's separated stems, next to the
    /// stems themselves (`separation_info.json` in the cache dir). Failure is
    /// non-fatal — this is informational metadata only.
    fn write_separation_info(
        cache_dir: &PathBuf,
        model_id: &str,
        model_name: &str,
        provider: &str,
        base_files: &(PathBuf, PathBuf),
        model_file: serde_json::Value,
        harmony: Option<&serde_json::Value>,
    ) {
        let completed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let info = serde_json::json!({
            "schemaVersion": 2,
            "modelId": model_id,
            "modelName": model_name,
            "provider": provider,
            "completedAt": completed_at,
            "base": {
                "status": "finished",
                "vocalFile": base_files.0.file_name().and_then(|x| x.to_str()),
                "instrumentalFile": base_files.1.file_name().and_then(|x| x.to_str()),
                "modelFile": model_file,
            },
            "harmony": harmony,
        });
        let path = cache_dir.join("separation_info.json");
        if let Err(e) = std::fs::write(&path, info.to_string()) {
            sys_log(&format!("[AI-ENGINE] Failed to write separation info: {}", e));
        }
    }

    /// Detects the DXGI/D3D "device removed" family of errors that ONNX
    /// Runtime's DirectML EP surfaces when the Windows TDR watchdog kills a
    /// GPU dispatch that ran too long. HRESULT 887A0005 is
    /// DXGI_ERROR_DEVICE_REMOVED; the accompanying message may be mangled by
    /// console codepage translation, so match on the stable hex code instead
    /// of the localized text.
    fn is_gpu_device_removed_error(e: &str) -> bool {
        e.contains("887A0005")
            || e.contains("DXGI_ERROR_DEVICE_REMOVED")
            || e.contains("DXGI_ERROR_DEVICE_HUNG")
    }

    fn emit_error(window: &WebviewWindow, path: &str, message: &str, provider: &str, model: &str) {
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: message.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
        }).ok();
    }

    fn get_configured_model_name() -> String {
        let model_id = {
            let db = crate::state::DB.lock();
            db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0)).unwrap_or_else(|_| crate::state::DEFAULT_MODEL_ID.to_string())
        };

        crate::model_manager::ModelManager::spec_from_id(&model_id)
            .map(|spec| spec.name)
            .unwrap_or_else(|_| crate::state::MODELS[0].1.to_string())
    }
}
