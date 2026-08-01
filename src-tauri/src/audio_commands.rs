use tauri::{Emitter, Manager, WebviewWindow};
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use rodio::Source;
use rodio::source::UniformSourceIterator;
use std::num::{NonZeroU16, NonZeroU32};
use crate::audio_player::{
    AUDIO_HANDLER, StreamingReader, StretchedSource, DynamicVolumeSource, SoftClipSource,
    sys_log
};

/// 소프트 리미터 임계값(이 값 이하는 그대로, 이상은 부드럽게 1.0으로 포화).
const LIMITER_THRESHOLD: f32 = 0.8;
use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState};
use crate::state::DB;
use crate::youtube::YoutubeManager;
use urlencoding;

// --- Global Statics ---
pub static PLAYBACK_VERSION: AtomicU64 = AtomicU64::new(0);

use crate::youtube_url::cache_key_variants;

#[tauri::command]
pub async fn play_track(window: WebviewWindow, path: String, duration_ms: Option<u64>, play_now: Option<bool>) -> Result<u64, String> {
    let path_for_log = path.clone();
    let res = play_track_internal(window.clone(), path, duration_ms, None, play_now.unwrap_or(true)).await;
    if let Err(ref e) = res {
        sys_log(&format!("[AUDIO] play_track failed: path={}, error={}", path_for_log, e));
        let _ = window.emit("playback-status", PlaybackStatus { status: Status::Error, message: e.clone() });
    }
    res
}

pub async fn play_track_internal(window: WebviewWindow, path: String, duration_ms_hint: Option<u64>, start_pos_ms: Option<u64>, play_now: bool) -> Result<u64, String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };
    
    let target_version = PLAYBACK_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
    sys_log(&format!("[DEBUG] play_track_internal Start: version={}, path={}, start_pos={:?}ms", target_version, path, start_pos_ms));
    
    struct PlaybackPreparationGuard;
    impl Drop for PlaybackPreparationGuard {
        fn drop(&mut self) {
            crate::audio_player::IS_PREPARING_PLAYBACK.store(false, Ordering::SeqCst);
        }
    }
    let _prep_guard = PlaybackPreparationGuard;
    crate::audio_player::IS_PREPARING_PLAYBACK.store(true, Ordering::SeqCst);
    
    let msg = if start_pos_ms.is_some() { "Seeking..." } else { "Preparing..." };
    let _ = window.emit("playback-status", PlaybackStatus { status: Status::Pending, message: msg.into() });

    {
        let controller = handler.controller.lock();
        controller.clear();
        sys_log("[AUDIO] Playback Step 1: Controller cleared");
    }
    
    let rate = handler.track_sample_rate.load(Ordering::Relaxed) as f64;
    let start_samples = if let Some(ms) = start_pos_ms {
        (ms as f64 * rate / 1000.0) as u64
    } else {
        0
    };
    handler.current_pos_samples.store(start_samples, Ordering::Relaxed);
    
    if let Some(d) = duration_ms_hint {
        handler.total_duration_ms.store(d, Ordering::Relaxed);
    } else {
        handler.total_duration_ms.store(0, Ordering::Relaxed);
    }
    
    let paths = window.state::<crate::state::AppPaths>();
    
    // Determine the cache directory. 
    let (vocal_path, inst_path) = if path.contains("separated") {
        let p = std::path::PathBuf::from(&path);
        let dir = if p.is_file() {
            p.parent().unwrap_or(&p).to_path_buf()
        } else {
            p
        };
        crate::mr_cache::resolve_mr_pair(&dir).unwrap_or_else(|| {
            crate::mr_cache::mr_output_paths(&dir)
        })
    } else {
        let mut selected = None;
        for key in cache_key_variants(&path) {
            let cache_dir = paths.separated.join(urlencoding::encode(&key).to_string());
            if let Some(pair) = crate::mr_cache::resolve_mr_pair(&cache_dir) {
                selected = Some(pair);
                break;
            }
            if selected.is_none() {
                selected = Some(crate::mr_cache::mr_output_paths(&cache_dir));
            }
        }
        selected.unwrap_or_else(|| {
            let cache_dir = paths.separated.join(urlencoding::encode(&path).to_string());
            crate::mr_cache::mr_output_paths(&cache_dir)
        })
    };
    
    let target_rate = handler.monitor.sample_rate.load(Ordering::Relaxed).max(1);
    let target_channels = (handler.monitor.channels.load(Ordering::Relaxed).max(1)) as u16;
    let target_rate_nz = NonZeroU32::new(target_rate).expect("Invalid sample rate");
    let target_channels_nz = NonZeroU16::new(target_channels).expect("Invalid channels");

    // Case 1: MR Files Exist
    if vocal_path.exists() && inst_path.exists() {
        let is_mr_active = {
            let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
            active.contains(&vocal_path) || active.contains(&inst_path)
        };
        
        if is_mr_active {
            sys_log("[AUDIO] Waiting for active MR separation download/write...");
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        let mut sources = Vec::new();
        for i in 0..5 {
            if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }
            
            match (File::open(&vocal_path), File::open(&inst_path)) {
                (Ok(v), Ok(i)) => {
                    sources.push((v, i));
                    break;
                }
                _ if i < 4 => {
                    sys_log(&format!("[AUDIO] Retry {}/5: Opening MR files ({:?})", i + 1, vocal_path));
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                }
                (Err(e1), _) => return Err(format!("Vocal 파일을 열 수 없습니다: {} (Path: {:?})", e1, vocal_path)),
                (_, Err(e2)) => return Err(format!("Inst 파일을 열 수 없습니다: {} (Path: {:?})", e2, inst_path)),
            }
        }

        let (v_file, i_file) = sources.pop().unwrap();
        
        // [FIX] Get metadata before moving files into decoders
        let i_file_size = i_file.metadata().map(|m| m.len()).unwrap_or(0);
        
        let mut v_decoder = rodio::Decoder::new(BufReader::new(v_file)).map_err(|e| e.to_string())?;
        let mut i_decoder = rodio::Decoder::new(BufReader::new(i_file)).map_err(|e| e.to_string())?;
        
        handler.track_sample_rate.store(v_decoder.sample_rate().into(), Ordering::Relaxed);

        if let Some(ms) = start_pos_ms {
            let _ = v_decoder.try_seek(Duration::from_millis(ms));
            let _ = i_decoder.try_seek(Duration::from_millis(ms));
        }
        
        let ms = if let Some(d) = i_decoder.total_duration() {
            let val = d.as_millis() as u64;
            handler.total_duration_ms.store(val, Ordering::Relaxed);
            val
        } else {
            // Fallback: Estimate duration if metadata fails
            let mut est_ms = 0;
            if i_file_size > 0 && handler.track_sample_rate.load(Ordering::Relaxed) > 0 {
                let rate = handler.track_sample_rate.load(Ordering::Relaxed) as u64;
                let est_sec = i_file_size / (rate * 2 * 2); 
                if est_sec > 0 {
                    est_ms = est_sec * 1000;
                    handler.total_duration_ms.store(est_ms, Ordering::Relaxed);
                    sys_log(&format!("[AUDIO] Estimated duration from file size: {}s", est_sec));
                }
            }
            est_ms
        };

        let mut current_duration = String::new();
        if let Ok(d_str) = DB.lock().query_row("SELECT duration FROM Tracks WHERE path = ?", rusqlite::params![&path], |row| row.get::<_, String>(0)) {
            current_duration = d_str;
        }
        if (current_duration == "0:00" || current_duration.is_empty()) && ms > 0 {
            let secs = ms / 1000;
            let new_duration = format!("{}:{:02}", secs / 60, secs % 60);
            let _ = crate::library::update_track_duration(&path, &new_duration);
            sys_log(&format!("[DB] Updated missing duration for {}: {}", path, new_duration));
        }

        // 메트로놈 파라미터: 곡 길이만큼만(무한 스트림이라 잘라 씀), 시작 위치 정렬.
        let start_ms0 = start_pos_ms.unwrap_or(0);
        let remaining_ms = ms.saturating_sub(start_ms0).max(0);
        // 메트로놈 BPM은 공유 atomic을 쓴다(재생 중 변경을 클릭에 실시간 반영).
        handler.metro_bpm.store(handler.state.lock().metro_bpm.to_bits(), Ordering::Relaxed);
        // 버스별 지연 보정(ms). 해당 버스 믹스 앞에 무음을 붙여 그만큼 늦춘다.
        // 모니터를 늦추면 재생 위치도 함께 늦어져 가사 싱크는 모니터 소리에 계속 맞는다.
        let mon_delay_ms = handler.monitor.delay_ms_val() as u64;
        let mr_delay_ms = handler.mr.delay_ms_val() as u64;

        // --- 모니터 채널 (기존 주 출력) ---
        let stretched_v = StretchedSource::new(v_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), Arc::new(AtomicU64::new(0)));
        let stretched_i = StretchedSource::new(i_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());

        let resampled_v = UniformSourceIterator::new(DynamicVolumeSource::new(stretched_v, handler.vocal_volume.clone()), target_channels_nz, target_rate_nz);
        let resampled_i = UniformSourceIterator::new(DynamicVolumeSource::new(stretched_i, handler.instrumental_volume.clone()), target_channels_nz, target_rate_nz);

        let start_frame_mon = start_ms0.saturating_mul(target_rate as u64) / 1000;
        let metro_mon = crate::audio_player::MetronomeSource::new(handler.metro_bpm.clone(), target_rate, target_channels, start_frame_mon)
            .take_duration(Duration::from_millis(remaining_ms));
        let resampled_metro = UniformSourceIterator::new(DynamicVolumeSource::new(metro_mon, handler.mon_metro_volume.clone()), target_channels_nz, target_rate_nz);

        // 메트로놈은 게인 0이라도 항상 믹스에 포함(라우팅을 atomic으로 실시간 반영).
        let mixed_raw = resampled_i.mix(resampled_v).mix(resampled_metro).delay(Duration::from_millis(mon_delay_ms));
        // 합산 클리핑 방지: 버스 출력 끝단 소프트 리미터.
        let mixed = SoftClipSource::new(mixed_raw, LIMITER_THRESHOLD, handler.limiter_enabled.clone());

        let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
        if final_v != target_version { return Ok(0); }

        {
            let controller = handler.controller.lock();
            controller.append(mixed);
            if play_now {
                controller.play();
            } else {
                controller.pause();
            }
        }

        // --- MR 채널 (2번째 출력, 활성 시) ---
        let mr_active = !handler.mr.device_name.lock().is_empty() && handler.mr_controller.lock().is_some();
        if mr_active {
            // 별도 디코더(소스는 1회 소비되므로 파일을 다시 연다).
            match (File::open(&vocal_path), File::open(&inst_path)) {
                (Ok(v2), Ok(i2)) => {
                    let mr_rate = handler.mr.sample_rate.load(Ordering::Relaxed).max(1);
                    let mr_ch = (handler.mr.channels.load(Ordering::Relaxed).max(1)) as u16;
                    let mr_rate_nz = NonZeroU32::new(mr_rate).expect("mr rate");
                    let mr_ch_nz = NonZeroU16::new(mr_ch).expect("mr ch");

                    match (
                        rodio::Decoder::new(BufReader::new(v2)),
                        rodio::Decoder::new(BufReader::new(i2)),
                    ) {
                        (Ok(mut v_dec2), Ok(mut i_dec2)) => {
                            if let Some(ms0) = start_pos_ms {
                                let _ = v_dec2.try_seek(Duration::from_millis(ms0));
                                let _ = i_dec2.try_seek(Duration::from_millis(ms0));
                            }
                            let sv = StretchedSource::new(v_dec2, handler.active_pitch.clone(), handler.active_tempo.clone(), Arc::new(AtomicU64::new(0)));
                            let si = StretchedSource::new(i_dec2, handler.active_pitch.clone(), handler.active_tempo.clone(), Arc::new(AtomicU64::new(0)));
                            let rv = UniformSourceIterator::new(DynamicVolumeSource::new(sv, handler.mr_vocal_volume.clone()), mr_ch_nz, mr_rate_nz);
                            let ri = UniformSourceIterator::new(DynamicVolumeSource::new(si, handler.mr_inst_volume.clone()), mr_ch_nz, mr_rate_nz);
                            let start_frame_mr = start_ms0.saturating_mul(mr_rate as u64) / 1000;
                            let metro_mr = crate::audio_player::MetronomeSource::new(handler.metro_bpm.clone(), mr_rate, mr_ch, start_frame_mr)
                                .take_duration(Duration::from_millis(remaining_ms));
                            let rm = UniformSourceIterator::new(DynamicVolumeSource::new(metro_mr, handler.mr_metro_volume.clone()), mr_ch_nz, mr_rate_nz);
                            let mr_mixed_raw = ri.mix(rv).mix(rm).delay(Duration::from_millis(mr_delay_ms));
                            let mr_mixed = SoftClipSource::new(mr_mixed_raw, LIMITER_THRESHOLD, handler.limiter_enabled.clone());

                            if let Some(ctrl) = handler.mr_controller.lock().as_ref() {
                                ctrl.clear();
                                ctrl.append(mr_mixed);
                                if play_now { ctrl.play(); } else { ctrl.pause(); }
                            }
                        }
                        _ => sys_log("[AUDIO] MR 채널 디코더 생성 실패 — 모니터만 재생"),
                    }
                }
                _ => sys_log("[AUDIO] MR 채널 파일 열기 실패 — 모니터만 재생"),
            }
        }

        {
            let mut state = handler.state.lock();
            state.current_track = Some(path.clone());
            state.is_playing = play_now;
        }
        
        let status = if play_now { Status::Playing } else { Status::Paused };
        let msg = if play_now { "Playing" } else { "Prepared" };
        window.emit("playback-status", PlaybackStatus { status, message: msg.into() }).unwrap();
        sys_log("[DEBUG] Starting instantaneous playback from local MR cache.");
        return Ok(ms);
    }

    // Case 2: Fallback to Original source
    let play_path = if path.starts_with("http") {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "유튜브 오디오 준비 중...".into() }).ok();
        }
        let metadata = YoutubeManager::get_video_metadata(&path).await?;
        
        if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }

        let temp_dir = window.state::<crate::state::AppPaths>().temp.clone();
        let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
        
        if !final_path.exists() {
            YoutubeManager::download_audio(&window, &path, final_path.clone(), false).await?;
        } else {
            let is_yt_active = {
                let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                active.contains(&final_path)
            };
            
            if is_yt_active {
                sys_log("[AUDIO] YouTube file is being written by another task, waiting...");
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        final_path
    } else {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { status: Status::Decoding, message: "곡 데이터를 읽는 중...".into() }).ok();
        }
        std::path::PathBuf::from(&path)
    };

    if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }

    if !play_path.exists() && !path.starts_with("http") {
        return Err("파일을 찾을 수 없습니다".into());
    }

    let is_yt = path.starts_with("http");
    let mut decoder_result = None;
    let mut first_error_msg = String::new();

    for i in 0..5 {
        if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }

        let reader = match StreamingReader::new(play_path.clone(), is_yt) {
            Ok(r) => r,
            Err(e) => {
                if i < 4 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                    continue;
                }
                return Err(format!("파일을 열 수 없습니다: {}", e));
            }
        };

        match rodio::Decoder::new(std::io::BufReader::new(reader)) {
            Ok(d) => {
                decoder_result = Some(d);
                break;
            }
            Err(e) => {
                first_error_msg = e.to_string();
                if i < 4 {
                    sys_log(&format!("[AUDIO] Decoding retry {}/5...", i + 1));
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                } else {
                    return Err(format!("디코딩 실패: {}", e));
                }
            }
        }
    }
    
    let mut decoder = decoder_result.ok_or_else(|| format!("디코딩 실패: {}", first_error_msg))?;
    
    if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }
    
    handler.track_sample_rate.store(decoder.sample_rate().into(), Ordering::Relaxed);
    if let Some(ms) = start_pos_ms { let _ = decoder.try_seek(Duration::from_millis(ms)); }
    
    if let Some(d) = decoder.total_duration() {
        let ms = d.as_millis() as u64;
        handler.total_duration_ms.store(ms, Ordering::Relaxed);

        let mut current_duration = String::new();
        if let Ok(d_str) = DB.lock().query_row("SELECT duration FROM Tracks WHERE path = ?", rusqlite::params![&path], |row| row.get::<_, String>(0)) {
            current_duration = d_str;
        }
        if current_duration == "0:00" || current_duration.is_empty() {
            let secs = ms / 1000;
            let new_duration = format!("{}:{:02}", secs / 60, secs % 60);
            let _ = crate::library::update_track_duration(&path, &new_duration);
            sys_log(&format!("[DB] Updated missing duration for {}: {}", path, new_duration));
        }
    }

    let stretched = StretchedSource::new(decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
    let dyn_vol = DynamicVolumeSource::new(stretched, handler.instrumental_volume.clone());
    let resampled = UniformSourceIterator::new(dyn_vol, target_channels_nz, target_rate_nz);
    
    let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
    if final_v != target_version { return Ok(0); }
    
    {
        let controller = handler.controller.lock();
        controller.append(resampled);
        if play_now {
            controller.play();
        } else {
            controller.pause();
        }
    }
    
    {
        let mut state = handler.state.lock();
        state.current_track = Some(path.clone());
        state.is_playing = play_now;
    }
    
    let status = if play_now { Status::Playing } else { Status::Paused };
    let msg = if play_now { "Playing" } else { "Prepared" };
    window.emit("playback-status", PlaybackStatus { status, message: msg.into() }).unwrap();
    sys_log("[DEBUG] Starting playback (Original/Fallback)");
    Ok(handler.total_duration_ms.load(Ordering::Relaxed))
}

#[tauri::command]
pub fn set_master_volume(volume: f32) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        let ratio = volume / 125.0;
        let final_vol = ratio * ratio;
        sys_log(&format!("[AUDIO] Master Volume set to: {} (ratio: {:.4})", volume, final_vol));
        controller.set_volume(final_vol);
        // MR 채널이 열려 있으면 함께 적용.
        if let Some(mr) = handler.mr_controller.lock().as_ref() {
            mr.set_volume(final_vol);
        }
        // 장치 전환 후 새 player에 다시 적용할 수 있도록 보관.
        handler.master_gain.store(final_vol.to_bits(), Ordering::Relaxed);
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub name: String,
    pub config: String, // "48000Hz, 2ch"
    pub is_active: bool,
}

/// 사용 가능한 출력 장치 목록. `isActive`는 현재 열려 있는 장치.
#[tauri::command]
pub async fn list_output_devices() -> Result<Vec<OutputDevice>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let active = match &*AUDIO_HANDLER {
        Ok(h) => h.monitor.device_name.lock().clone(),
        Err(_) => String::new(),
    };
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for d in devices {
        if let Ok(desc) = d.description() {
            let name = desc.name().to_string();
            let config = d
                .default_output_config()
                .map(|c| format!("{}Hz, {}ch", u32::from(c.sample_rate()), c.channels()))
                .unwrap_or_else(|_| "N/A".into());
            let is_active = name == active;
            out.push(OutputDevice { name, config, is_active });
        }
    }
    Ok(out)
}

/// 현재 선택된 출력 장치 이름(빈 문자열이면 시스템 기본).
#[tauri::command]
pub fn get_output_device() -> String {
    match &*AUDIO_HANDLER {
        Ok(h) => h.monitor.device_name.lock().clone(),
        Err(_) => String::new(),
    }
}

/// 출력 장치를 실시간 전환한다. 재생 중이면 현재 위치에서 새 장치로 이어서
/// 재생하고, 마스터/보컬/MR 볼륨·피치·템포는 공유 상태라 그대로 유지된다.
/// `name`이 빈 문자열이면 시스템 기본 장치로 되돌린다.
#[tauri::command]
pub async fn set_output_device(window: WebviewWindow, name: String) -> Result<String, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();

    // 현재 재생 상태·위치 파악(전환 후 이어서 재생하기 위해).
    let (cur_track, was_playing) = {
        let state = handler.state.lock();
        (state.current_track.clone(), state.is_playing)
    };
    let rate = handler.track_sample_rate.load(Ordering::Relaxed);
    let pos_samples = handler.current_pos_samples.load(Ordering::Relaxed);
    let cur_pos_ms = if rate > 0 {
        (pos_samples as f64 / rate as f64 * 1000.0) as u64
    } else {
        0
    };
    let duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);

    // cpal 장치 열기는 블로킹이므로 별도 스레드에서.
    let want = name.clone();
    let (stream, dev_rate, dev_ch, resolved, est) = tokio::task::spawn_blocking(move || {
        crate::audio_player::open_output_sink(if want.is_empty() { None } else { Some(&want) })
    })
    .await
    .map_err(|e| e.to_string())??;

    // 새 player를 만들고, sink/player를 통째로 교체.
    let new_player = rodio::Player::connect_new(&stream.mixer());
    new_player.set_volume(f32::from_bits(handler.master_gain.load(Ordering::Relaxed)));
    {
        let mut ctrl = handler.controller.lock();
        ctrl.clear();
        *handler._stream.lock() = stream;
        *ctrl = new_player;
    }
    handler.monitor.sample_rate.store(dev_rate, Ordering::Relaxed);
    handler.monitor.channels.store(dev_ch as u32, Ordering::Relaxed);
    handler.monitor.est_latency_ms.store(est.to_bits(), Ordering::Relaxed);
    *handler.monitor.device_name.lock() = resolved.clone();

    // 선택 저장(재시작 후 복원).
    {
        let db = DB.lock();
        let _ = db.execute(
            "INSERT OR REPLACE INTO Settings (key, value) VALUES ('output_device', ?)",
            rusqlite::params![name],
        );
    }
    sys_log(&format!(
        "[AUDIO] Output device switched → {} ({}Hz, {}ch)",
        resolved, dev_rate, dev_ch
    ));

    // 재생 중이었거나 곡이 로드돼 있으면 새 장치로 현재 위치부터 재개/준비.
    if let Some(p) = cur_track {
        if was_playing || cur_pos_ms > 0 {
            let _ = play_track_internal(window.clone(), p, Some(duration_ms), Some(cur_pos_ms), was_playing).await;
        }
    }
    Ok(resolved)
}

/// 현재 MR 채널(2번째 출력) 장치 이름. 빈 문자열이면 MR 채널 꺼짐.
#[tauri::command]
pub fn get_mr_output_device() -> String {
    match &*AUDIO_HANDLER {
        Ok(h) => h.mr.device_name.lock().clone(),
        Err(_) => String::new(),
    }
}

/// MR 채널(2번째 출력) 장치를 설정한다. 빈 문자열이면 MR 채널을 끈다(모니터만).
/// 곡이 로드돼 있으면 현재 위치에서 두 채널을 다시 구성한다.
#[tauri::command]
pub async fn set_mr_output_device(window: WebviewWindow, name: String) -> Result<String, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();

    let (cur_track, was_playing) = {
        let state = handler.state.lock();
        (state.current_track.clone(), state.is_playing)
    };
    let rate = handler.track_sample_rate.load(Ordering::Relaxed);
    let pos_samples = handler.current_pos_samples.load(Ordering::Relaxed);
    let cur_pos_ms = if rate > 0 { (pos_samples as f64 / rate as f64 * 1000.0) as u64 } else { 0 };
    let duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);

    let resolved = if name.trim().is_empty() {
        // MR 채널 끄기.
        if let Some(ctrl) = handler.mr_controller.lock().as_ref() { ctrl.clear(); }
        *handler.mr_controller.lock() = None;
        *handler.mr_stream.lock() = None;
        handler.mr.device_name.lock().clear();
        sys_log("[AUDIO] MR 채널 꺼짐");
        String::new()
    } else {
        let want = name.clone();
        let (stream, dev_rate, dev_ch, resolved, est) = tokio::task::spawn_blocking(move || {
            crate::audio_player::open_output_sink(Some(&want))
        })
        .await
        .map_err(|e| e.to_string())??;
        let player = rodio::Player::connect_new(&stream.mixer());
        player.set_volume(f32::from_bits(handler.master_gain.load(Ordering::Relaxed)));
        *handler.mr_stream.lock() = Some(stream);
        *handler.mr_controller.lock() = Some(player);
        handler.mr.sample_rate.store(dev_rate, Ordering::Relaxed);
        handler.mr.channels.store(dev_ch as u32, Ordering::Relaxed);
        handler.mr.est_latency_ms.store(est.to_bits(), Ordering::Relaxed);
        *handler.mr.device_name.lock() = resolved.clone();
        sys_log(&format!("[AUDIO] MR 채널 장치 → {} ({}Hz, {}ch, ~{:.0}ms)", resolved, dev_rate, dev_ch, est));
        resolved
    };

    {
        let db = DB.lock();
        let _ = db.execute(
            "INSERT OR REPLACE INTO Settings (key, value) VALUES ('mr_output_device', ?)",
            rusqlite::params![name],
        );
    }

    // 곡이 로드돼 있으면 두 채널을 현재 위치에서 재구성.
    if let Some(p) = cur_track {
        if was_playing || cur_pos_ms > 0 {
            let _ = play_track_internal(window.clone(), p, Some(duration_ms), Some(cur_pos_ms), was_playing).await;
        }
    }
    Ok(resolved)
}

/// 채널 라우팅 설정. channel: "monitor" | "mr", source: "vocal" | "inst" | "metro".
#[tauri::command]
pub async fn set_channel_route(channel: String, source: String, enabled: bool) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    {
        let mut s = handler.state.lock();
        match (channel.as_str(), source.as_str()) {
            ("monitor", "vocal") => s.mon_route_vocal = enabled,
            ("monitor", "inst") => s.mon_route_inst = enabled,
            ("monitor", "metro") => s.mon_route_metro = enabled,
            ("mr", "vocal") => s.mr_route_vocal = enabled,
            ("mr", "inst") => s.mr_route_inst = enabled,
            ("mr", "metro") => s.mr_route_metro = enabled,
            _ => return Err(format!("알 수 없는 채널/소스: {}/{}", channel, source)),
        }
    }
    recompute_mix(&handler);
    Ok(())
}

/// 메트로놈 설정(활성/BPM/게인). bpm 0 = 곡 분석 BPM 자동(미구현 시 120).
/// bpm 변경은 다음 재생/탐색부터 반영된다(생성된 클릭 스트림 특성상).
#[tauri::command]
pub async fn set_metronome(enabled: bool, bpm: f64, gain: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    {
        let mut s = handler.state.lock();
        s.metro_enabled = enabled;
        s.metro_bpm = bpm as f32;
        s.metro_gain = (gain as f32).clamp(0.0, 100.0);
    }
    // 재생 중인 클릭에 즉시 반영되도록 공유 atomic 갱신.
    handler.metro_bpm.store((bpm as f32).to_bits(), Ordering::Relaxed);
    recompute_mix(&handler);
    Ok(())
}

/// 출력 소프트 리미터 on/off. 재생 중 즉시 반영(리미터 소스가 atomic을 읽음).
#[tauri::command]
pub async fn set_limiter(enabled: bool) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.limiter_enabled.store(if enabled { 1 } else { 0 }, Ordering::Relaxed);
    Ok(())
}

/// 버스 지연 보정(ms) 설정. bus: "monitor" | "mr". 값은 ≥0. 딜레이는 재생
/// 파이프라인에 붙으므로, 곡이 로드돼 있으면 현재 위치에서 재구성해 즉시 반영한다.
#[tauri::command]
pub async fn set_bus_delay(window: WebviewWindow, bus: String, delay_ms: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let d = (delay_ms as f32).max(0.0);
    let (key, target) = match bus.as_str() {
        "monitor" => ("output_delay_ms", &handler.monitor),
        "mr" => ("mr_delay_ms", &handler.mr),
        other => return Err(format!("알 수 없는 버스: {}", other)),
    };
    target.delay_ms.store(d.to_bits(), Ordering::Relaxed);
    {
        let db = DB.lock();
        let _ = db.execute(
            "INSERT OR REPLACE INTO Settings (key, value) VALUES (?, ?)",
            rusqlite::params![key, d.to_string()],
        );
    }
    sys_log(&format!("[AUDIO] {} 버스 지연 보정 → {:.0}ms", bus, d));

    // 곡이 로드돼 있으면 현재 위치에서 재구성(딜레이는 빌드 시 적용).
    let (cur_track, was_playing) = {
        let s = handler.state.lock();
        (s.current_track.clone(), s.is_playing)
    };
    if let Some(p) = cur_track {
        let rate = handler.track_sample_rate.load(Ordering::Relaxed);
        let pos_samples = handler.current_pos_samples.load(Ordering::Relaxed);
        let cur_pos_ms = if rate > 0 { (pos_samples as f64 / rate as f64 * 1000.0) as u64 } else { 0 };
        let duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);
        if was_playing || cur_pos_ms > 0 {
            let _ = play_track_internal(window.clone(), p, Some(duration_ms), Some(cur_pos_ms), was_playing).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_playback() -> Result<bool, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    
    let new_is_playing = {
        let controller = handler.controller.lock();
        if controller.is_paused() {
            controller.play();
            true
        } else {
            controller.pause();
            false
        }
    };

    // MR 채널도 함께 재생/일시정지.
    if let Some(mr) = handler.mr_controller.lock().as_ref() {
        if new_is_playing { mr.play(); } else { mr.pause(); }
    }

    {
        let mut state = handler.state.lock();
        state.is_playing = new_is_playing;
    }

    Ok(new_is_playing)
}

#[tauri::command]
pub fn get_alignment_sync_state() -> Result<PlaybackProgress, String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };

    let rate = handler.track_sample_rate.load(Ordering::Relaxed);
    let pos_samples = handler.current_pos_samples.load(Ordering::Relaxed);
    let duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);
    
    let position_ms = if rate > 0 {
        (pos_samples as f64 / rate as f64 * 1000.0) as u64
    } else {
        0
    };

    Ok(PlaybackProgress {
        position_ms,
        duration_ms,
    })
}

#[tauri::command]
pub async fn stop_playback() -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        controller.clear();
        if let Some(mr) = handler.mr_controller.lock().as_ref() { mr.clear(); }
        let mut state = handler.state.lock();
        state.is_playing = false;
        state.current_track = None;
    }
    Ok(())
}

/// 소스 레벨 게인(보컬, 인스트, 메트로놈) — 채널 라우팅 이전. (순수 함수)
///
/// 보컬/인스트 = 트랙볼륨 × 밸런스비율 × (페이더/100) × 게이트(음소거·솔로·보컬토글).
/// 메트로놈 = enabled ? metro_gain : 0 (밸런스·솔로 영향 없음).
/// 반환값은 atomic에 저장되는 0~125 스케일.
pub fn source_gains(s: &AppState) -> (f32, f32, f32) {
    let v_ratio = (s.vocal_balance / 50.0).min(1.0);
    let i_ratio = ((100.0 - s.vocal_balance) / 50.0).min(1.0);

    // 솔로가 하나라도 켜지면, 솔로된 트랙만 소리난다.
    let any_solo = s.vocal_solo || s.inst_solo;
    let v_gate = s.vocal_enabled && !s.vocal_muted && (!any_solo || s.vocal_solo);
    let i_gate = !s.inst_muted && (!any_solo || s.inst_solo);

    let vocal = if v_gate { s.volume * v_ratio * (s.vocal_fader / 100.0) } else { 0.0 };
    let inst = if i_gate { s.volume * i_ratio * (s.inst_fader / 100.0) } else { 0.0 };
    let metro = if s.metro_enabled { s.metro_gain } else { 0.0 };
    (vocal, inst, metro)
}

/// 보컬/MR(인스트) 최종 게인 — 기본 라우팅(모니터=보컬+인스트) 기준의 소스 게인.
/// 기존 단일 채널 동작 및 테스트 호환용.
#[allow(dead_code)]
pub fn compute_track_gains(s: &AppState) -> (f32, f32) {
    let (v, i, _m) = source_gains(s);
    (v, i)
}

/// 6개 채널×소스 게인. (모니터/MR) × (보컬/인스트/메트로놈)
pub struct ChannelGains {
    pub mon_vocal: f32,
    pub mon_inst: f32,
    pub mon_metro: f32,
    pub mr_vocal: f32,
    pub mr_inst: f32,
    pub mr_metro: f32,
}

/// 소스 게인을 라우팅 매트릭스로 게이트해 채널별 최종 게인을 낸다. (순수 함수)
pub fn compute_channel_gains(s: &AppState) -> ChannelGains {
    let (v, i, m) = source_gains(s);
    ChannelGains {
        mon_vocal: if s.mon_route_vocal { v } else { 0.0 },
        mon_inst: if s.mon_route_inst { i } else { 0.0 },
        mon_metro: if s.mon_route_metro { m } else { 0.0 },
        mr_vocal: if s.mr_route_vocal { v } else { 0.0 },
        mr_inst: if s.mr_route_inst { i } else { 0.0 },
        mr_metro: if s.mr_route_metro { m } else { 0.0 },
    }
}

/// 믹스 재계산 — 6개 채널×소스 게인 atomic을 갱신한다. 모든 볼륨/라우팅
/// 커맨드는 이 함수를 통한다. 모니터 채널의 보컬/인스트는 기존 atomic
/// (vocal_volume/instrumental_volume)을 그대로 쓴다(단일 채널 무회귀).
pub fn recompute_mix(handler: &crate::audio_player::AudioHandler) {
    let g = {
        let s = handler.state.lock();
        compute_channel_gains(&s)
    };
    handler.vocal_volume.store(g.mon_vocal.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store(g.mon_inst.to_bits(), Ordering::Relaxed);
    handler.mon_metro_volume.store(g.mon_metro.to_bits(), Ordering::Relaxed);
    handler.mr_vocal_volume.store(g.mr_vocal.to_bits(), Ordering::Relaxed);
    handler.mr_inst_volume.store(g.mr_inst.to_bits(), Ordering::Relaxed);
    handler.mr_metro_volume.store(g.mr_metro.to_bits(), Ordering::Relaxed);
}

#[tauri::command]
pub async fn set_volume(volume: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.state.lock().volume = volume as f32;
    recompute_mix(&handler);
    Ok(())
}

#[tauri::command]
pub async fn set_vocal_balance(balance: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.state.lock().vocal_balance = balance as f32;
    recompute_mix(&handler);
    Ok(())
}

/// 믹스·라우팅·메트로놈 상태(UI 복원용).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixState {
    pub vocal_fader: f32,
    pub inst_fader: f32,
    pub vocal_muted: bool,
    pub inst_muted: bool,
    pub vocal_solo: bool,
    pub inst_solo: bool,
    // 라우팅 매트릭스.
    pub mon_route_vocal: bool,
    pub mon_route_inst: bool,
    pub mon_route_metro: bool,
    pub mr_route_vocal: bool,
    pub mr_route_inst: bool,
    pub mr_route_metro: bool,
    // 메트로놈.
    pub metro_enabled: bool,
    pub metro_bpm: f32,
    pub metro_gain: f32,
    // MR 채널 장치(빈 문자열이면 꺼짐).
    pub mr_device: String,
    // 버스별 지연 보정(ms)과 장치 추정 지연(ms, baseline).
    pub mon_delay_ms: f32,
    pub mon_est_latency_ms: f32,
    pub mr_delay_ms: f32,
    pub mr_est_latency_ms: f32,
    // 출력 리미터 on/off.
    pub limiter_enabled: bool,
}

#[tauri::command]
pub fn get_mix_state() -> Result<MixState, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let mr_device = handler.mr.device_name.lock().clone();
    let mon_delay = handler.monitor.delay_ms_val();
    let mon_est = handler.monitor.est_latency_val();
    let mr_delay = handler.mr.delay_ms_val();
    let mr_est = handler.mr.est_latency_val();
    let limiter_enabled = handler.limiter_enabled.load(Ordering::Relaxed) != 0;
    let s = handler.state.lock();
    Ok(MixState {
        vocal_fader: s.vocal_fader,
        inst_fader: s.inst_fader,
        vocal_muted: s.vocal_muted,
        inst_muted: s.inst_muted,
        vocal_solo: s.vocal_solo,
        inst_solo: s.inst_solo,
        mon_route_vocal: s.mon_route_vocal,
        mon_route_inst: s.mon_route_inst,
        mon_route_metro: s.mon_route_metro,
        mr_route_vocal: s.mr_route_vocal,
        mr_route_inst: s.mr_route_inst,
        mr_route_metro: s.mr_route_metro,
        metro_enabled: s.metro_enabled,
        metro_bpm: s.metro_bpm,
        metro_gain: s.metro_gain,
        mr_device,
        mon_delay_ms: mon_delay,
        mon_est_latency_ms: mon_est,
        mr_delay_ms: mr_delay,
        mr_est_latency_ms: mr_est,
        limiter_enabled,
    })
}

/// 트랙별 독립 페이더(0~100%). track: "vocal" | "inst".
#[tauri::command]
pub async fn set_track_fader(track: String, percent: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let pct = (percent as f32).clamp(0.0, 100.0);
    {
        let mut s = handler.state.lock();
        match track.as_str() {
            "vocal" => s.vocal_fader = pct,
            "inst" => s.inst_fader = pct,
            other => return Err(format!("알 수 없는 트랙: {}", other)),
        }
    }
    recompute_mix(&handler);
    Ok(())
}

/// 트랙 음소거. track: "vocal" | "inst".
#[tauri::command]
pub async fn set_track_mute(track: String, muted: bool) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    {
        let mut s = handler.state.lock();
        match track.as_str() {
            "vocal" => s.vocal_muted = muted,
            "inst" => s.inst_muted = muted,
            other => return Err(format!("알 수 없는 트랙: {}", other)),
        }
    }
    recompute_mix(&handler);
    Ok(())
}

/// 트랙 솔로. track: "vocal" | "inst". 솔로가 켜진 트랙만 소리난다.
#[tauri::command]
pub async fn set_track_solo(track: String, soloed: bool) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    {
        let mut s = handler.state.lock();
        match track.as_str() {
            "vocal" => s.vocal_solo = soloed,
            "inst" => s.inst_solo = soloed,
            other => return Err(format!("알 수 없는 트랙: {}", other)),
        }
    }
    recompute_mix(&handler);
    Ok(())
}

#[tauri::command]
pub async fn set_pitch(semitones: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_pitch.store((semitones as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn set_tempo(ratio: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_tempo.store((ratio as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn seek_to(window: WebviewWindow, position_ms: u64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    // 탐색은 재생 상태를 바꾸지 않는다. 예전에는 play_now를 무조건 true로 넘겨서
    // 멈춰 둔 채 파형을 만지기만 해도 음악이 시작됐고, 프런트가 그때마다
    // toggle_playback으로 되돌리는 보정을 넣어야 했다(경합에 취약했다).
    let (path, duration_ms, was_playing) = {
        let state = handler.state.lock();
        (
            state.current_track.clone(),
            handler.total_duration_ms.load(Ordering::Relaxed),
            state.is_playing,
        )
    };

    if let Some(p) = path {
        let current_instrumental = handler.instrumental_volume.load(Ordering::Relaxed);
        let current_vocal = handler.vocal_volume.load(Ordering::Relaxed);
        
        handler.instrumental_volume.store(0f32.to_bits(), Ordering::Relaxed);
        handler.vocal_volume.store(0f32.to_bits(), Ordering::Relaxed);
        
        tokio::time::sleep(tokio::time::Duration::from_millis(60)).await;

        sys_log(&format!("[AUDIO] Seek request: {}ms for {}", position_ms, p));
        
        handler.instrumental_volume.store(current_instrumental, Ordering::Relaxed);
        handler.vocal_volume.store(current_vocal, Ordering::Relaxed);
        
        match play_track_internal(window.clone(), p.clone(), Some(duration_ms), Some(position_ms), was_playing).await {
            Ok(_) => {},
            Err(e) => {
                sys_log(&format!("[AUDIO] Seek-Play failed: {}", e));
                let _ = window.emit("playback-status", PlaybackStatus { 
                    status: Status::Error, 
                    message: format!("Seek failed: {}", e) 
                });
                return Err(e);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_ai_feature(feature: String, enabled: bool) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        {
            let mut state = handler.state.lock();
            match feature.as_str() {
                "vocal" => state.vocal_enabled = enabled,
                "lyric" => state.lyric_enabled = enabled,
                _ => {}
            }
        }
        recompute_mix(handler);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_playback_state() -> Result<AppState, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let state = handler.state.lock().clone();
    Ok(state)
}

#[tauri::command]
pub async fn get_model_settings() -> Result<String, String> {
    let db = DB.lock();
    let res = db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0));
    Ok(res.unwrap_or_else(|_| "kim".to_string()))
}

#[tauri::command]
pub async fn get_ai_engine_status() -> String {
    let engine = crate::separation::ROFORMER_ENGINE.lock();
    if let Some(engine) = engine.as_ref() {
        engine.get_provider()
    } else {
        "None (Idle)".to_string()
    }
}

#[tauri::command]
pub async fn update_model_settings(model_id: String) -> Result<(), String> {
    let db = DB.lock();
    db.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('active_model_id', ?)", rusqlite::params![model_id]).map_err(|e| e.to_string())?;
    let mut engine = crate::separation::ROFORMER_ENGINE.lock();
    *engine = None;
    *crate::separation::ENGINE_MODEL_ID.lock() = None;
    Ok(())
}

pub fn start_playback_progress_loop(handle: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(handler) = &*AUDIO_HANDLER {
            let samples = handler.current_pos_samples.load(Ordering::Relaxed);
            let mut duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);
            let track_rate = handler.track_sample_rate.load(Ordering::Relaxed);
            
            // Fallback: If duration is 0, try to get it from the DB
            if duration_ms == 0 {
                if let Some(track_path) = handler.state.lock().current_track.clone() {
                    if let Ok(d_str) = crate::state::DB.lock().query_row(
                        "SELECT duration FROM Tracks WHERE path = ?", 
                        rusqlite::params![track_path], 
                        |row| row.get::<_, String>(0)
                    ) {
                        let parts: Vec<&str> = d_str.split(':').collect();
                        if parts.len() == 2 {
                            let m = parts[0].parse::<u64>().unwrap_or(0);
                            let s = parts[1].parse::<u64>().unwrap_or(0);
                            duration_ms = (m * 60 + s) * 1000;
                            handler.total_duration_ms.store(duration_ms, Ordering::Relaxed);
                        }
                    }
                }
            }
            
            let pos_ms = if track_rate > 0 { 
                ((samples as u128 * 1000) / track_rate as u128) as u64
            } else { 0 };

            let is_locked = crate::audio_player::IS_PREPARING_PLAYBACK.load(Ordering::SeqCst);
            let sink_empty = handler.controller.lock().empty();
            
            if (sink_empty || (duration_ms > 0 && pos_ms >= duration_ms + 1000)) && duration_ms > 0 && !is_locked {
                let was_playing = {
                    let mut state = handler.state.lock();
                    if state.is_playing {
                        state.is_playing = false;
                        state.current_track = None;
                        true
                    } else { false }
                };
                if was_playing {
                    let _ = handle.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "Finished".into() });
                }
            }

            if duration_ms > 0 {
                let _ = handle.emit("playback-progress", PlaybackProgress { position_ms: pos_ms, duration_ms });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::compute_track_gains;
    use crate::types::AppState;

    // 기본값(페이더 100, 음소거/솔로 없음)에서는 볼륨×밸런스 결과와 같아야 한다
    // (독립 페이더/뮤트/솔로 도입 전 동작과 동일 — 무회귀 확인).
    #[test]
    fn default_matches_volume_balance() {
        let s = AppState { volume: 80.0, vocal_balance: 50.0, ..Default::default() };
        let (v, i) = compute_track_gains(&s);
        // balance 50 → 두 비율 모두 1.0 → 둘 다 볼륨 그대로.
        assert!((v - 80.0).abs() < 1e-4);
        assert!((i - 80.0).abs() < 1e-4);
    }

    #[test]
    fn fader_scales_only_its_track() {
        let s = AppState { volume: 100.0, vocal_balance: 50.0, vocal_fader: 50.0, ..Default::default() };
        let (v, i) = compute_track_gains(&s);
        assert!((v - 50.0).abs() < 1e-4, "보컬은 페이더 50%로 절반");
        assert!((i - 100.0).abs() < 1e-4, "MR은 영향 없음");
    }

    #[test]
    fn mute_silences_only_its_track() {
        let s = AppState { volume: 100.0, vocal_balance: 50.0, vocal_muted: true, ..Default::default() };
        let (v, i) = compute_track_gains(&s);
        assert_eq!(v, 0.0);
        assert!((i - 100.0).abs() < 1e-4);
    }

    #[test]
    fn solo_silences_non_soloed_tracks() {
        // MR만 솔로 → 보컬 무음.
        let s = AppState { volume: 100.0, vocal_balance: 50.0, inst_solo: true, ..Default::default() };
        let (v, i) = compute_track_gains(&s);
        assert_eq!(v, 0.0, "솔로 안 된 보컬은 무음");
        assert!((i - 100.0).abs() < 1e-4, "솔로된 MR은 소리남");
    }

    #[test]
    fn solo_overrides_mute_on_soloed_track() {
        // 보컬 솔로+음소거 동시: 솔로는 다른 트랙을 죽이지만, 자기 자신의 음소거는 유지.
        let s = AppState { volume: 100.0, vocal_balance: 50.0, vocal_solo: true, vocal_muted: true, ..Default::default() };
        let (v, i) = compute_track_gains(&s);
        assert_eq!(v, 0.0, "음소거된 보컬은 솔로여도 무음");
        assert_eq!(i, 0.0, "솔로 안 된 MR도 무음");
    }

    #[test]
    fn vocal_toggle_off_silences_vocal() {
        let s = AppState { volume: 100.0, vocal_balance: 50.0, vocal_enabled: false, ..Default::default() };
        let (v, i) = compute_track_gains(&s);
        assert_eq!(v, 0.0);
        assert!((i - 100.0).abs() < 1e-4);
    }

    // --- 채널 라우팅 ---
    use super::compute_channel_gains;

    #[test]
    fn default_routing_monitor_full_mr_inst_only() {
        // 기본: 모니터=보컬+인스트, MR=인스트만.
        let s = AppState { volume: 100.0, vocal_balance: 50.0, ..Default::default() };
        let g = compute_channel_gains(&s);
        assert!((g.mon_vocal - 100.0).abs() < 1e-4);
        assert!((g.mon_inst - 100.0).abs() < 1e-4);
        assert_eq!(g.mon_metro, 0.0, "메트로놈 기본 꺼짐");
        assert_eq!(g.mr_vocal, 0.0, "MR 채널 기본은 보컬 없음");
        assert!((g.mr_inst - 100.0).abs() < 1e-4, "MR 채널은 인스트");
    }

    #[test]
    fn metro_routes_to_enabled_channels_only() {
        // 메트로놈 켜고 모니터에만 라우팅.
        let s = AppState {
            volume: 100.0, vocal_balance: 50.0,
            metro_enabled: true, metro_gain: 80.0,
            mon_route_metro: true, mr_route_metro: false,
            ..Default::default()
        };
        let g = compute_channel_gains(&s);
        assert!((g.mon_metro - 80.0).abs() < 1e-4, "모니터에 메트로놈");
        assert_eq!(g.mr_metro, 0.0, "MR 채널엔 메트로놈 없음");
    }

    #[test]
    fn source_fader_flows_into_both_channels() {
        // 보컬 페이더 50%를 두 채널 모두에 라우팅하면 양쪽 다 절반.
        let s = AppState {
            volume: 100.0, vocal_balance: 50.0, vocal_fader: 50.0,
            mon_route_vocal: true, mr_route_vocal: true,
            ..Default::default()
        };
        let g = compute_channel_gains(&s);
        assert!((g.mon_vocal - 50.0).abs() < 1e-4);
        assert!((g.mr_vocal - 50.0).abs() < 1e-4);
    }
}

