use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use std::collections::HashMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
// use tauri::{Emitter, WebviewWindow, Manager, AppHandle};
// use std::path::{Path, PathBuf};

use crate::vocal_remover::InferenceEngine;
// use crate::audio_player::{Status, PlaybackStatus, sys_log};

// AI Engine Management
pub static ROFORMER_ENGINE: Lazy<Mutex<Option<Arc<dyn InferenceEngine>>>> = Lazy::new(|| Mutex::new(None));
/// Which model id built the currently cached `ROFORMER_ENGINE`. Needed since
/// per-task model overrides (속도/품질 선택) can request a different model
/// than whatever the cache was built with — consulted only on cache hits.
pub static ENGINE_MODEL_ID: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
pub static AI_QUEUE_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
pub static MODEL_INIT_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
pub static MODEL_INIT_COOLDOWN_UNTIL: AtomicU64 = AtomicU64::new(0);
pub static ACTIVE_SEPARATIONS: Lazy<Mutex<HashMap<String, (String, Arc<AtomicBool>)>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub static BROADCAST_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub static PLAYBACK_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_playback_active(active: bool) {
    let previous = PLAYBACK_ACTIVE.swap(active, Ordering::Relaxed);
    if previous != active {
        crate::audio_player::sys_log(&format!(
            "[AI-ENGINE] Adaptive priority: playback_active={}, live_priority={}",
            active,
            live_priority_active()
        ));
    }
}

pub fn live_priority_active() -> bool {
    PLAYBACK_ACTIVE.load(Ordering::Relaxed) || BROADCAST_MODE.load(Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineLifecycle {
    Unloaded,
    Loading,
    Ready,
    InUse,
    Releasing,
    Failed,
}

pub static ENGINE_LIFECYCLE: Lazy<Mutex<EngineLifecycle>> =
    Lazy::new(|| Mutex::new(EngineLifecycle::Unloaded));

pub fn set_engine_lifecycle(next: EngineLifecycle, model_id: Option<&str>) {
    let mut state = ENGINE_LIFECYCLE.lock();
    if *state == next { return; }
    crate::audio_player::sys_log(&format!(
        "[AI-ENGINE] Lifecycle: {:?} -> {:?}, model={}",
        *state, next, model_id.unwrap_or("unknown")
    ));
    *state = next;
}

#[cfg(windows)]
pub fn log_resource_snapshot(stage: &str, model_id: Option<&str>) {
    #[repr(C)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn K32GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut ProcessMemoryCountersEx,
            size: u32,
        ) -> i32;
    }

    let mut counters: ProcessMemoryCountersEx = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<ProcessMemoryCountersEx>() as u32;
    let ok = unsafe {
        K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb)
    } != 0;
    if ok {
        crate::audio_player::sys_log(&format!(
            "PERF: [AI-RESOURCE] stage={}, model={}, working_set_mb={:.1}, private_mb={:.1}, peak_working_set_mb={:.1}",
            stage,
            model_id.unwrap_or("unknown"),
            counters.working_set_size as f64 / 1_048_576.0,
            counters.private_usage as f64 / 1_048_576.0,
            counters.peak_working_set_size as f64 / 1_048_576.0,
        ));
    }
}

#[cfg(not(windows))]
pub fn log_resource_snapshot(_stage: &str, _model_id: Option<&str>) {}

/// Invalidates stale idle-release timers whenever the cached engine is used or
/// a new cleanup timer is scheduled.
static ENGINE_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
const ENGINE_IDLE_RELEASE_SECS: u64 = 15;

/// Drop the process-global ONNX session away from Tokio's async workers and
/// wait for provider teardown before another model may be created.
pub async fn release_cached_engine(reason: &str) {
    mark_engine_used();
    let engine = ROFORMER_ENGINE.lock().take();
    let model_id = ENGINE_MODEL_ID.lock().take();
    let Some(engine) = engine else { return; };

    let started = std::time::Instant::now();
    set_engine_lifecycle(EngineLifecycle::Releasing, model_id.as_deref());
    log_resource_snapshot("release-start", model_id.as_deref());
    crate::audio_player::sys_log(&format!(
        "[AI-ENGINE] Release start: model={}, reason={}",
        model_id.as_deref().unwrap_or("unknown"), reason
    ));
    let dropped = tokio::task::spawn_blocking(move || drop(engine)).await;
    crate::audio_player::sys_log(&format!(
        "[AI-ENGINE] Release done: model={}, reason={}, elapsed_ms={}, ok={}",
        model_id.as_deref().unwrap_or("unknown"), reason,
        started.elapsed().as_millis(), dropped.is_ok()
    ));
    set_engine_lifecycle(EngineLifecycle::Unloaded, model_id.as_deref());
    log_resource_snapshot("release-done", model_id.as_deref());
}

pub fn mark_engine_used() {
    ENGINE_CACHE_GENERATION.fetch_add(1, Ordering::Relaxed);
}

/// Keep the large GPU model warm briefly for a batch, then release the final
/// process-global Arc once the separation queue is truly empty. Dropping is
/// moved off the async executor because ORT/provider teardown can block.
pub fn schedule_engine_idle_release() {
    let generation = ENGINE_CACHE_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(ENGINE_IDLE_RELEASE_SECS)).await;

        if ENGINE_CACHE_GENERATION.load(Ordering::Relaxed) != generation
            || !ACTIVE_SEPARATIONS.lock().is_empty()
        {
            return;
        }

        crate::audio_player::sys_log(&format!(
            "[AI-ENGINE] Idle cache release requested: grace={}s",
            ENGINE_IDLE_RELEASE_SECS
        ));
        release_cached_engine("idle-timeout").await;
    });
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeparationProgress {
    pub path: String,
    pub percentage: f32,
    pub status: String,
    pub provider: String,
    pub model: String,
}

pub mod task;
