use tauri::Manager;
pub use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState, SongMetadata};

mod types;
mod youtube;
mod youtube_url;
mod model_manager;
mod custom_models;
pub mod vocal_remover;
pub mod audio_player;
mod separation;
pub mod state;
mod alignment;
mod metadata_fetcher;
pub mod audio;
pub mod onnx_engine;
mod library;
pub mod gpu_pack;
pub mod dereverb;
mod title_parser;
mod search;
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
mod migration;

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
            // 구 식별자 데이터를 새 식별자로 가져오기 — DB를 열거나 새 폴더를
            // 만들기 전에 가장 먼저 실행해야 파일 잠금·이름 충돌이 없다.
            crate::migration::maybe_migrate_legacy_data(app.handle());

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
        .invoke_handler(tauri::generate_handler![
            audio_commands::get_model_settings, audio_commands::update_model_settings,
            audio_commands::play_track, audio_commands::toggle_playback, audio_commands::stop_playback, audio_commands::seek_to, audio_commands::set_pitch, audio_commands::set_tempo, audio_commands::set_volume, audio_commands::set_master_volume,
            audio_commands::set_vocal_balance, audio_commands::toggle_ai_feature,
            audio_commands::list_output_devices, audio_commands::get_output_device, audio_commands::set_output_device,
            audio_commands::get_mr_output_device, audio_commands::set_mr_output_device,
            audio_commands::set_channel_route, audio_commands::set_metronome, audio_commands::set_bus_delay, audio_commands::set_limiter,
            audio_commands::get_mix_state, audio_commands::set_track_fader, audio_commands::set_track_mute, audio_commands::set_track_solo,
            model_commands::check_mr_separated,
            model_commands::get_separation_info,
            model_commands::delete_mr,
            model_commands::start_mr_separation, 
            model_commands::youtube_metadata_fetcher,
            library::get_audio_metadata, audio_commands::get_playback_state, 
            model_commands::check_ai_runtime, model_commands::check_model_ready, model_commands::download_ai_model, 
            library::save_library, library::load_library, library::get_songs, library::get_categories, library::get_genres, 
            library::get_track_count, 
            model_commands::cancel_separation, 
            model_commands::set_broadcast_mode,
            model_commands::get_mr_cache_format,
            model_commands::set_mr_cache_format,
            system::get_audio_devices,
            system::open_cache_folder,
            system::open_mr_folder,
            system::get_mr_cache_dir,
            system::set_mr_cache_dir,
            system::reset_mr_cache_dir,
            model_commands::delete_ai_model,
            model_commands::get_gpu_recommendation,
            model_commands::list_model_presets,
            model_commands::list_all_models,
            model_commands::list_custom_models,
            model_commands::add_custom_model,
            model_commands::remove_custom_model,
            library::add_category, library::delete_category,
            library::delete_song, library::map_track_to_categories,
            system::get_app_paths,
            system::pick_audio_files,
            system::open_lyrics_window,
            gpu_pack::get_gpu_pack_status,
            gpu_pack::open_gpu_pack_dir,
            gpu_pack::install_gpu_pack,
            gpu_pack::cancel_gpu_pack_install,
            dereverb::get_dereverb_status,
            dereverb::set_dereverb_enabled,
            dereverb::open_dereverb_dir,
            search::search_youtube,
            search::search_lyrics_sites,
            system::export_backup, 
            system::import_backup,
            system::export_library_spreadsheet,
            system::import_library_spreadsheet,
            rescue::run_cache_rescue,
            rescue::run_local_rescue,
            model_commands::get_active_separations,
            audio_commands::get_ai_engine_status, 
            library::update_song_metadata,
            key_bpm::analyze_key_bpm,
            audio_commands::get_alignment_sync_state,
            alignment::get_separated_audio_list, alignment::run_forced_alignment,
            alignment::cancel_forced_alignment, alignment::read_audio_file,
            alignment::apply_alignment_tuning,
            alignment::get_waveform_summary, alignment::get_model_list,
            alignment::download_alignment_model, alignment::list_downloadable_alignment_models,
            alignment::save_lrc_file, alignment::load_lrc_file,
            system::remote_js_log,
            updater::check_for_app_update,
            updater::open_app_update_page,
            metadata_fetcher::search_track_metadata, metadata_fetcher::fetch_and_process_tags,
            metadata_fetcher::init_metadata_context, metadata_fetcher::get_unclassified_tags,
            metadata_fetcher::update_custom_dictionary, metadata_fetcher::sync_dictionary_to_db,
            overlay_server::update_overlay_state,
            overlay_server::update_overlay_style,
            overlay_server::update_overlay_lyrics,
            overlay_server::update_overlay_lyrics_full,
            overlay_server::get_overlay_state,
            overlay_server::get_lan_addresses,
            meloming::meloming_get_user_profile,
            meloming::meloming_get_channel_id,
            meloming::meloming_set_channel_id,
            meloming::meloming_test_connection,
            meloming::meloming_pull_songs,
            meloming::meloming_get_credentials,
            meloming::meloming_set_credentials,
            meloming::meloming_oauth_status,
            meloming::meloming_oauth_start,
            meloming::meloming_oauth_finish,
            meloming::meloming_oauth_logout,
            meloming::meloming_push_songs
        ])

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
