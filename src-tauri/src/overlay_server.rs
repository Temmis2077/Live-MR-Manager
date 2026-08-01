use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use futures_util::{SinkExt, StreamExt};
use serde::{Serialize, Deserialize};
use once_cell::sync::Lazy;
use tauri::Emitter;


#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OverlayStyle {
    pub scale: f32,
    pub font: String,
    pub color: String,
    pub text_color: String,
    pub bg_color: String,
    pub bg_opacity: f32,
    pub rounding: f32,
    pub animation_direction: String,
    /// 가사 오버레이 전용 폰트 크기(px). 0 = 기본값(22px) 사용.
    #[serde(default)]
    pub font_size: f32,
    /// 은은한 플로팅(위아래로 살짝 떠다니는) 효과. 대상(정보/가사)별 독립 설정.
    #[serde(default)]
    pub effect_float: bool,
    /// 액센트 색 글로우 펄스 효과. 대상별 독립 설정.
    #[serde(default)]
    pub effect_glow: bool,
    /// 화면에 무엇을 보여줄지 (카드·커버·라벨·가수·키/BPM·다음 줄).
    #[serde(default)]
    pub visibility: OverlayVisibility,

    /// 글자 외곽선 두께(px). 0이면 없음. 밝은 방송 화면에서 가사가 배경에
    /// 묻히지 않게 하는 가장 실전적인 수단이라 별도 축으로 둔다.
    #[serde(default)]
    pub outline_width: f32,
    /// 글자 외곽선 색(hex, # 없이).
    #[serde(default = "black_hex")]
    pub outline_color: String,
    /// 그림자 세기(0~1). 0이면 그림자 없음.
    #[serde(default)]
    pub shadow: f32,
    /// 카드 배경에 그라디언트를 쓸지. 켜면 bg_color에서 gradient_color로 흐른다.
    #[serde(default)]
    pub gradient: bool,
    /// 그라디언트의 두 번째 색(hex, # 없이).
    #[serde(default = "black_hex")]
    pub gradient_color: String,
}

fn black_hex() -> String {
    "000000".to_string()
}

/// 오버레이에 무엇을 보여줄지. 방송마다 화면에 남길 정보량이 다르고(가사만
/// 크게 띄우는 사람, 곡 정보까지 다 띄우는 사람), 카드 배경 없이 글자만
/// 얹고 싶은 경우도 흔해서 항목별로 끄고 켤 수 있어야 한다.
///
/// 기존 사용자의 저장값에는 이 필드가 없으므로 전부 `#[serde(default)]`이며,
/// 기본값은 "예전과 같은 화면"이 되도록 잡았다(끄면 사라지는 쪽이 안전하다).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverlayVisibility {
    /// 카드(유리 배경 박스). 끄면 배경 없이 글자만 나간다.
    #[serde(default = "yes")]
    pub card: bool,
    /// 앨범 커버 이미지 (곡 정보 오버레이).
    #[serde(default = "yes")]
    pub cover: bool,
    /// "NOW PLAYING" 라벨.
    #[serde(default = "yes")]
    pub label: bool,
    /// 가수명.
    #[serde(default = "yes")]
    pub artist: bool,
    /// 키·빠르기 배지. 원곡과 다르게 부를 때만 의미가 있어 기본은 꺼둔다.
    #[serde(default)]
    pub key_bpm: bool,
    /// 가사 오버레이의 다음 줄 미리 보여주기.
    #[serde(default = "yes")]
    pub next_line: bool,
    /// 곡 진행바. 기본은 꺼둔다 — 방송 화면에 줄 하나가 더 생기는 일이라
    /// 원하는 사람만 켜는 쪽이 안전하다.
    #[serde(default)]
    pub progress: bool,
}

fn yes() -> bool {
    true
}

impl Default for OverlayVisibility {
    fn default() -> Self {
        Self {
            card: true,
            cover: true,
            label: true,
            artist: true,
            key_bpm: false,
            next_line: true,
            progress: false,
        }
    }
}

impl Default for OverlayStyle {
    fn default() -> Self {
        Self {
            scale: 1.0,
            font: "Inter".to_string(),
            color: "8b5cf6".to_string(),
            text_color: "ffffff".to_string(),
            bg_color: "0f0f14".to_string(),
            bg_opacity: 0.6,
            rounding: 20.0,
            animation_direction: "left".to_string(),
            font_size: 0.0,
            effect_float: false,
            effect_glow: false,
            visibility: OverlayVisibility::default(),
            outline_width: 0.0,
            outline_color: black_hex(),
            shadow: 0.0,
            gradient: false,
            gradient_color: black_hex(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OverlayState {
    pub title: String,
    pub artist: String,
    pub thumbnail: String,
    pub is_playing: bool,
    pub current_lyric: String,
    pub next_lyric: String,
    pub theme_mode: String,

    pub info_style: OverlayStyle,
    pub lyrics_style: OverlayStyle,

    pub is_force_visible: bool,

    /// 가사 뷰 페이지(/lyrics-view, OBS 독용 전체 가사 화면)를 위한 상태.
    /// 곡의 전체 가사 줄 목록과 현재 부르는 줄 인덱스(-1 = 아직 시작 전).
    #[serde(default)]
    pub lyrics_lines: Vec<String>,
    #[serde(default = "default_lyric_index")]
    pub lyric_index: i32,
    /// 곡 메타데이터의 키/BPM — 가사 뷰 헤더 표시용(없으면 빈 값/0).
    #[serde(default)]
    pub song_key: String,
    #[serde(default)]
    pub bpm: f64,

    /// 진행바용 재생 위치·길이(ms). 오버레이가 스스로 시간을 세지 않고
    /// 앱이 알려주는 값만 그린다 — 두 화면의 위치가 어긋나면 안 된다.
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default)]
    pub duration_ms: u64,
}

fn default_lyric_index() -> i32 {
    -1
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            title: "Ready to Play".to_string(),
            artist: "Waiting for music...".to_string(),
            thumbnail: "".to_string(),
            is_playing: false,
            current_lyric: "".to_string(),
            next_lyric: "".to_string(),
            theme_mode: "dark".to_string(),
            info_style: OverlayStyle::default(),
            lyrics_style: OverlayStyle {
                color: "ffffff".to_string(),
                ..OverlayStyle::default()
            },
            is_force_visible: false,
            lyrics_lines: Vec::new(),
            lyric_index: -1,
            song_key: String::new(),
            bpm: 0.0,
            position_ms: 0,
            duration_ms: 0,
        }
    }
}


type PeerMap = Arc<Mutex<HashMap<SocketAddr, mpsc::UnboundedSender<Message>>>>;

static PEERS: Lazy<PeerMap> = Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));
static CURRENT_STATE: Lazy<Mutex<OverlayState>> = Lazy::new(|| Mutex::new(OverlayState::default()));
static APP_HANDLE: Lazy<Mutex<Option<tauri::AppHandle>>> = Lazy::new(|| Mutex::new(None));

pub fn init(handle: tauri::AppHandle) {
    let mut h = APP_HANDLE.blocking_lock();
    *h = Some(handle);
}

static OVERLAY_INFO_HTML: &str = include_str!("../../src/overlay-info.html");
static OVERLAY_LYRICS_HTML: &str = include_str!("../../src/overlay-lyrics.html");
static LYRICS_VIEW_HTML: &str = include_str!("../../src/lyrics-view.html");
static OVERLAY_SHARED_JS: &str = include_str!("../../src/js/overlay/shared.js");
static APP_ICON: &[u8] = include_bytes!("../../src/assets/images/app-icon.png");

fn resolve_overlay_info_html() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/overlay-info.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    OVERLAY_INFO_HTML.to_string()
}

fn resolve_overlay_lyrics_html() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/overlay-lyrics.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    OVERLAY_LYRICS_HTML.to_string()
}

fn resolve_lyrics_view_html() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lyrics-view.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    LYRICS_VIEW_HTML.to_string()
}

fn resolve_overlay_shared_js() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/js/overlay/shared.js");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    OVERLAY_SHARED_JS.to_string()
}

pub async fn start_overlay_server() {
    // 1. Start WebSocket Data Server (Port 14201)
    let ws_addr = "0.0.0.0:14201".to_string();
    let ws_listener = match TcpListener::bind(&ws_addr).await {
        Ok(listener) => listener,
        Err(e) => {
            crate::audio_player::sys_log(&format!(
                "[Overlay] WebSocket bind failed on {}: {}. Overlay server disabled for this run.",
                ws_addr, e
            ));
            return;
        }
    };
    println!("[Overlay] WebSocket Data Server listening on: {}", ws_addr);

    tokio::spawn(async move {
        while let Ok((stream, addr)) = ws_listener.accept().await {
            tokio::spawn(handle_ws_connection(PEERS.clone(), stream, addr));
        }
    });

    // 2. Start HTTP Page Server (Port 14202)
    let http_addr = "0.0.0.0:14202".to_string();
    let http_listener = match TcpListener::bind(&http_addr).await {
        Ok(listener) => listener,
        Err(e) => {
            crate::audio_player::sys_log(&format!(
                "[Overlay] HTTP bind failed on {}: {}. Overlay pages disabled for this run.",
                http_addr, e
            ));
            return;
        }
    };
    println!("[Overlay] HTTP Page Server listening on: {}", http_addr);

    tokio::spawn(async move {
        while let Ok((mut stream, addr)) = http_listener.accept().await {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buffer = [0; 1024];
                if let Ok(n) = stream.read(&mut buffer).await {
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    
                    if request.starts_with("GET /assets/images/app-icon.png") {
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: image/png\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: public, max-age=86400\r\n\
                            Connection: close\r\n\r\n",
                            APP_ICON.len()
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.write_all(APP_ICON).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] Served app-icon.png to {}", addr);
                    } else if request.starts_with("GET /js/overlay/shared.js") {
                        // The overlay HTML pages reference this shared script.
                        // Without this route it 404s over the network (OBS / LAN),
                        // leaving `window.OverlayShared` undefined so the overlay
                        // never connects. (The in-app preview loads it from the
                        // Tauri bundle, which is why this only breaks externally.)
                        let js = resolve_overlay_shared_js();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: application/javascript; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            js.len(),
                            js
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] Served shared.js to {}", addr);
                    } else if request.starts_with("GET /lyrics-view") {
                        // 가사 뷰 — 퍼포머 본인이 보는 전체 가사 페이지(OBS 커스텀
                        // 독/브라우저용). 아래 `/lyrics` 프리픽스 분기보다 먼저
                        // 매칭해야 하므로 이 순서를 유지할 것.
                        let html = resolve_lyrics_view_html();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: /lyrics-view)", addr);
                    } else if request.starts_with("GET /lyrics")
                        || request.starts_with("GET /overlay-lyrics")
                    {
                        let html = resolve_overlay_lyrics_html();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: /lyrics or /overlay-lyrics)", addr);
                    } else if request.starts_with("GET / ")
                        || request.starts_with("GET /overlay-info")
                    {
                        let html = resolve_overlay_info_html();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: / or /overlay-info)", addr);
                    }
                }
            });
        }
    });
}

async fn handle_ws_connection(peers: PeerMap, raw_stream: TcpStream, addr: SocketAddr) {
    println!("[Overlay] New WS connection: {}", addr);
    
    let ws_stream = match tokio_tungstenite::accept_async(raw_stream).await {
        Ok(s) => s,
        Err(e) => {
            println!("[Overlay] WS Handshake failed for {}: {}", addr, e);
            return;
        }
    };
    
    let (tx, mut rx) = mpsc::unbounded_channel();
    peers.lock().await.insert(addr, tx.clone());

    // Send current state immediately on connection
    let state = CURRENT_STATE.lock().await.clone();
    let msg = serde_json::to_string(&state).unwrap();
    let _ = tx.send(Message::Text(msg));

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut recv_task = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            if let Ok(msg) = msg {
                if msg.is_close() {
                    break;
                }
            } else {
                break;
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };

    println!("[Overlay] Connection closed: {}", addr);
    peers.lock().await.remove(&addr);
}

use base64::{Engine as _, engine::general_purpose};

fn ensure_thumbnail_data_uri(thumbnail: String) -> String {
    if thumbnail.is_empty() || thumbnail.starts_with("http") || thumbnail.starts_with("data:") {
        return thumbnail;
    }

    // Handle tauri/asset protocols by stripping them if they are local-ish
    let path_str = if thumbnail.starts_with("tauri://localhost/_up_/") {
        thumbnail.replace("tauri://localhost/_up_/", "")
    } else if thumbnail.starts_with("asset://localhost/") {
         thumbnail.replace("asset://localhost/", "")
    } else {
        thumbnail.clone()
    };

    // Attempt to read local file and convert to Data URI
    if let Ok(bytes) = std::fs::read(&path_str) {
        let b64 = general_purpose::STANDARD.encode(bytes);
        let ext = std::path::Path::new(&path_str)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png");
        return format!("data:image/{};base64,{}", ext, b64);
    }

    thumbnail
}

pub async fn broadcast_overlay_state(mut state: OverlayState) {
    state.thumbnail = ensure_thumbnail_data_uri(state.thumbnail);
    *CURRENT_STATE.lock().await = state.clone();
    let msg = serde_json::to_string(&state).unwrap();
    
    // Broadcast to WebSocket clients (OBS)
    let peers = PEERS.lock().await;
    for tx in peers.values() {
        let _ = tx.send(Message::Text(msg.clone()));
    }

    // Emit to Tauri windows (Internal Preview)
    if let Some(handle) = APP_HANDLE.lock().await.as_ref() {
        let _ = handle.emit("overlay-state-update", state);
    }
}



#[tauri::command]
pub async fn update_overlay_state(title: String, artist: String, thumbnail: String, is_playing: bool, song_key: Option<String>, bpm: Option<f64>) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.title = title;
    state.artist = artist;
    state.thumbnail = thumbnail;
    state.is_playing = is_playing;
    // 가사 뷰(/lyrics-view) 헤더 표시용 — 메타데이터에 있으면 함께 전송.
    state.song_key = song_key.unwrap_or_default();
    state.bpm = bpm.unwrap_or(0.0);
    broadcast_overlay_state(state).await;
}

#[tauri::command]
pub async fn update_overlay_style(target: String, scale: f32, font: String, color: String, text_color: String, bg_color: String, bg_opacity: f32, rounding: f32, is_force_visible: bool, animation_direction: String, theme_mode: String, font_size: Option<f32>, effect_float: Option<bool>, effect_glow: Option<bool>, visibility: Option<OverlayVisibility>, design: Option<OverlayDesignInput>) {
    let mut state = CURRENT_STATE.lock().await.clone();
    // 표시 항목은 프런트가 안 보내면 지금 값을 유지한다 — 색만 바꾸는 호출이
    // 표시 항목을 조용히 기본값으로 되돌리면 안 된다.
    let kept_visibility = if target == "lyrics" {
        state.lyrics_style.visibility.clone()
    } else {
        state.info_style.visibility.clone()
    };
    // 디자인 축도 안 보내면 지금 값을 유지한다(색만 바꾸는 호출이 외곽선을
    // 지워버리면 안 된다).
    let kept_design = {
        let cur = if target == "lyrics" { &state.lyrics_style } else { &state.info_style };
        (cur.outline_width, cur.outline_color.clone(), cur.shadow, cur.gradient, cur.gradient_color.clone())
    };
    let style = OverlayStyle {
        scale,
        font,
        color,
        text_color,
        bg_color,
        bg_opacity,
        rounding,
        animation_direction,
        font_size: font_size.unwrap_or(0.0),
        effect_float: effect_float.unwrap_or(false),
        effect_glow: effect_glow.unwrap_or(false),
        visibility: visibility.unwrap_or(kept_visibility),
        outline_width: design.as_ref().map(|d| d.outline_width).unwrap_or(kept_design.0),
        outline_color: design.as_ref().map(|d| d.outline_color.clone()).unwrap_or(kept_design.1),
        shadow: design.as_ref().map(|d| d.shadow).unwrap_or(kept_design.2),
        gradient: design.as_ref().map(|d| d.gradient).unwrap_or(kept_design.3),
        gradient_color: design.as_ref().map(|d| d.gradient_color.clone()).unwrap_or(kept_design.4),
    };
    let shared_color = style.color.clone();
    let shared_text_color = style.text_color.clone();
    let shared_bg_color = style.bg_color.clone();
    let shared_bg_opacity = style.bg_opacity;

    if target == "lyrics" {
        state.lyrics_style = style;
        state.info_style.color = shared_color;
        state.info_style.text_color = shared_text_color;
        state.info_style.bg_color = shared_bg_color;
        state.info_style.bg_opacity = shared_bg_opacity;
    } else {
        state.info_style = style;
        state.lyrics_style.color = shared_color;
        state.lyrics_style.text_color = shared_text_color;
        state.lyrics_style.bg_color = shared_bg_color;
        state.lyrics_style.bg_opacity = shared_bg_opacity;
    }
    state.is_force_visible = is_force_visible;
    state.theme_mode = if theme_mode.is_empty() { "dark".to_string() } else { theme_mode };
    broadcast_overlay_state(state).await;
}


/// 디자인 축 입력 — update_overlay_style의 인자가 이미 길어서 묶어서 받는다.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverlayDesignInput {
    #[serde(default)]
    pub outline_width: f32,
    #[serde(default = "black_hex")]
    pub outline_color: String,
    #[serde(default)]
    pub shadow: f32,
    #[serde(default)]
    pub gradient: bool,
    #[serde(default = "black_hex")]
    pub gradient_color: String,
}

/// 재생 위치만 갱신한다.
///
/// 전체 상태를 다시 보내지 않는 이유: broadcast_overlay_state는 매번 썸네일을
/// data URI로 만드는데, 진행바는 초당 여러 번 갱신되므로 그걸 매번 돌리면
/// 낭비가 크다. 여기서는 위치만 바꾸고 그대로 내보낸다.
#[tauri::command]
pub async fn update_overlay_progress(position_ms: u64, duration_ms: u64) {
    let mut state = CURRENT_STATE.lock().await;
    state.position_ms = position_ms;
    if duration_ms > 0 {
        state.duration_ms = duration_ms;
    }
    let msg = match serde_json::to_string(&*state) {
        Ok(m) => m,
        Err(_) => return,
    };
    drop(state);

    for tx in PEERS.lock().await.values() {
        let _ = tx.send(Message::Text(msg.clone()));
    }
    if let Some(handle) = APP_HANDLE.lock().await.as_ref() {
        let _ = handle.emit("overlay-state-updated", msg);
    }
}

#[tauri::command]
pub async fn update_overlay_lyrics(current: String, next: String, index: Option<i32>) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.current_lyric = current;
    state.next_lyric = next;
    if let Some(i) = index {
        state.lyric_index = i;
    }
    broadcast_overlay_state(state).await;
}

/// 곡이 바뀌거나 가사가 로드될 때 전체 가사 줄 목록을 교체한다 —
/// 가사 뷰 페이지(/lyrics-view)가 전체 목록을 렌더하고 lyric_index로
/// 현재 줄을 하이라이트하는 데 사용.
#[tauri::command]
pub async fn update_overlay_lyrics_full(lines: Vec<String>) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.lyrics_lines = lines;
    state.lyric_index = -1;
    broadcast_overlay_state(state).await;
}
 
 
 
 
 
 
 
 
 
 
 
 
#[tauri::command]
pub async fn get_overlay_state() -> OverlayState {
    CURRENT_STATE.lock().await.clone()
}

#[tauri::command]
pub fn get_lan_addresses() -> Vec<String> {
    use std::net::UdpSocket;

    let mut addrs = Vec::new();

    // Connecting a UDP socket doesn't send any packets; it just asks the OS
    // to resolve which local interface/IP would be used to route to that
    // target, which is a reliable way to find the LAN-facing address.
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                addrs.push(local_addr.ip().to_string());
            }
        }
    }

    addrs
}
