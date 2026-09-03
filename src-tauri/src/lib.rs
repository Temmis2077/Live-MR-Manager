use tauri::Manager;
pub use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState, SongMetadata};

mod types;
mod youtube;
mod youtube_url;
mod model_manager;
mod custom_models;
pub mod vocal_remover;
pub mod audio_player;
pub mod audio_core;
pub mod ipc;
mod separation;
pub mod state;
mod alignment;
mod lyrics_db;
mod metadata_fetcher;
pub mod audio;
pub mod onnx_engine;
mod library;
pub mod gpu_pack;
pub mod dereverb;
mod title_parser;
pub mod search; // 개발용 lyrics_probe 바이너리가 참조한다
mod meloming;
mod key_bpm;
mod audio_commands;
mod mr_cache;
mod mr_encode;
mod ffmpeg_tools;
mod model_commands;
mod system;
mod spreadsheet;
mod rescue;
mod overlay_server;
mod updater;

fn load_env_files() {
    let manifest_env = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
    let _ = dotenvy::from_path(&manifest_env);
    let _ = dotenvy::dotenv();
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    load_env_files();
    if let Err(error) = crate::onnx_engine::initialize_bundled_runtime() {
        crate::audio_player::sys_log(&format!("[ONNX Runtime] {error}"));
    }

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            crate::audio_player::sys_log(&format!(
                "[App] deep-link forwarded to running instance (argv={argv:?})"
            ));
            // deep-link 플러그인이 on_open_url로 OAuth URL을 전달하므로 argv는 여기서 다시 처리하지 않음
            focus_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            ipc::contract_builder().mount_events(app);
            crate::meloming::oauth::sync_credentials_from_env();
            if let Some(window) = app.get_webview_window("main") {
                *crate::state::MAIN_WINDOW.lock() = Some(window);
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();

                #[cfg(any(windows, target_os = "linux"))]
                {
                    app.deep_link().register_all()?;
                }
                #[cfg(not(any(windows, target_os = "linux")))]
                {
                    let _ = app.deep_link().register("osw");
                    // 기존 설치와 이미 발급된 OAuth 콜백의 하위 호환.
                    let _ = app.deep_link().register("live-mr-manager");
                }

                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        crate::meloming::oauth::handle_deep_link(&handle, url.as_ref());
                    }
                }

                app.deep_link().on_open_url(move |event| {
                    focus_main_window(&handle);
                    for url in event.urls() {
                        crate::meloming::oauth::handle_deep_link(&handle, url.as_ref());
                    }
                });
            }

            let paths = crate::state::AppPaths::from_handle(app.handle());
            *crate::state::APP_PATHS.lock() = Some(paths.clone());
            app.manage(paths);
            // TensorRT/cuDNN 팩이 있으면 ORT가 찾을 수 있게 DLL 경로를 먼저 등록.
            crate::gpu_pack::register_dll_search_path();
            crate::audio_player::sys_log("[App] Startup complete");
            let _ = &*crate::state::DB;
            
            crate::audio_commands::start_playback_progress_loop(app.handle().clone());
            
            // Start the OBS Overlay WebSocket server
            crate::overlay_server::init(app.handle().clone());
            tauri::async_runtime::spawn(crate::overlay_server::start_overlay_server());

            crate::updater::start_update_checker(app.handle().clone());

            tauri::async_runtime::spawn(async {
                if let Some(path) = crate::ffmpeg_tools::ensure_managed_ffmpeg().await {
                    crate::audio_player::sys_log(&format!(
                        "[Tools] ffmpeg ready at {}",
                        path.to_string_lossy()
                    ));
                }
            });

            // yt-dlp는 유튜브 변경에 맞춰 주 단위로 갱신된다 — 오래된 바이너리는
            // "곡 추가가 갑자기 실패"의 주범이라, 시작 시 조용히 최신본으로 유지한다.
            // (실패해도 기존 바이너리로 계속 동작하므로 시작을 막지 않는다.)
            tauri::async_runtime::spawn(async {
                crate::youtube::YoutubeManager::refresh_managed_yt_dlp_if_stale().await;
            });

            Ok(())
        })
        .invoke_handler(ipc::handler())

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
