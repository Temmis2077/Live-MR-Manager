use tauri::{AppHandle, Manager};
use std::path::{Path, PathBuf};
use crate::audio_player::sys_log;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RescueStats {
    pub scanned: usize,
    pub recovered: usize,
    pub failed: usize,
}

#[tauri::command]
pub async fn run_local_rescue(app: AppHandle) -> Result<RescueStats, String> {
    let configured_music = app.path().audio_dir().ok().map(|p| p.join("MR"));
    let fallback_local = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("rescue");
    let path = configured_music.unwrap_or(fallback_local);
    if !path.exists() {
        return Err("Target directory not found.".into());
    }

    let mut files = Vec::new();
    fn visit_dirs(dir: &Path, files: &mut Vec<String>) -> std::io::Result<()> {
        if dir.is_dir() {
            for entry in std::fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_dir() {
                    visit_dirs(&path, files)?;
                } else if let Some(ext) = path.extension() {
                    let ext_str = ext.to_string_lossy().to_lowercase();
                    if ext_str == "wav" || ext_str == "mp3" || ext_str == "flac" {
                        files.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        Ok(())
    }

    let _ = visit_dirs(&path, &mut files);

    let mut scanned = 0usize;
    let mut recovered = 0usize;
    let mut failed = 0usize;
    for f_path in files {
        scanned += 1;
        // We need to call get_audio_metadata from crate::lib or re-implement it.
        // For simplicity and to avoid circular deps, let's just re-implement the call.
        if let Ok(_) = crate::library::get_audio_metadata(f_path).await {
            recovered += 1;
        } else {
            failed += 1;
        }
    }

    let _ = crate::metadata_fetcher::sync_dictionary_to_db(app).await;

    Ok(RescueStats {
        scanned,
        recovered,
        failed,
    })
}

#[tauri::command]
pub async fn run_cache_rescue(app: AppHandle) -> Result<RescueStats, String> {
    let paths = app.state::<crate::state::AppPaths>();
    let separated_dir = &paths.separated;
    
    sys_log(&format!("[Rescue] Scanning cache directory: {:?}", separated_dir));

    if !separated_dir.exists() {
        return Err("Cache directory not found.".into());
    }

    let mut scanned = 0usize;
    let mut recovered = 0usize;
    let mut failed = 0usize;
    if let Ok(entries) = std::fs::read_dir(separated_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if entry.file_name().to_string_lossy().starts_with('_') {
                    continue;
                }
                scanned += 1;
                if let Some(folder_name) = entry.file_name().to_str() {
                    // Decode folder name to get original path/URL
                    if let Ok(decoded_path) = urlencoding::decode(folder_name) {
                        let path_str = decoded_path.to_string();
                        sys_log(&format!("[Rescue] Found cached item: {}", path_str));
                        
                        // Call library to fetch metadata and register in DB
                        match crate::library::get_audio_metadata(path_str.clone()).await {
                            Ok(_) => {
                                recovered += 1;
                                sys_log(&format!("[Rescue] Successfully recovered: {}", path_str));
                            },
                            Err(e) => {
                                failed += 1;
                                sys_log(&format!("[Rescue] Failed to recover {}: {}", path_str, e));
                            }
                        }
                    } else {
                        failed += 1;
                    }
                }
            }
        }
    }
    
    let _ = crate::metadata_fetcher::sync_dictionary_to_db(app).await;
    Ok(RescueStats {
        scanned,
        recovered,
        failed,
    })
}

