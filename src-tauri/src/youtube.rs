use serde::{Serialize, Deserialize};
use std::sync::Arc;
use serde_json::Value;
use tauri::{Emitter, WebviewWindow};
use std::path::{PathBuf, Path};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;
use tokio::io::AsyncWriteExt;
use tokio_util::codec::{FramedRead, LinesCodec};
use futures::StreamExt;
use std::process::Stdio;
use once_cell::sync::Lazy;
use parking_lot::RwLock;

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub percentage: f32,
    pub current_chunk: usize,
    pub total_size: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SeparationProgress {
    pub path: String,
    pub percentage: f32,
    pub status: String,
    pub provider: String,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct YoutubeMetadata {
    pub id: Option<String>,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

pub struct YoutubeManager;

static METADATA_CACHE: Lazy<RwLock<HashMap<String, (YoutubeMetadata, Instant)>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
/// 마지막 yt-dlp 강제 갱신 시각(epoch secs). 배치 실패로 여러 곡이 동시에
/// 재시도할 때 yt-dlp를 몇 번씩 재다운로드하지 않도록 짧은 창으로 중복을 막는다.
static LAST_YTDLP_FORCE_UPDATE: AtomicU64 = AtomicU64::new(0);
const METADATA_CACHE_TTL: Duration = Duration::from_secs(60 * 30);
const METADATA_TIMEOUT: Duration = Duration::from_secs(12);

impl YoutubeManager {
    fn extract_video_id(url: &str) -> Option<String> {
        let trimmed = url.trim();
        if let Some(idx) = trimmed.find("youtu.be/") {
            let tail = &trimmed[idx + "youtu.be/".len()..];
            let id = tail.split(&['?', '&', '/', '#'][..]).next().unwrap_or("").trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        if let Some(idx) = trimmed.find("watch?v=") {
            let tail = &trimmed[idx + "watch?v=".len()..];
            let id = tail.split(&['&', '/', '#', '?'][..]).next().unwrap_or("").trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        if let Some(idx) = trimmed.find("/shorts/") {
            let tail = &trimmed[idx + "/shorts/".len()..];
            let id = tail.split(&['?', '&', '/', '#'][..]).next().unwrap_or("").trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        None
    }

    fn metadata_cache_key(url: &str) -> String {
        if let Some(id) = Self::extract_video_id(url) {
            return format!("yt:{}", id);
        }
        url.trim().to_string()
    }

    fn read_metadata_cache(key: &str) -> Option<YoutubeMetadata> {
        let mut cache = METADATA_CACHE.write();
        if let Some((meta, ts)) = cache.get(key) {
            if ts.elapsed() <= METADATA_CACHE_TTL {
                return Some(meta.clone());
            }
            cache.remove(key);
        }
        None
    }

    fn write_metadata_cache(key: &str, metadata: &YoutubeMetadata) {
        let mut cache = METADATA_CACHE.write();
        cache.insert(key.to_string(), (metadata.clone(), Instant::now()));
    }

    async fn fetch_oembed_metadata(url: &str, video_id: Option<&str>) -> Option<YoutubeMetadata> {
        let oembed_url = format!(
            "https://www.youtube.com/oembed?format=json&url={}",
            urlencoding::encode(url)
        );
        let response = reqwest::get(&oembed_url).await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let payload = response.json::<Value>().await.ok()?;
        let title = payload.get("title").and_then(|v| v.as_str()).map(|s| s.to_string());
        let uploader = payload
            .get("author_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let thumbnail = payload
            .get("thumbnail_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                video_id.map(|id| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id))
            });

        Some(YoutubeMetadata {
            id: video_id.map(|s| s.to_string()),
            title,
            uploader,
            duration: None,
            thumbnail,
        })
    }

    fn managed_bin_name() -> &'static str {
        "yt-dlp.exe"
    }

    fn managed_cache_dir() -> PathBuf {
        crate::ffmpeg_tools::tools_cache_dir()
    }

    fn managed_candidates() -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        let file_name = Self::managed_bin_name();
        candidates.push(Self::managed_cache_dir().join(file_name));
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                candidates.push(exe_dir.join("resources").join("tools").join(file_name));
                candidates.push(exe_dir.join("tools").join(file_name));
            }
        }
        candidates
    }

    async fn resolve_ffmpeg_location() -> Option<PathBuf> {
        crate::ffmpeg_tools::resolve_ffmpeg_dir().await
    }

    async fn ensure_managed_yt_dlp() -> Option<PathBuf> {
        for p in Self::managed_candidates() {
            if p.exists() {
                return Some(p);
            }
        }

        let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

        let target = Self::managed_cache_dir().join(Self::managed_bin_name());
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let response = reqwest::get(url).await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        let mut file = tokio::fs::File::create(&target).await.ok()?;
        if file.write_all(&bytes).await.is_err() {
            return None;
        }
        let _ = file.flush().await;

        if target.exists() {
            Some(target)
        } else {
            None
        }
    }

    /// 관리형 yt-dlp를 최신본으로 받아 원자적으로 교체한다(성공 시 true).
    ///
    /// 안전 원칙: (1) 관리형 캐시의 바이너리만 대상(시스템/번들은 건드리지 않음),
    /// (2) 임시 파일로 받아 완결됐을 때만 교체(반쯤 받다 실패해도 기존 것 보존),
    /// (3) 어떤 실패에도 기존 바이너리를 유지 — 오프라인이어도 앱은 계속 동작.
    async fn download_and_swap_yt_dlp() -> bool {
        let managed = Self::managed_cache_dir().join(Self::managed_bin_name());
        let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
        let tmp = managed.with_extension("exe.new");
        let Ok(resp) = reqwest::get(url).await else { return false; };
        if !resp.status().is_success() {
            return false;
        }
        let Ok(bytes) = resp.bytes().await else { return false; };
        // 온전성 최소 확인: 정상 yt-dlp.exe는 수 MB 이상이다.
        if bytes.len() < 1_000_000 {
            return false;
        }
        if let Some(parent) = tmp.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if tokio::fs::write(&tmp, &bytes).await.is_err() {
            return false;
        }
        // 원자적 교체. 실행 중이면 실패할 수 있으나 그땐 기존 것을 그대로 둔다.
        if std::fs::rename(&tmp, &managed).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return false;
        }
        crate::audio_player::sys_log("[Tools] yt-dlp를 최신 버전으로 갱신했습니다");
        true
    }

    /// 관리형 yt-dlp가 오래됐으면(7일+) 백그라운드로 최신본을 받아 교체한다.
    ///
    /// yt-dlp는 유튜브가 추출을 깰 때마다 거의 주 단위로 갱신되므로, 설치 시점에
    /// 한 번 받은 뒤 방치하면 "곡 추가가 어느 날 갑자기 실패"(봇 감지 등)의 주범이
    /// 된다. 앱 시작 시 조용히 호출해 신선하게 유지한다.
    pub async fn refresh_managed_yt_dlp_if_stale() {
        const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60; // 7일

        // 없으면 최초 다운로드까지 겸한다(이 경우 방금 받은 것이라 갱신 불필요).
        let Some(path) = Self::ensure_managed_yt_dlp().await else { return; };
        let managed = Self::managed_cache_dir().join(Self::managed_bin_name());
        if path != managed {
            return; // 시스템/번들 바이너리는 갱신 대상 아님
        }

        let fresh = std::fs::metadata(&managed)
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|e| e.as_secs()).unwrap_or(0) < MAX_AGE_SECS)
            .unwrap_or(true); // mtime을 못 읽으면(이상 상황) 굳이 갱신하지 않음
        if fresh {
            return;
        }
        LAST_YTDLP_FORCE_UPDATE.store(Self::now_secs(), Ordering::Relaxed);
        let _ = Self::download_and_swap_yt_dlp().await;
    }

    fn now_secs() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    /// 추출 실패 직후 즉시 yt-dlp를 최신본으로 강제 교체한다(성공/최신 판단 시 true).
    /// 배치 실패로 여러 번 연달아 호출돼도 최근 갱신 이력이 있으면 재다운로드를
    /// 생략하고 true를 돌려, 호출 측이 "재시도만" 하도록 한다.
    pub async fn force_update_managed_yt_dlp() -> bool {
        // 관리형 캐시 바이너리만 강제 갱신 대상(시스템/번들은 우리가 못 바꾼다).
        let managed = Self::managed_cache_dir().join(Self::managed_bin_name());
        let now = Self::now_secs();
        let last = LAST_YTDLP_FORCE_UPDATE.load(Ordering::Relaxed);
        if last != 0 && now.saturating_sub(last) < 300 {
            // 최근 5분 내 이미 갱신 시도 — 사실상 최신이라 보고 재시도만 하게 한다.
            return managed.exists();
        }
        LAST_YTDLP_FORCE_UPDATE.store(now, Ordering::Relaxed);
        Self::download_and_swap_yt_dlp().await
    }

    /// yt-dlp 갱신으로 고쳐질 법한 추출 실패인지 판정한다(봇 감지·추출기 파손 등).
    /// 영상이 실제로 없거나 비공개인 경우는 갱신해도 소용없으므로 제외한다 —
    /// 그런 경우까지 재다운로드·재시도하면 시간만 버린다.
    pub fn is_extractor_staleness_error(msg: &str) -> bool {
        let m = msg.to_lowercase();
        let permanent = m.contains("video unavailable")
            || m.contains("private video")
            || m.contains("members-only")
            || m.contains("removed by the uploader")
            || m.contains("this video is not available")
            || m.contains("account associated with this video has been terminated");
        if permanent {
            return false;
        }
        m.contains("confirm you're not a bot")
            || m.contains("confirm you are not a bot")
            || m.contains("sign in to confirm")
            || m.contains("unable to extract")
            || m.contains("nsig extraction failed")
            || m.contains("failed to extract any player response")
            || m.contains("unable to download api page")
            || m.contains("precondition check failed")
            || m.contains("please update yt-dlp")
            || m.contains("update to the latest version")
            || m.contains("http error 403")
    }

    /// Finds the best yt-dlp executable by checking managed and system paths.
    async fn find_yt_dlp() -> String {
        // 1. Use managed binary first for stability.
        if let Some(p) = Self::ensure_managed_yt_dlp().await {
            return p.to_string_lossy().to_string();
        }

        // 2. Try to see if it's already in the system PATH.
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("where.exe")
            .arg("yt-dlp")
            .creation_flags(0x08000000)
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !p.is_empty() {
                    let first_path = p.lines().next().unwrap_or(&p).to_string();
                    println!("Found yt-dlp in PATH: {}", first_path);
                    return first_path;
                }
            }
        }

        // 3. Check common Python Script paths as backup
        let appdata_paths = vec![
            std::env::var("APPDATA").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ];

        for base in appdata_paths.into_iter().flatten() {
            // Check major Python versions (3.10 to 3.13)
            for ver in &["Python313", "Python312", "Python311", "Python310"] {
                let p = Path::new(&base).join("Python").join(ver).join("Scripts").join("yt-dlp.exe");
                if p.exists() {
                    println!("Found Python-specific yt-dlp: {:?}", p);
                    return p.to_string_lossy().to_string();
                }
            }
            
            // Check direct Scripts folder in LocalAppData (some pip installs end up here)
            let direct_p = Path::new(&base).join("Programs").join("Python").join("Python313").join("Scripts").join("yt-dlp.exe");
            if direct_p.exists() {
                return direct_p.to_string_lossy().to_string();
            }
        }

        "yt-dlp".to_string()
    }

    /// search.rs 등 다른 모듈에서 쓰는 yt-dlp 경로 해석 (관리형 바이너리 우선).
    pub async fn find_yt_dlp_public() -> String {
        Self::find_yt_dlp().await
    }

    /// yt-dlp를 한 번 실행해 stdout을 문자열로 받는다(검색·설명 조회용).
    /// 콘솔 창이 뜨지 않게 CREATE_NO_WINDOW를 적용하고, 응답이 없을 때를 대비해
    /// 타임아웃을 건다.
    pub async fn run_yt_dlp_capture(exe: &str, args: &[String]) -> Result<String, String> {
        let mut cmd = Command::new(exe);
        cmd.creation_flags(0x08000000);
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            cmd.args(args).output(),
        )
        .await
        .map_err(|_| "yt-dlp 응답 시간 초과".to_string())?
        .map_err(|e| format!("yt-dlp 실행 실패 ({}): {}", exe, e))?;

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    pub async fn get_video_metadata(url: &str) -> Result<YoutubeMetadata, String> {
        let cache_key = Self::metadata_cache_key(url);
        if let Some(cached) = Self::read_metadata_cache(&cache_key) {
            let _ = crate::audio_player::sys_log("[Youtube] Metadata cache hit");
            return Ok(cached);
        }

        let exe = Self::find_yt_dlp().await;
        let _ = crate::audio_player::sys_log(&format!("[Youtube] Using yt-dlp at: {} for metadata from: {}", exe, url));
        
        let mut cmd = Command::new(&exe);
        cmd.creation_flags(0x08000000);
        let output = tokio::time::timeout(
            METADATA_TIMEOUT,
            cmd.args(&[
                "-j",
                "--no-playlist",
                "--skip-download",
                "--no-warnings",
                "--no-check-certificates",
                "--socket-timeout",
                "8",
                "--extractor-retries",
                "1",
                url,
            ])
            .output(),
        )
        .await
        .map_err(|_| {
            format!(
                "yt-dlp metadata timeout after {}s",
                METADATA_TIMEOUT.as_secs()
            )
        })
        .and_then(|res| {
            res.map_err(|e| {
                let err_msg = format!("Failed to start yt-dlp ({}): {}", exe, e);
                let _ = crate::audio_player::sys_log(&err_msg);
                err_msg
            })
        });

        let output = match output {
            Ok(v) => v,
            Err(err_msg) => {
                let _ = crate::audio_player::sys_log(&format!("[Youtube] {}", err_msg));
                if let Some(fallback) =
                    Self::fetch_oembed_metadata(url, Self::extract_video_id(url).as_deref()).await
                {
                    let _ = crate::audio_player::sys_log(
                        "[Youtube] Fallback metadata from oEmbed after yt-dlp failure",
                    );
                    Self::write_metadata_cache(&cache_key, &fallback);
                    return Ok(fallback);
                }
                return Err(err_msg);
            }
        };

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let err_msg = format!("yt-dlp execution failed: {}", err);
            let _ = crate::audio_player::sys_log(&err_msg);
            if let Some(fallback) =
                Self::fetch_oembed_metadata(url, Self::extract_video_id(url).as_deref()).await
            {
                let _ = crate::audio_player::sys_log(
                    "[Youtube] Fallback metadata from oEmbed after yt-dlp stderr failure",
                );
                Self::write_metadata_cache(&cache_key, &fallback);
                return Ok(fallback);
            }
            return Err(err_msg);
        }

        let raw_stdout = String::from_utf8_lossy(&output.stdout);
        let json_content = if let Some(start_idx) = raw_stdout.find('{') {
            &raw_stdout[start_idx..]
        } else {
            &raw_stdout
        };

        if json_content.trim().is_empty() {
            let _ = crate::audio_player::sys_log("[Youtube] yt-dlp returned empty output");
            return Err("yt-dlp returned empty output".into());
        }

        let v: Value = serde_json::from_str(json_content)
            .map_err(|e| {
                let err_msg = format!("Failed to parse yt-dlp JSON: {}", e);
                let _ = crate::audio_player::sys_log(&format!("{} | Raw output: {}", err_msg, raw_stdout));
                err_msg
            })?;

        let metadata = YoutubeMetadata {
            id: v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()),
            title: v.get("title").and_then(|x| x.as_str())
                .or_else(|| v.get("fulltitle").and_then(|x| x.as_str()))
                .map(|s| s.to_string()),
            uploader: v.get("uploader").and_then(|x| x.as_str())
                .or_else(|| v.get("channel").and_then(|x| x.as_str()))
                .map(|s| s.to_string()),
            duration: v.get("duration").and_then(|x| x.as_f64()),
            thumbnail: v.get("thumbnail").and_then(|x| x.as_str())
                .or_else(|| {
                    v.get("thumbnails")
                        .and_then(|x| x.as_array())
                        .and_then(|urls| urls.last())
                        .and_then(|t| t.get("url"))
                        .and_then(|u| u.as_str())
                })
                .map(|s| s.to_string()),
        };

        let _ = crate::audio_player::sys_log(&format!("[Youtube] Successfully fetched metadata: {:?}", metadata.title));
        Self::write_metadata_cache(&cache_key, &metadata);
        Ok(metadata)
    }

    /// 오디오를 내려받되, 추출 실패(봇 감지·추출기 파손 등)면 yt-dlp를 즉시 최신본
    /// 으로 갱신하고 **1회 재시도**한다. 유튜브가 오늘 바뀌고 yt-dlp가 오늘 고쳤을
    /// 때, 시작 시 7일 주기 갱신을 기다리지 않고 바로 복구되게 하기 위함이다.
    pub async fn download_audio(
        window: &WebviewWindow,
        url: &str,
        destination: PathBuf,
        wait_for_full: bool,
    ) -> Result<PathBuf, String> {
        match Self::download_audio_once(window, url, destination.clone(), wait_for_full).await {
            Ok(p) => Ok(p),
            Err(e) if Self::is_extractor_staleness_error(&e) => {
                crate::audio_player::sys_log(&format!(
                    "[Youtube] 추출 실패로 판단 — yt-dlp 갱신 후 재시도: {}",
                    e
                ));
                if Self::force_update_managed_yt_dlp().await {
                    // 실패로 남은 부분 파일이 있으면 yt-dlp가 "이미 있음"으로
                    // 건너뛸 수 있으니 지우고 깨끗이 재시도한다.
                    let _ = std::fs::remove_file(&destination);
                    Self::download_audio_once(window, url, destination, wait_for_full).await
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }

    async fn download_audio_once(
        window: &WebviewWindow,
        url: &str,
        destination: PathBuf,
        wait_for_full: bool,
    ) -> Result<PathBuf, String> {
        let exe = Self::find_yt_dlp().await;
        let ffmpeg_location = Self::resolve_ffmpeg_location().await;
        if let Some(ffmpeg_dir) = &ffmpeg_location {
            let _ = crate::audio_player::sys_log(&format!(
                "[Youtube] Using ffmpeg location: {}",
                ffmpeg_dir.to_string_lossy()
            ));
        } else {
            let _ = crate::audio_player::sys_log("[Youtube] ffmpeg not found in managed/system locations");
        }
        
        // 1. Check if already downloading (Synchronization)
        let notifier = {
            let mut active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
            if active.contains(&destination) {
                // Return notifier to wait on existing process
                let mut notifiers = crate::audio_player::DOWNLOAD_FINISHED_NOTIFIER.lock();
                Some(notifiers.entry(destination.clone()).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).clone())
            } else {
                active.insert(destination.clone());
                None
            }
        };

        if let Some(n) = notifier {
            println!("Download already in progress for {:?}, waiting...", destination);
            if wait_for_full {
                n.notified().await;
                return if destination.exists() { Ok(destination) } else { Err("Download failed in other thread".into()) };
            } else {
                // If streaming, still check for header
            }
        } else {
            // This is the primary download thread
            println!("Starting new yt-dlp download: {}", url);
            let mut cmd = Command::new(&exe);
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let mut args: Vec<String> = vec![
                "--newline".into(),
                "--progress-template".into(),
                "%(progress)j".into(),
                "--no-check-certificates".into(),
                "--no-part".into(),
                "--no-warnings".into(),
                "--buffer-size".into(),
                "16K".into(),
            ];

            if wait_for_full {
                // High quality post-processing for separation
                args.extend_from_slice(&[
                    "-f".into(),
                    "ba".into(),
                    "-x".into(),
                    "--audio-format".into(),
                    "m4a".into(),
                ]);
            } else {
                // Streaming friendly: no post-processing
                args.extend_from_slice(&["-f".into(), "ba[ext=m4a]/ba".into()]);
            }

            args.extend_from_slice(&[
                "-o".into(),
                destination.to_str().ok_or("Invalid path")?.to_string(),
                url.to_string(),
            ]);
            if let Some(ffmpeg_dir) = &ffmpeg_location {
                args.extend_from_slice(&[
                    "--ffmpeg-location".into(),
                    ffmpeg_dir.to_string_lossy().to_string(),
                ]);
            }

            let mut child = cmd
                .args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take();
            let mut reader = FramedRead::new(stdout, LinesCodec::new());
            let window_clone = window.clone();
            let dest_clone = destination.clone();
            let url_clone = url.to_string();
            let wait_for_full_clone = wait_for_full;

            tokio::spawn(async move {
                let stderr_task = stderr.map(|err| {
                    tokio::spawn(async move {
                        let mut tail: Vec<String> = Vec::new();
                        let mut err_reader = FramedRead::new(err, LinesCodec::new());
                        while let Some(line_result) = err_reader.next().await {
                            if let Ok(line) = line_result {
                                let line = line.trim();
                                if !line.is_empty() {
                                    tail.push(line.to_string());
                                    if tail.len() > 8 {
                                        tail.remove(0);
                                    }
                                }
                            }
                        }
                        tail
                    })
                });

                while let Some(line_result) = reader.next().await {
                    match line_result {
                        Ok(line) => {
                            if let Ok(progress) = serde_json::from_str::<Value>(&line) {
                                if let Some(status) = progress.get("status").and_then(|s| s.as_str()) {
                                    if status == "downloading" {
                                        let downloaded = progress.get("downloaded_bytes").and_then(|b| b.as_u64()).unwrap_or(0);
                                        let total = progress.get("total_bytes")
                                            .or_else(|| progress.get("total_bytes_estimate"))
                                            .and_then(|b| b.as_u64());
                                        
                                        let percentage = if let Some(t) = total {
                                            (downloaded as f32 / t as f32) * 100.0
                                        } else { 0.0 };

                                        let _ = window_clone.emit("youtube-download-progress", DownloadProgress {
                                            percentage,
                                            current_chunk: downloaded as usize,
                                            total_size: total,
                                        });

                                        if wait_for_full_clone {
                                            let _ = window_clone.emit("separation-progress", SeparationProgress {
                                                path: url_clone.clone(),
                                                percentage,
                                                status: format!("Downloading... ({:.1}%)", percentage),
                                                provider: "NETWORK".into(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => {}
                    }
                }

                let status = child.wait().await;
                let stderr_tail = if let Some(task) = stderr_task {
                    task.await.unwrap_or_default()
                } else {
                    Vec::new()
                };
                
                {
                    let mut active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                    active.remove(&dest_clone);
                    let mut errors = crate::audio_player::DOWNLOAD_ERRORS.lock();
                    errors.remove(&dest_clone);
                    if !matches!(status, Ok(s) if s.success()) {
                        let reason = if stderr_tail.is_empty() {
                            "yt-dlp exited without stderr output".to_string()
                        } else {
                            stderr_tail.join(" | ")
                        };
                        errors.insert(dest_clone.clone(), reason);
                    }
                    
                    // Notify all waiters
                    let mut notifiers = crate::audio_player::DOWNLOAD_FINISHED_NOTIFIER.lock();
                    if let Some(n) = notifiers.remove(&dest_clone) {
                        n.notify_waiters();
                    }
                }

                match status {
                    Ok(s) if s.success() => {
                        let _ = window_clone.emit("youtube-download-finished", dest_clone.to_string_lossy());
                    },
                    _ => {}
                }
            });
        }

        // 2. Wait logic (Full or Streaming)
        if wait_for_full {
            // Need to re-acquire notifier if we are the primary but someone else might have joined
            let n = {
                let mut notifiers = crate::audio_player::DOWNLOAD_FINISHED_NOTIFIER.lock();
                notifiers.entry(destination.clone()).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).clone()
            };
            
            // Wait for completion via notification
            let start = std::time::Instant::now();
            while start.elapsed().as_secs() < 300 { // 5 min max for full download
                {
                    let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                    if !active.contains(&destination) { break; }
                }
                tokio::select! {
                    _ = n.notified() => break,
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => {}
                }
            }
            
            if destination.exists() { return Ok(destination); }
            if let Some(reason) = crate::audio_player::DOWNLOAD_ERRORS.lock().remove(&destination) {
                return Err(format!("YouTube 오디오 다운로드 실패: {}", reason));
            }
            return Err("YouTube 오디오 파일을 완전히 다운로드하지 못했습니다".into());
        } else {
            // Streaming mode: wait for headers (8KB)
            let start_wait = std::time::Instant::now();
            let mut file_ready = false;
            
            // Increased to 30s as metadata extraction can be slow
            while start_wait.elapsed().as_secs() < 30 {
                {
                    // If the download thread finished (meaning it succeeded or failed completely), stop waiting
                    let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                    if !active.contains(&destination) { break; }
                }
                
                if destination.exists() {
                    if let Ok(meta) = std::fs::metadata(&destination) {
                        if meta.len() > 8192 {
                            file_ready = true;
                            break;
                        }
                    }
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            }

            if !file_ready && !destination.exists() {
                if let Some(reason) = crate::audio_player::DOWNLOAD_ERRORS.lock().remove(&destination) {
                    return Err(format!("YouTube 오디오 파일 생성 실패: {}", reason));
                }
                return Err("YouTube 오디오 파일이 생성되지 않았습니다 (Timeout)".into());
            }
            Ok(destination)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staleness_error_matches_extractor_breakage() {
        // yt-dlp 갱신으로 고쳐지는 전형적 실패 — 재시도 대상.
        for msg in [
            "ERROR: [youtube] abc: Sign in to confirm you're not a bot",
            "ERROR: unable to extract player response",
            "nsig extraction failed: Some players may not work",
            "Please update yt-dlp to the latest version",
            "ERROR: unable to download API page: HTTP Error 403: Forbidden",
        ] {
            assert!(
                YoutubeManager::is_extractor_staleness_error(msg),
                "갱신으로 고쳐질 실패인데 놓침: {msg}"
            );
        }
    }

    #[test]
    fn staleness_error_ignores_permanently_unavailable_videos() {
        // 영상이 실제로 없거나 비공개 — 갱신·재시도해도 소용없으므로 제외.
        for msg in [
            "ERROR: [youtube] abc: Video unavailable",
            "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
            "ERROR: [youtube] abc: This video is not available",
            "ERROR: Join this channel to get access to members-only content",
            "This video has been removed by the uploader",
        ] {
            assert!(
                !YoutubeManager::is_extractor_staleness_error(msg),
                "영구 실패인데 재시도 대상으로 잘못 판정: {msg}"
            );
        }
    }
}
