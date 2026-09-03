# OSW IPC 카탈로그

> 자동 생성 파일. `npm run generate:ipc`로 갱신합니다.

- Rust command: 111
- 생성 TypeScript command: 25
- 직접 호출이 확인된 command: 110
- 확인된 event: 15
- 생성 TypeScript event: 2

| Command | Domain | Migration | Frontend callers | Rust owner |
| --- | --- | --- | --- | --- |
| `add_category` | library | legacy | — | `src-tauri/src/library.rs` |
| `add_custom_model` | model | legacy | `src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `cancel_gpu_pack_install` | integrations | legacy | `src/js/gpu-pack.js` | `src-tauri/src/gpu_pack.rs` |
| `cancel_separation` | model | legacy | `src/js/audio.js` | `src-tauri/src/model_commands.rs` |
| `check_ai_runtime` | model | legacy | — | `src-tauri/src/model_commands.rs` |
| `check_for_app_update` | integrations | legacy | `src/js/settings-api.js` | `src-tauri/src/updater.rs` |
| `check_model_ready` | model | legacy | `src/js/audio.js`<br>`src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `check_mr_separated` | model | legacy | `src/js/audio.js`<br>`src/js/events/backend.js`<br>`src/js/ui/components.js` | `src-tauri/src/model_commands.rs` |
| `delete_ai_model` | model | legacy | `src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `delete_category` | library | legacy | — | `src-tauri/src/library.rs` |
| `delete_mr` | model | legacy | `src/js/audio.js` | `src-tauri/src/model_commands.rs` |
| `delete_song` | library | typed | `src/ipc/services/library.ts` | `src-tauri/src/library.rs` |
| `download_ai_model` | model | legacy | `src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `export_backup` | system | legacy | `src/js/settings-api.js` | `src-tauri/src/system.rs` |
| `export_library_spreadsheet` | system | legacy | `src/js/settings-api.js` | `src-tauri/src/system.rs` |
| `fetch_and_process_tags` | integrations | legacy | — | `src-tauri/src/metadata_fetcher.rs` |
| `get_active_separations` | model | legacy | `src/js/events/backend.js`<br>`src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `get_ai_engine_status` | audio | legacy | — | `src-tauri/src/audio_commands.rs` |
| `get_alignment_sync_state` | audio | legacy | — | `src-tauri/src/audio_commands.rs` |
| `get_app_paths` | system | legacy | — | `src-tauri/src/system.rs` |
| `get_audio_devices` | system | legacy | — | `src-tauri/src/system.rs` |
| `get_audio_metadata` | library | legacy | `src/js/audio.js` | `src-tauri/src/library.rs` |
| `get_categories` | library | typed | `src/ipc/services/library.ts` | `src-tauri/src/library.rs` |
| `get_dereverb_status` | integrations | legacy | `src/js/dereverb.js` | `src-tauri/src/dereverb.rs` |
| `get_genres` | library | typed | `src/ipc/services/library.ts` | `src-tauri/src/library.rs` |
| `get_gpu_pack_status` | integrations | legacy | `src/js/ui/components.js` | `src-tauri/src/gpu_pack.rs` |
| `get_gpu_recommendation` | model | legacy | `src/main.js` | `src-tauri/src/model_commands.rs` |
| `get_lan_addresses` | overlay | legacy | `src/js/overlay-api.js` | `src-tauri/src/overlay_server.rs` |
| `get_mix_state` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `get_model_settings` | audio | legacy | `src/js/audio.js`<br>`src/js/model-api.js`<br>`src/js/separation-mode-modal.js`<br>`src/js/ui/add-song-modal.js` | `src-tauri/src/audio_commands.rs` |
| `get_mr_cache_dir` | system | legacy | `src/js/events/controls/settings.js` | `src-tauri/src/system.rs` |
| `get_mr_cache_format` | model | legacy | `src/js/settings-api.js` | `src-tauri/src/model_commands.rs` |
| `get_mr_output_device` | audio | typed | `src/ipc/services/audio.ts` | `src-tauri/src/audio_commands.rs` |
| `get_output_device` | audio | typed | `src/ipc/services/audio.ts` | `src-tauri/src/audio_commands.rs` |
| `get_overlay_state` | overlay | legacy | `src/js/overlay/shared.js` | `src-tauri/src/overlay_server.rs` |
| `get_playback_state` | audio | typed | `src/ipc/services/playback.ts` | `src-tauri/src/audio_commands.rs` |
| `get_separation_info` | model | legacy | `src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `get_songs` | library | legacy | — | `src-tauri/src/library.rs` |
| `get_track_count` | library | legacy | — | `src-tauri/src/library.rs` |
| `import_backup` | system | legacy | `src/js/settings-api.js` | `src-tauri/src/system.rs` |
| `import_library_spreadsheet` | system | legacy | `src/js/settings-api.js` | `src-tauri/src/system.rs` |
| `init_metadata_context` | integrations | legacy | `src/main.js` | `src-tauri/src/metadata_fetcher.rs` |
| `install_gpu_pack` | integrations | legacy | `src/js/gpu-pack.js` | `src-tauri/src/gpu_pack.rs` |
| `list_all_models` | model | legacy | `src/js/model-api.js`<br>`src/js/separation-mode-modal.js`<br>`src/js/ui/add-song-modal.js` | `src-tauri/src/model_commands.rs` |
| `list_custom_models` | model | legacy | `src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `list_model_presets` | model | legacy | `src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `list_output_devices` | audio | typed | `src/ipc/services/audio.ts` | `src-tauri/src/audio_commands.rs` |
| `load_library` | library | typed | `src/ipc/services/library.ts` | `src-tauri/src/library.rs` |
| `map_track_to_categories` | library | legacy | — | `src-tauri/src/library.rs` |
| `meloming_get_channel_id` | meloming | legacy | — | `src-tauri/src/meloming/commands.rs` |
| `meloming_get_credentials` | meloming | legacy | — | `src-tauri/src/meloming/commands.rs` |
| `meloming_get_user_profile` | meloming | legacy | `src/js/events/meloming.js` | `src-tauri/src/meloming/commands.rs` |
| `meloming_oauth_finish` | meloming | legacy | — | `src-tauri/src/meloming/commands.rs` |
| `meloming_oauth_logout` | meloming | legacy | `src/js/events/meloming.js` | `src-tauri/src/meloming/commands.rs` |
| `meloming_oauth_start` | meloming | legacy | `src/js/events/meloming.js` | `src-tauri/src/meloming/commands.rs` |
| `meloming_oauth_status` | meloming | legacy | — | `src-tauri/src/meloming/commands.rs` |
| `meloming_pull_songs` | meloming | legacy | `src/js/events/meloming.js` | `src-tauri/src/meloming/commands.rs` |
| `meloming_push_songs` | meloming | legacy | `src/js/events/meloming.js` | `src-tauri/src/meloming/commands.rs` |
| `meloming_set_channel_id` | meloming | legacy | — | `src-tauri/src/meloming/commands.rs` |
| `meloming_set_credentials` | meloming | legacy | — | `src-tauri/src/meloming/commands.rs` |
| `meloming_test_connection` | meloming | legacy | — | `src-tauri/src/meloming/commands.rs` |
| `open_app_update_page` | integrations | legacy | `src/js/settings-api.js`<br>`src/js/utils.js` | `src-tauri/src/updater.rs` |
| `open_cache_folder` | system | legacy | `src/js/settings-api.js` | `src-tauri/src/system.rs` |
| `open_dereverb_dir` | integrations | legacy | `src/js/dereverb.js` | `src-tauri/src/dereverb.rs` |
| `open_gpu_pack_dir` | integrations | legacy | `src/main.js` | `src-tauri/src/gpu_pack.rs` |
| `open_log_folder` | system | legacy | `src/js/settings-api.js` | `src-tauri/src/system.rs` |
| `open_lyrics_window` | system | legacy | `src/js/events/controls/playback.js`<br>`src/js/ui/app-bar.js` | `src-tauri/src/system.rs` |
| `open_mr_folder` | system | legacy | `src/js/events/controls/playback.js`<br>`src/js/ui/library-panels.js` | `src-tauri/src/system.rs` |
| `pick_audio_files` | system | legacy | `src/js/ui/add-song-modal.js`<br>`src/js/ui/onboarding-ui.js` | `src-tauri/src/system.rs` |
| `play_track` | audio | typed | `src/ipc/services/playback.ts` | `src-tauri/src/audio_commands.rs` |
| `prune_unused_taxonomy` | library | typed | `src/ipc/services/library.ts` | `src-tauri/src/library.rs` |
| `remote_js_log` | system | legacy | `src/js/ui/components.js`<br>`src/js/ui/core.js`<br>`src/js/ui/library.js`<br>`src/js/utils.js`<br>`src/main.js` | `src-tauri/src/system.rs` |
| `remove_custom_model` | model | legacy | `src/js/model-api.js` | `src-tauri/src/model_commands.rs` |
| `reset_mr_cache_dir` | system | legacy | `src/js/events/controls/settings.js` | `src-tauri/src/system.rs` |
| `run_cache_rescue` | integrations | legacy | `src/js/settings-api.js` | `src-tauri/src/rescue.rs` |
| `run_local_rescue` | integrations | legacy | — | `src-tauri/src/rescue.rs` |
| `save_library` | library | typed | `src/ipc/services/library.ts` | `src-tauri/src/library.rs` |
| `search_lyrics_sites` | integrations | legacy | `src/js/ui/add-song-modal.js` | `src-tauri/src/search.rs` |
| `search_track_metadata` | integrations | legacy | `src/js/events/modals.js` | `src-tauri/src/metadata_fetcher.rs` |
| `search_youtube` | integrations | legacy | `src/js/ui/add-song-modal.js` | `src-tauri/src/search.rs` |
| `seek_to` | audio | typed | `src/ipc/services/playback.ts` | `src-tauri/src/audio_commands.rs` |
| `set_broadcast_mode` | model | legacy | `src/js/settings-api.js` | `src-tauri/src/model_commands.rs` |
| `set_bus_delay` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `set_channel_route` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `set_dereverb_enabled` | integrations | legacy | `src/js/dereverb.js` | `src-tauri/src/dereverb.rs` |
| `set_limiter` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `set_master_volume` | audio | legacy | `src/js/audio.js`<br>`src/js/live-screen.js` | `src-tauri/src/audio_commands.rs` |
| `set_metronome` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `set_mr_cache_dir` | system | legacy | `src/js/events/controls/settings.js` | `src-tauri/src/system.rs` |
| `set_mr_cache_format` | model | legacy | `src/js/settings-api.js` | `src-tauri/src/model_commands.rs` |
| `set_mr_output_device` | audio | typed | `src/ipc/services/audio.ts` | `src-tauri/src/audio_commands.rs` |
| `set_output_device` | audio | typed | `src/ipc/services/audio.ts` | `src-tauri/src/audio_commands.rs` |
| `set_pitch` | audio | legacy | `src/js/audio.js`<br>`src/js/live-screen.js` | `src-tauri/src/audio_commands.rs` |
| `set_tempo` | audio | legacy | `src/js/audio.js`<br>`src/js/live-screen.js` | `src-tauri/src/audio_commands.rs` |
| `set_track_fader` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `set_track_mute` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `set_track_solo` | audio | typed | `src/ipc/services/mixer.ts` | `src-tauri/src/audio_commands.rs` |
| `set_vocal_balance` | audio | legacy | `src/js/audio.js`<br>`src/js/live-screen.js` | `src-tauri/src/audio_commands.rs` |
| `set_volume` | audio | legacy | `src/js/audio.js`<br>`src/js/events/modals.js` | `src-tauri/src/audio_commands.rs` |
| `start_mr_separation` | model | legacy | `src/js/audio.js` | `src-tauri/src/model_commands.rs` |
| `stop_playback` | audio | typed | `src/ipc/services/playback.ts` | `src-tauri/src/audio_commands.rs` |
| `toggle_ai_feature` | audio | legacy | `src/js/audio.js`<br>`src/js/live-screen.js`<br>`src/js/player.js` | `src-tauri/src/audio_commands.rs` |
| `toggle_playback` | audio | typed | `src/ipc/services/playback.ts` | `src-tauri/src/audio_commands.rs` |
| `update_model_settings` | audio | legacy | `src/js/model-api.js`<br>`src/js/separation-mode-modal.js` | `src-tauri/src/audio_commands.rs` |
| `update_overlay_lyrics` | overlay | legacy | `src/js/lyric-drawer.js`<br>`src/js/overlay-api.js` | `src-tauri/src/overlay_server.rs` |
| `update_overlay_lyrics_full` | overlay | legacy | `src/js/lyric-drawer.js` | `src-tauri/src/overlay_server.rs` |
| `update_overlay_progress` | overlay | legacy | `src/js/lyric-drawer.js` | `src-tauri/src/overlay_server.rs` |
| `update_overlay_state` | overlay | legacy | `src/js/events/backend.js`<br>`src/js/player.js` | `src-tauri/src/overlay_server.rs` |
| `update_overlay_style` | overlay | legacy | `src/js/overlay-api.js` | `src-tauri/src/overlay_server.rs` |
| `update_song_metadata` | library | typed | `src/ipc/services/library.ts` | `src-tauri/src/library.rs` |
| `youtube_metadata_fetcher` | model | legacy | `src/js/audio.js` | `src-tauri/src/model_commands.rs` |

## Events

| Event | Payload | Migration | Rust emitters | Frontend listeners |
| --- | --- | --- | --- | --- |
| `ai_model_status_update` | unknown | legacy | — | `src/js/events/backend.js` |
| `alignment-model-download-progress` | unknown | legacy | — | `src/js/alignment-viewer.js` |
| `alignment-progress` | unknown | legacy | `src-tauri/src/alignment.rs` | `src/js/alignment-queue.js` |
| `app-update-available` | unknown | legacy | `src-tauri/src/updater.rs` | `src/js/update-check.js` |
| `gpu-pack-install-progress` | unknown | legacy | `src-tauri/src/gpu_pack.rs` | `src/js/gpu-pack.js` |
| `meloming-oauth-complete` | unknown | legacy | `src-tauri/src/meloming/oauth.rs` | `src/js/events/meloming.js` |
| `model-download-progress` | unknown | legacy | `src-tauri/src/model_manager.rs` | `src/js/events/backend.js` |
| `overlay-state-update` | unknown | legacy | `src-tauri/src/overlay_server.rs` | `src/js/overlay/shared.js` |
| `playback-progress` | `PlaybackProgress` | typed | `src-tauri/src/audio_commands.rs` | `src/ipc/services/playback.ts` |
| `playback-status` | `PlaybackStatus` | typed | `src-tauri/src/audio_commands.rs`<br>`src-tauri/src/model_commands.rs` | `src/ipc/services/playback.ts` |
| `separation-progress` | unknown | legacy | `src-tauri/src/model_commands.rs`<br>`src-tauri/src/separation/task.rs`<br>`src-tauri/src/youtube.rs` | `src/js/events/backend.js` |
| `sys-log` | unknown | legacy | `src-tauri/src/audio_player.rs` | — |
| `tauri://drag-drop` | unknown | legacy | — | `src/js/events/backend.js` |
| `youtube-download-finished` | unknown | legacy | `src-tauri/src/youtube.rs` | — |
| `youtube-download-progress` | unknown | legacy | `src-tauri/src/youtube.rs` | `src/js/alignment-viewer.js` |
