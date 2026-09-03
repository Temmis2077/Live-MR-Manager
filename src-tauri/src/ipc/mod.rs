//! Single source for OSW frontend/backend contracts.
//!
//! The first migration slice covers read-only output-device commands. Existing
//! commands continue through the legacy handler while domains are migrated.

pub mod error;

use specta_typescript::Typescript;
use tauri_specta::{collect_commands, collect_events, Builder};

pub use error::ApiError;

pub fn contract_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        crate::audio_commands::list_output_devices,
        crate::audio_commands::get_output_device,
        crate::audio_commands::set_output_device,
        crate::audio_commands::get_mr_output_device,
        crate::audio_commands::play_track,
        crate::audio_commands::toggle_playback,
        crate::audio_commands::stop_playback,
        crate::audio_commands::seek_to,
        crate::audio_commands::get_playback_state,
        crate::audio_commands::set_mr_output_device,
        crate::audio_commands::get_mix_state,
        crate::audio_commands::set_track_fader,
        crate::audio_commands::set_track_mute,
        crate::audio_commands::set_track_solo,
        crate::audio_commands::set_channel_route,
        crate::audio_commands::set_metronome,
        crate::audio_commands::set_bus_delay,
        crate::audio_commands::set_limiter,
        crate::library::load_library,
        crate::library::save_library,
        crate::library::update_song_metadata,
        crate::library::delete_song,
        crate::library::get_genres,
        crate::library::get_categories,
        crate::library::prune_unused_taxonomy,
    ])
    .events(collect_events![
        crate::types::PlaybackProgress,
        crate::types::PlaybackStatus,
    ])
}

pub fn export_typescript(path: impl AsRef<std::path::Path>) -> Result<(), String> {
    contract_builder()
        .export(Typescript::default(), path)
        .map_err(|error| error.to_string())
}

/// The only runtime command registry. Tauri accepts one invoke handler, so all
/// legacy and migrated domains stay in this list until contract generation has
/// reached 100% coverage.
pub fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::audio_commands::get_model_settings, crate::audio_commands::update_model_settings,
        crate::audio_commands::play_track, crate::audio_commands::toggle_playback, crate::audio_commands::stop_playback, crate::audio_commands::seek_to, crate::audio_commands::set_pitch, crate::audio_commands::set_tempo, crate::audio_commands::set_volume, crate::audio_commands::set_master_volume,
        crate::audio_commands::set_vocal_balance, crate::audio_commands::toggle_ai_feature,
        crate::audio_commands::list_output_devices, crate::audio_commands::get_output_device, crate::audio_commands::set_output_device,
        crate::audio_commands::get_mr_output_device, crate::audio_commands::set_mr_output_device,
        crate::audio_commands::set_channel_route, crate::audio_commands::set_metronome, crate::audio_commands::set_bus_delay, crate::audio_commands::set_limiter,
        crate::audio_commands::get_mix_state, crate::audio_commands::set_track_fader, crate::audio_commands::set_track_mute, crate::audio_commands::set_track_solo,
        crate::model_commands::check_mr_separated, crate::model_commands::get_separation_info,
        crate::model_commands::delete_mr, crate::model_commands::start_mr_separation,
        crate::model_commands::youtube_metadata_fetcher,
        crate::library::get_audio_metadata, crate::audio_commands::get_playback_state,
        crate::model_commands::check_ai_runtime, crate::model_commands::check_model_ready, crate::model_commands::download_ai_model,
        crate::library::save_library, crate::library::load_library, crate::library::get_songs, crate::library::get_categories, crate::library::get_genres,
        crate::library::get_track_count, crate::library::prune_unused_taxonomy,
        crate::model_commands::cancel_separation, crate::model_commands::set_broadcast_mode,
        crate::model_commands::get_mr_cache_format, crate::model_commands::set_mr_cache_format,
        crate::system::get_audio_devices, crate::system::open_cache_folder,
        crate::system::open_mr_folder, crate::system::open_log_folder,
        crate::system::get_mr_cache_dir, crate::system::set_mr_cache_dir,
        crate::system::reset_mr_cache_dir, crate::model_commands::delete_ai_model,
        crate::model_commands::get_gpu_recommendation, crate::model_commands::list_model_presets,
        crate::model_commands::list_all_models, crate::model_commands::list_custom_models,
        crate::model_commands::add_custom_model, crate::model_commands::remove_custom_model,
        crate::library::add_category, crate::library::delete_category,
        crate::library::delete_song, crate::library::map_track_to_categories,
        crate::system::get_app_paths, crate::system::pick_audio_files,
        crate::system::open_lyrics_window, crate::gpu_pack::get_gpu_pack_status,
        crate::gpu_pack::open_gpu_pack_dir, crate::gpu_pack::install_gpu_pack,
        crate::gpu_pack::cancel_gpu_pack_install, crate::dereverb::get_dereverb_status,
        crate::dereverb::set_dereverb_enabled, crate::dereverb::open_dereverb_dir,
        crate::search::search_youtube, crate::search::search_lyrics_sites,
        crate::lyrics_db::fetch_synced_lyrics, crate::lyrics_db::autofill_song_info,
        crate::system::export_backup, crate::system::import_backup,
        crate::system::export_library_spreadsheet, crate::system::import_library_spreadsheet,
        crate::rescue::run_cache_rescue, crate::rescue::run_local_rescue,
        crate::model_commands::get_active_separations, crate::audio_commands::get_ai_engine_status,
        crate::library::update_song_metadata, crate::key_bpm::analyze_key_bpm,
        crate::audio_commands::get_alignment_sync_state,
        crate::alignment::get_separated_audio_list, crate::alignment::run_forced_alignment,
        crate::alignment::cancel_forced_alignment, crate::alignment::read_audio_file,
        crate::alignment::apply_alignment_tuning, crate::alignment::write_alignment_debug_trace,
        crate::alignment::get_waveform_summary, crate::alignment::get_model_list,
        crate::alignment::download_alignment_model, crate::alignment::list_downloadable_alignment_models,
        crate::alignment::save_lrc_file, crate::alignment::load_lrc_file,
        crate::alignment::save_lrc_checkpoint, crate::alignment::load_lrc_checkpoint,
        crate::alignment::discard_lrc_checkpoint, crate::alignment::restore_lrc_checkpoint,
        crate::alignment::save_alignment_metadata, crate::alignment::load_alignment_metadata,
        crate::system::remote_js_log, crate::updater::check_for_app_update,
        crate::updater::open_app_update_page, crate::metadata_fetcher::search_track_metadata,
        crate::metadata_fetcher::fetch_and_process_tags, crate::metadata_fetcher::init_metadata_context,
        crate::overlay_server::update_overlay_state, crate::overlay_server::update_overlay_style,
        crate::overlay_server::update_overlay_lyrics, crate::overlay_server::update_overlay_lyrics_full,
        crate::overlay_server::get_overlay_state, crate::overlay_server::get_lan_addresses,
        crate::overlay_server::update_overlay_progress,
        crate::meloming::meloming_get_user_profile, crate::meloming::meloming_get_channel_id,
        crate::meloming::meloming_set_channel_id, crate::meloming::meloming_test_connection,
        crate::meloming::meloming_pull_songs, crate::meloming::meloming_get_credentials,
        crate::meloming::meloming_set_credentials, crate::meloming::meloming_oauth_status,
        crate::meloming::meloming_oauth_start, crate::meloming::meloming_oauth_finish,
        crate::meloming::meloming_oauth_logout, crate::meloming::meloming_push_songs
    ]
}
