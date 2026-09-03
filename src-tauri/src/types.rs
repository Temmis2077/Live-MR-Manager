use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Pending,
    Downloading,
    Decoding,
    Separating,
    Playing,
    Paused,
    Error,
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "playback-status")]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub status: Status,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "playback-progress")]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProgress {
    pub position_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub current_track: Option<String>,
    pub pitch: f32,
    pub tempo: f32,
    pub volume: f32,
    pub vocal_balance: f32,
    pub vocal_enabled: bool,
    pub lyric_enabled: bool,
    pub is_playing: bool,
    // 트랙별 독립 페이더(0~100%, 볼륨·밸런스 위에 곱해지는 트림) + 음소거/솔로.
    pub vocal_fader: f32,
    pub backing_fader: f32,
    pub inst_fader: f32,
    pub vocal_muted: bool,
    pub backing_muted: bool,
    pub inst_muted: bool,
    pub vocal_solo: bool,
    pub backing_solo: bool,
    pub inst_solo: bool,
    // 채널 라우팅: 각 채널(모니터/MR)이 어떤 소스를 포함하는지.
    // 모니터 = 내가 듣는 것, MR = 방송 출력(2번째 장치).
    pub mon_route_vocal: bool,
    pub mon_route_backing: bool,
    pub mon_route_inst: bool,
    pub mon_route_metro: bool,
    pub mr_route_vocal: bool,
    pub mr_route_backing: bool,
    pub mr_route_inst: bool,
    pub mr_route_metro: bool,
    // 메트로놈(3번째 소스).
    pub metro_enabled: bool,
    pub metro_bpm: f32,  // 0 = 곡 분석 BPM 자동
    pub metro_gain: f32, // 페이더 0~100
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_track: None,
            pitch: 0.0,
            tempo: 1.0,
            volume: 80.0,
            vocal_balance: 50.0,
            vocal_enabled: true,
            lyric_enabled: false,
            is_playing: false,
            vocal_fader: 100.0,
            backing_fader: 100.0,
            inst_fader: 100.0,
            vocal_muted: false,
            backing_muted: false,
            inst_muted: false,
            vocal_solo: false,
            backing_solo: false,
            inst_solo: false,
            // 모니터는 기본으로 보컬+MR을 다 들음(가이드), MR 채널은 반주만.
            mon_route_vocal: true,
            mon_route_backing: true,
            mon_route_inst: true,
            mon_route_metro: false,
            mr_route_vocal: false,
            mr_route_backing: true,
            mr_route_inst: true,
            mr_route_metro: false,
            metro_enabled: false,
            metro_bpm: 0.0,
            metro_gain: 80.0,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Genre {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SongMetadata {
    pub id: Option<i64>,
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub source: String,
    pub path: String,
    pub pitch: Option<f32>,
    pub tempo: Option<f32>,
    pub volume: Option<f32>,
    pub artist: Option<String>,
    pub tags: Option<Vec<String>>,
    pub genre: Option<String>,
    pub categories: Option<Vec<String>>,
    pub play_count: Option<u32>,
    pub date_added: Option<u64>,
    pub is_mr: Option<bool>,
    pub is_separated: Option<bool>,
    pub has_lyrics: Option<bool>,
    /// 가사 싱크 상태: "synced"(타임스탬프 있음) / "unsynced"(가사만) / "none"(가사 없음).
    /// `get_songs_internal`에서만 채워지고, 다른 생성 경로는 None.
    #[serde(default)]
    pub lyric_sync_status: Option<String>,
    pub original_title: Option<String>,
    pub translated_title: Option<String>,
    pub curation_category: Option<String>,
    #[serde(default, alias = "key")]
    pub song_key: Option<String>,
    pub bpm: Option<i32>,
    pub difficulty: Option<u8>,
    pub proficiency: Option<u8>,
    pub karaoke_url: Option<String>,
    pub cover_url: Option<String>,
    pub original_url: Option<String>,
    pub lyrics_link: Option<String>,
    pub meloming_song_id: Option<i64>,
    pub meloming_channel_id: Option<i64>,
    pub meloming_artist_id: Option<i64>,
    /// 멜로밍 API `categoryIds` (1–N개)
    pub meloming_category_ids: Option<Vec<i64>>,
    pub sync_status: Option<String>,
}
