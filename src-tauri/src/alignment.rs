use serde::{Serialize, Deserialize};
use std::fs;
use std::path::{Path, PathBuf};
use crate::audio_player::sys_log;
use tauri::{command, AppHandle, Emitter, Manager};
use ndarray::Array2;
use unicode_normalization::UnicodeNormalization;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use crate::audio::AudioProcessor;
use crate::onnx_engine::OnnxEngine;
use regex::Regex;
use parking_lot::Mutex;

#[derive(Clone)]
pub struct CachedAlignmentState {
    pub emission_probs: Arc<Array2<f32>>,
    pub tokens_path: PathBuf,
    pub lyrics: String,
    /// 프론트 원문 세그먼트와의 안정적인 병합 키. 텍스트가 중복되어도
    /// 재정렬 결과가 같은 원문 블록으로 돌아가도록 캐시한다.
    pub line_ids: Vec<String>,
    /// 사용자 하드 앵커 (입력 줄 인덱스, ms) — 실시간 penalty 튜닝 재정렬에서도
    /// 같은 고정점을 유지하도록 캐시에 함께 둔다.
    pub anchors: Vec<(usize, i64)>,
    /// 윈도우 정렬은 잘라낸 emission 축을 0ms로 보므로, 결과를 원본 오디오
    /// 시간축으로 되돌릴 때 이 오프셋을 보존해야 한다.
    pub time_offset_ms: i64,
    /// 3차 추정 싱크가 사용할 full-song 진단. 윈도우 정렬을 튜닝하더라도
    /// 로컬 slice가 아닌 원본 곡 시간축을 유지한다.
    pub audio_duration_ms: i64,
    pub vocal_regions: Vec<VocalRegion>,
}

pub static CACHED_STATE: Mutex<Option<CachedAlignmentState>> = Mutex::new(None);

/// Full-song acoustic inference is much more expensive than Viterbi alignment.
/// Keep the Korean and English snapshots for the active song so adjacent
/// fallback/rescue windows slice the same emission matrix instead of loading
/// ONNX and re-running the whole song for every request.
#[derive(Clone, Debug, PartialEq, Eq)]
struct InferenceCacheKey {
    audio_path: String,
    audio_size: u64,
    audio_modified_ns: u128,
    model_path: String,
    model_size: u64,
    model_modified_ns: u128,
}

#[derive(Clone)]
struct InferenceCacheEntry {
    key: InferenceCacheKey,
    emission_probs: Arc<Array2<f32>>,
    vocal_activity: Arc<Vec<f32>>,
}

/// A mixed-language run normally uses exactly two models.  Bounding this cache
/// avoids retaining one full-song emission matrix per song for the lifetime of
/// the desktop process while keeping both language passes warm.
const EMISSION_CACHE_CAPACITY: usize = 2;
static EMISSION_CACHE: Mutex<Vec<InferenceCacheEntry>> = Mutex::new(Vec::new());

fn cache_file_identity(path: &Path) -> (String, u64, u128) {
    let normalized = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    let metadata = fs::metadata(path).ok();
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified_ns = metadata
        .and_then(|m| m.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    (normalized, size, modified_ns)
}

fn inference_cache_key(audio_path: &Path, model_path: &Path) -> InferenceCacheKey {
    let (audio_path, audio_size, audio_modified_ns) = cache_file_identity(audio_path);
    let (model_path, model_size, model_modified_ns) = cache_file_identity(model_path);
    InferenceCacheKey {
        audio_path,
        audio_size,
        audio_modified_ns,
        model_path,
        model_size,
        model_modified_ns,
    }
}

fn read_cached_inference(key: &InferenceCacheKey) -> Option<(Arc<Array2<f32>>, Arc<Vec<f32>>)> {
    let cache = EMISSION_CACHE.lock();
    let entry = cache.iter().find(|entry| entry.key == *key)?;
    Some((Arc::clone(&entry.emission_probs), Arc::clone(&entry.vocal_activity)))
}

fn store_cached_inference(
    key: InferenceCacheKey,
    emission_probs: Arc<Array2<f32>>,
    vocal_activity: Arc<Vec<f32>>,
) {
    let mut cache = EMISSION_CACHE.lock();
    if let Some(existing) = cache.iter_mut().find(|entry| entry.key == key) {
        existing.emission_probs = emission_probs;
        existing.vocal_activity = vocal_activity;
        return;
    }

    // Alignment is serialized and each request is scoped to one song. Once a
    // third distinct key arrives, it is a new song/model combination in normal
    // use; discard the old pair rather than accumulating large tensors.
    if cache.len() >= EMISSION_CACHE_CAPACITY {
        cache.clear();
    }
    cache.push(InferenceCacheEntry {
        key,
        emission_probs,
        vocal_activity,
    });
}

pub static CANCEL_ALIGNMENT: AtomicBool = AtomicBool::new(false);

/// Serializes forced-alignment runs (same single-permit pattern as
/// `separation::AI_QUEUE_LOCK`). `CACHED_STATE` and `CANCEL_ALIGNMENT` are
/// single-slot globals — holding this lock across the whole run guarantees
/// at most one alignment owns them at any time, so batch-queued requests and
/// the interactive editor button can never corrupt each other's state.
pub static ALIGNMENT_QUEUE_LOCK: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

/// 개발 빌드에서만 프런트 정렬 파이프라인의 입출력을 JSONL로 보관한다.
/// 가사 원문을 포함하므로 릴리스 빌드에서는 의도적으로 아무 파일도 쓰지 않는다.
#[command]
pub fn write_alignment_debug_trace(
    handle: AppHandle,
    run_id: String,
    stage: String,
    payload: serde_json::Value,
) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Ok(String::new());
    }

    let safe_run_id: String = run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(96)
        .collect();
    let safe_run_id = if safe_run_id.is_empty() { "alignment" } else { &safe_run_id };
    let path = crate::state::AppPaths::from_handle(&handle)
        .root
        .join("logs")
        .join("alignment-debug")
        .join(format!("{}.jsonl", safe_run_id));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("정렬 디버그 폴더 생성 실패: {}", e))?;
    }

    let record = serde_json::json!({
        "schemaVersion": 1,
        "timestampMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        "stage": stage,
        "payload": payload,
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("정렬 디버그 로그 열기 실패: {}", e))?;
    writeln!(file, "{}", record).map_err(|e| format!("정렬 디버그 로그 쓰기 실패: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 곡 구조 지시어(실제로 불리지 않는 라벨) 판별 — 대소문자 무시, 트림 후 전체
/// 일치만 인정한다("Chorus"는 지시어, "Chorus of angels"는 실제 가사이므로 유지).
/// 뒤에 숫자가 붙는 것도 허용("Verse 2", "후렴 1").
fn is_structure_directive(inner: &str) -> bool {
    const LABELS: &[&str] = &[
        // 영어
        "verse", "chorus", "pre-chorus", "prechorus", "post-chorus", "postchorus",
        "bridge", "intro", "outro", "hook", "refrain", "interlude", "instrumental",
        "ad-lib", "adlib", "rap", "spoken", "guitar solo", "solo", "drop",
        "build-up", "buildup", "breakdown", "fade out", "fade in", "repeat",
        // 한국어
        "인트로", "벌스", "후렴", "브릿지", "간주", "아웃트로", "랩", "훅",
        "프리코러스", "포스트코러스", "코러스", "절", "다리", "전주", "후주",
        "애드립", "간주중", "반복",
    ];
    let normalized = inner.trim().to_lowercase();
    let base = normalized
        .trim_end_matches(|c: char| c.is_ascii_digit() || c.is_whitespace());
    LABELS.contains(&base)
}

fn clean_lyrics(text: &str) -> String {
    // 괄호/브래킷 처리: 안에 있는 게 "곡 구조 지시어"(예: [Chorus], (Intro))면
    // 통째로 제거하지만, 그게 아니면(예: "사랑해 (사랑해)"의 코러스 가사)
    // 괄호 표시만 벗기고 안의 가사는 남긴다.
    //
    // 이유: forced_align은 곡 전체를 한 번에 순차 정렬하는데, 오디오엔 실제로
    // 불린 코러스가 있는데 정렬 대상 텍스트에서 그 부분이 통째로 사라지면
    // 프레임-토큰 대응이 어긋나 그 이후 모든 줄이 밀린다(복구 불가능한 드리프트).
    // 실제 가사는 지우지 않고 남겨야 정렬이 오디오와 계속 맞는다.
    let re_brackets = Regex::new(r"[\[({<]([^\[\](){}<>]*)[\])}>]").unwrap();
    let cleaned = re_brackets.replace_all(text, |caps: &regex::Captures| {
        let inner = &caps[1];
        if is_structure_directive(inner) {
            String::new()
        } else {
            format!(" {} ", inner.trim())
        }
    });

    // 단순 특수문자 제거 (정렬에 방해되는 기호들)
    let re_symbols = Regex::new(r"[\?!\.,\-\+_~]").unwrap();
    let cleaned = re_symbols.replace_all(&cleaned, " ");

    cleaned.to_string()
}

fn normalize_path_key(path: &str) -> String {
    path.replace("\\", "/").to_lowercase()
}

use crate::youtube_url::extract_youtube_video_id;

fn youtube_url_variants(url: &str) -> Vec<String> {
    let mut variants = Vec::new();
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return variants;
    }
    variants.push(trimmed.clone());
    variants.push(normalize_path_key(&trimmed));

    if let Some(id) = extract_youtube_video_id(&trimmed) {
        variants.push(format!("https://youtu.be/{}", id));
        variants.push(format!("https://www.youtube.com/watch?v={}", id));
        variants.push(format!("https://youtube.com/watch?v={}", id));
    }

    variants.sort();
    variants.dedup();
    variants
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SeparatedTrack {
    pub name: String,
    pub original_path: String,
    pub folder_path: String,
    pub has_vocal: bool,
    pub has_inst: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WordAlignment {
    pub word: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LineAlignment {
    /// 정렬 요청 시 프론트가 넘긴 원문 세그먼트 ID. 빈 값은 구버전 호출 호환.
    #[serde(default)]
    pub segment_id: String,
    #[serde(default)]
    pub input_index: usize,
    pub text: String,
    pub extracted_text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub words: Vec<WordAlignment>,
    /// 이 줄 정렬의 음향적 확신도 0~1 (그 줄 토큰이 배정된 프레임에서의 평균
    /// emission 확률의 기하평균). 모델이 "여기서 이 글자를 들었다"고 강하게 말한
    /// 줄일수록 1에 가깝다. UI가 낮은 줄을 표시해 사용자가 우선 검토하게 한다.
    /// 배정 프레임이 없는 줄(타 언어·보간)은 0.
    #[serde(default)]
    pub confidence: f32,
    /// 다중 증거 점수에 섞기 전의 emission 기하평균. 디버깅·분포 분석용.
    #[serde(default)]
    pub emission_confidence: f32,
    /// 목표 토큰이 같은 프레임의 다른 토큰보다 우세한 정도(0~1).
    #[serde(default)]
    pub acoustic_margin: f32,
    /// 기대 토큰 중 Viterbi 경로가 실제 방문한 비율(0~1).
    #[serde(default)]
    pub token_coverage: f32,
    /// 분리 보컬 RMS에서 계산한 해당 구간의 활동도(0~1).
    #[serde(default)]
    pub vocal_activity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampedWord {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribedSegment {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
    pub words: Vec<TimestampedWord>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AlignmentResult {
    pub words: Vec<WordAlignment>,
    pub lines: Vec<LineAlignment>,
    pub raw_segments: Vec<TranscribedSegment>,
    /// 개발 로그에서 phrase window 적용 여부를 확인하기 위한 메타데이터.
    /// 가사 텍스트나 세그먼트 순서를 변경하지 않는다.
    #[serde(default)]
    pub diagnostics: AlignmentDiagnostics,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AlignmentDiagnostics {
    #[serde(default)]
    pub manual_anchor_count: usize,
    #[serde(default)]
    pub automatic_phrase_anchor_count: usize,
    #[serde(default)]
    pub phrase_window_count: usize,
    /// 결과 오디오 시간축 기준의 phrase 경계 시각.
    #[serde(default)]
    pub phrase_boundary_ms: Vec<i64>,
    /// True when this request reused an existing full-song ONNX emission.
    #[serde(default)]
    pub emission_cache_hit: bool,
    /// Full-song emission 시간축 길이. 마지막 미싱크 그룹의 안전한 상한이다.
    #[serde(default)]
    pub audio_duration_ms: i64,
    /// 20ms 보컬 활동도를 연속 구간으로 압축한 결과.
    #[serde(default)]
    pub vocal_regions: Vec<VocalRegion>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct VocalRegion {
    pub start_ms: i64,
    pub end_ms: i64,
    pub activity: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WaveformSummary {
    pub points: Vec<(f32, f32)>,
    pub duration_sec: f32,
}

#[command]
pub async fn get_separated_audio_list(handle: AppHandle) -> Result<Vec<SeparatedTrack>, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    let mut tracks = Vec::new();
    
    // DB 연결을 위해 Mutex를 잠시 잠급니다.
    let db = crate::state::DB.lock();

    if let Ok(entries) = fs::read_dir(&paths.separated) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let folder_name = entry.file_name().to_string_lossy().to_string();
                let has_vocal = crate::mr_cache::resolve_vocal(&path).is_some();
                let has_inst = crate::mr_cache::resolve_inst(&path).is_some();

                let original_path = urlencoding::decode(&folder_name).map(|d| d.into_owned()).unwrap_or(folder_name.clone());
                let display_name = Path::new(&original_path).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| original_path.clone());

                // DB에서 추가 메타데이터 조회
                let mut title = None;
                let mut artist = None;
                let mut thumbnail = None;

                // 경로 정규화 (DB 저장 방식에 맞춤: 윈도우 슬래시 등)
                // get_songs_internal 로직을 참고하여 비교합니다.
                if let Ok(row) = db.query_row(
                    "SELECT title, artist, thumbnail FROM Tracks WHERE path = ? OR path = ?",
                    rusqlite::params![original_path, original_path.replace("/", "\\")],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?))
                ) {
                    title = Some(row.0);
                    artist = row.1;
                    thumbnail = Some(row.2);
                }

                tracks.push(SeparatedTrack {
                    name: display_name,
                    original_path,
                    folder_path: path.to_string_lossy().to_string(),
                    has_vocal,
                    has_inst,
                    title,
                    artist,
                    thumbnail,
                });
            }
        }
    }
    Ok(tracks)
}

/// Downloadable forced-alignment model registry (separate from the vocal
/// separation models in `state.rs::MODELS`, since these carry two files —
/// the ONNX acoustic model and its `tokens.txt` vocab — instead of one, and
/// are hosted on a dedicated GitHub Release rather than Hugging Face.
pub struct AlignmentModelSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub model_url: &'static str,
    pub tokens_url: &'static str,
}

pub const ALIGNMENT_MODELS: &[AlignmentModelSpec] = &[
    AlignmentModelSpec {
        id: "wav2vec2-korean-lyrics",
        display_name: "한국어 가사 정렬 모델 (실험적, 약 1.2GB)",
        // kresnik/wav2vec2-large-xlsr-korean (Apache-2.0) exported to ONNX
        // (single-file, weights merged) + vocab.json converted to tokens.txt.
        model_url: "https://github.com/Temmis2077/OSW/releases/download/ai-align-model-v1/model.onnx",
        tokens_url: "https://github.com/Temmis2077/OSW/releases/download/ai-align-model-v1/tokens.txt",
    },
    AlignmentModelSpec {
        id: "wav2vec2-english-lyrics",
        display_name: "영어 가사 정렬 모델 (팝송, 약 360MB)",
        // facebook/wav2vec2-base-960h (Apache-2.0) exported to ONNX.
        // 라틴 char-level vocab (대문자 A–Z, |, <pad>/<unk>).
        model_url: "https://github.com/Temmis2077/OSW/releases/download/align-model-en-v1/model.onnx",
        tokens_url: "https://github.com/Temmis2077/OSW/releases/download/align-model-en-v1/tokens.txt",
    },
];

fn find_alignment_model_spec(model_id: &str) -> Option<&'static AlignmentModelSpec> {
    ALIGNMENT_MODELS.iter().find(|m| m.id == model_id)
}

#[command]
pub async fn list_downloadable_alignment_models() -> Vec<(String, String)> {
    ALIGNMENT_MODELS
        .iter()
        .map(|m| (m.id.to_string(), m.display_name.to_string()))
        .collect()
}

async fn download_file_with_progress(
    handle: &AppHandle,
    url: &str,
    dest: &Path,
    event_name: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))?;

    let response = client.get(url).send().await.map_err(|e| format!("요청 실패: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("다운로드 실패: HTTP {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(dest).map_err(|e| format!("파일 생성 실패: {}", e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if total_size > 0 {
            let percentage = (downloaded as f32 / total_size as f32) * 100.0;
            let _ = handle.emit(event_name, percentage);
        }
    }
    Ok(())
}

/// Downloads a forced-alignment model (ONNX + tokens.txt) into
/// `AppPaths.models/<model_id>/`, where `get_model_list` will pick it up.
/// Emits `alignment-model-download-progress` (0-100, model file only — the
/// small tokens.txt isn't worth its own progress phase) while downloading.
#[command]
pub async fn download_alignment_model(handle: AppHandle, model_id: String) -> Result<(), String> {
    let spec = find_alignment_model_spec(&model_id)
        .ok_or_else(|| format!("알 수 없는 정렬 모델: {}", model_id))?;

    let paths = crate::state::AppPaths::from_handle(&handle);
    let target_dir = paths.models.join(spec.id);
    fs::create_dir_all(&target_dir).map_err(|e| format!("폴더 생성 실패: {}", e))?;

    sys_log(&format!("[Alignment] Downloading model '{}' from {}", spec.id, spec.model_url));
    download_file_with_progress(
        &handle,
        spec.model_url,
        &target_dir.join("model.onnx"),
        "alignment-model-download-progress",
    ).await?;

    sys_log(&format!("[Alignment] Downloading tokens for '{}' from {}", spec.id, spec.tokens_url));
    download_file_with_progress(&handle, spec.tokens_url, &target_dir.join("tokens.txt"), "alignment-model-download-progress").await?;

    sys_log(&format!("[Alignment] Model '{}' ready at {:?}", spec.id, target_dir));
    Ok(())
}

#[command]
pub async fn get_model_list(handle: AppHandle) -> Result<Vec<String>, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    let mut models = Vec::new();

    let search_dirs = vec![
        paths.models.clone(),
        std::env::current_exe().map(|p| p.parent().unwrap().join("models")).unwrap_or_default(),
        PathBuf::from("models"),
    ];

    for dir in search_dirs {
        // Scan models directory for subfolders
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let folder_name = entry.file_name().to_string_lossy().to_string();
                    let onnx_path = path.join("model.onnx");
                    let enc_path = path.join("encoder.onnx");
                    let tokens_path = path.join("tokens.txt");

                    if (onnx_path.exists() || enc_path.exists()) && tokens_path.exists() {
                        let display_name = match folder_name.as_str() {
                            "wav2vec2-large" => "Engine A: Wav2Vec2-Large (High Precision)",
                            "whisper-base" => "Engine B: Whisper-Base (Multi-lingual/Efficient)",
                            _ => &folder_name,
                        };
                        models.push(format!("{}|{}", display_name, path.to_string_lossy()));
                    }
                }
            }
        }
    }
    
    if models.is_empty() {
        models.push("사용 가능한 모델 없음|none".to_string());
    }

    Ok(models)
}

#[command]
pub async fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {}", e))
}

#[command]
pub async fn cancel_forced_alignment() {
    CANCEL_ALIGNMENT.store(true, Ordering::SeqCst);
    sys_log("[Alignment] Cancellation signal sent.");
}

#[command]
pub async fn run_forced_alignment(
    handle: AppHandle,
    audio_path: String,
    lyrics: String,
    _model_name: String,
    _language: String,
    trans_penalty: Option<f32>,
    blank_penalty: Option<f32>,
    rep_penalty: Option<f32>,
    _use_vad: Option<bool>,
    anchors: Option<Vec<(usize, i64)>>,
    line_ids: Option<Vec<String>>,
    window_start_ms: Option<i64>,
    window_end_ms: Option<i64>,
) -> Result<AlignmentResult, String> {
    // -1 sentinel: waiting for a previous alignment to finish (queued).
    let _ = handle.emit("alignment-progress", -1);
    let _permit = ALIGNMENT_QUEUE_LOCK.lock().await;
    CANCEL_ALIGNMENT.store(false, Ordering::SeqCst);
    sys_log(&format!("[Alignment] Starting new CTC alignment path: {}", audio_path));

    let _paths = crate::state::AppPaths::from_handle(&handle);
    let model_full_path = _model_name.split('|').last().unwrap_or(".");
    let target_dir = PathBuf::from(model_full_path);
    
    let mut model_path = target_dir.join("model.onnx");
    if !model_path.exists() {
        model_path = target_dir.join("encoder.onnx");
    }
    let tokens_path = target_dir.join("tokens.txt");

    if !model_path.exists() || !tokens_path.exists() {
        // Fallback for relative paths if the UI didn't pass absolute
        return Err(format!("모델 파일을 찾을 수 없습니다: {:?}", target_dir));
    }

    let is_whisper = model_path.to_string_lossy().contains("whisper-base");
    let processor = AudioProcessor::new();

    // Prefer the isolated vocal stem when this track has been AI-separated —
    // singing-voice ASR accuracy drops sharply with instrumental bleed, and
    // this is the same resolution `get_waveform_summary` already uses.
    let resolved_audio_path = resolve_audio_path(&handle, &audio_path)
        .await
        .unwrap_or_else(|_| PathBuf::from(&audio_path));
    // 정렬 전용 디리버브: 켜져 있고 모델이 있으면 잔향을 걷어낸 보컬로 정렬한다
    // (없거나 실패하면 원본 보컬로 폴백 — 재생에는 영향 없음).
    let resolved_audio_path = crate::dereverb::resolve_alignment_vocal(resolved_audio_path).await;
    sys_log(&format!(
        "[Alignment] Resolved alignment input: {:?} (requested: {})",
        resolved_audio_path, audio_path
    ));

    // -2 sentinel: 오디오 전처리 + 모델 로드(ONNX 세션 생성) 준비 단계.
    // 이 구간은 수 초 걸릴 수 있는데 진행률이 없어서, 프론트가 0%가 아니라
    // "준비 중"으로 표시하도록 별도 신호를 보낸다. (-1은 대기열 대기)
    let _ = handle.emit("alignment-progress", -2);

    let emission_key = inference_cache_key(&resolved_audio_path, &model_path);
    let (full_emission_probs, full_vocal_activity, emission_cache_hit) =
        if let Some((emission_probs, vocal_activity)) = read_cached_inference(&emission_key) {
            sys_log("[Alignment] Emission cache hit: reusing full-song ONNX output.");
            // Cache hits skip model progress callbacks; explicitly complete the
            // preparation phase so the queue UI does not remain in "readying".
            let _ = handle.emit("alignment-progress", 100);
            (emission_probs, vocal_activity, true)
        } else {
            sys_log("[Alignment] Emission cache miss: running full-song ONNX inference.");
            let emission_probs = if is_whisper {
                sys_log("[Alignment] Engine B (Whisper) Preprocessing: Extracting Mel-spectrogram...");
                let raw_samples = processor.load_and_preprocess(&resolved_audio_path)?;
                let mel_data = processor.get_mel_spectrogram(raw_samples.as_slice().unwrap());

                sys_log(&format!("[Alignment] Engine B: Creating ONNX session for {:?}", model_path));
                let mut engine = OnnxEngine::new(&model_path)?;
                let h_clone = handle.clone();

                sys_log("[Alignment] Engine B: Running Whisper Inference...");
                engine.run_inference(&mel_data, true, |p| {
                    let _ = h_clone.emit("alignment-progress", p as i32);
                }).map_err(|e| {
                    let err_msg = format!("❌ [Engine B Error] {}", e);
                    sys_log(&err_msg);
                    err_msg
                })?
            } else {
                sys_log("[Alignment] Engine A (Wav2Vec2) Preprocessing: Raw audio PCM...");
                let audio_data = processor.load_and_preprocess(&resolved_audio_path)?;

                sys_log(&format!("[Alignment] Engine A: Creating ONNX session for {:?}", model_path));
                let mut engine = OnnxEngine::new(&model_path)?;
                let h_clone = handle.clone();

                sys_log("[Alignment] Engine A: Running Wav2Vec2 Inference...");
                engine.run_inference(audio_data.as_slice().unwrap(), false, |p| {
                    let _ = h_clone.emit("alignment-progress", p as i32);
                }).map_err(|e| {
                    let err_msg = format!("❌ [Engine A Error] {}", e);
                    sys_log(&err_msg);
                    err_msg
                })?
            };

            if CANCEL_ALIGNMENT.load(Ordering::SeqCst) {
                return Err("작업이 사용자에 의해 취소되었습니다.".to_string());
            }

            // 모델에 넣기 전의 raw 보컬 RMS를 별도 계산한다. 실패해도 정렬 자체는
            // 중단하지 않고, 품질 게이트가 이 신호를 사용하지 않게 빈 벡터를 준다.
            let vocal_activity = processor
                .load_mono_resampled_raw(&resolved_audio_path)
                .map(|raw| processor.vocal_activity_frames(&raw, emission_probs.nrows()))
                .unwrap_or_else(|err| {
                    sys_log(&format!("[Alignment] Vocal activity 분석 생략: {}", err));
                    Vec::new()
                });
            let emission_probs = Arc::new(emission_probs);
            let vocal_activity = Arc::new(vocal_activity);
            store_cached_inference(
                emission_key,
                Arc::clone(&emission_probs),
                Arc::clone(&vocal_activity),
            );
            (emission_probs, vocal_activity, false)
        };

    if CANCEL_ALIGNMENT.load(Ordering::SeqCst) {
        return Err("작업이 사용자에 의해 취소되었습니다.".to_string());
    }

    let anchors = anchors.unwrap_or_default();
    let line_ids = line_ids.unwrap_or_default();
    let audio_duration_ms = full_emission_probs.nrows() as i64 * 20;
    let vocal_regions = summarize_vocal_regions(full_vocal_activity.as_ref(), 20);

    // 영어 폴백은 절대 전곡에서 독립적으로 정렬하지 않는다. 프런트가 준
    // 앵커 사이 창으로 emission을 잘라 Viterbi가 다른 절의 영어를 소비할
    // 가능성을 차단한다. 창 인자가 없으면 기존 전곡 정렬과 동일하다.
    let (emission_probs, vocal_activity, anchors, time_offset_ms) = match (window_start_ms, window_end_ms) {
        (None, None) => (full_emission_probs, full_vocal_activity, anchors, 0),
        (Some(requested_start), Some(requested_end)) => {
            if requested_start < 0 || requested_end <= requested_start {
                return Err("정렬 윈도우 시간이 올바르지 않습니다.".to_string());
            }
            let total_frames = full_emission_probs.nrows();
            if total_frames < 2 {
                return Err("정렬 emission이 너무 짧아 윈도우를 만들 수 없습니다.".to_string());
            }
            let start_frame = ((requested_start as f32 / 20.0).floor() as usize).min(total_frames - 1);
            let end_frame = ((requested_end as f32 / 20.0).ceil() as usize).min(total_frames);
            if end_frame <= start_frame + 1 {
                return Err("정렬 윈도우가 너무 짧습니다.".to_string());
            }
            let time_offset_ms = start_frame as i64 * 20;
            let window_end_ms = end_frame as i64 * 20;
            sys_log(&format!(
                "[Alignment] 윈도우 정렬: {}ms..{}ms ({}..{} frame)",
                time_offset_ms, window_end_ms, start_frame, end_frame
            ));
            let window_activity = if full_vocal_activity.is_empty() {
                Arc::new(Vec::new())
            } else {
                Arc::new(full_vocal_activity[
                    start_frame.min(full_vocal_activity.len())..end_frame.min(full_vocal_activity.len())
                ].to_vec())
            };
            let local_anchors = anchors.into_iter()
                .filter(|(_, ms)| *ms >= time_offset_ms && *ms <= window_end_ms)
                .map(|(index, ms)| (index, ms - time_offset_ms))
                .collect();
            (
                Arc::new(full_emission_probs.as_ref().slice(ndarray::s![start_frame..end_frame, ..]).to_owned()),
                window_activity,
                local_anchors,
                time_offset_ms,
            )
        }
        _ => return Err("정렬 윈도우 시작과 끝은 함께 지정해야 합니다.".to_string()),
    };

    // Cache the inference results
    {
        let mut cache = CACHED_STATE.lock();
        *cache = Some(CachedAlignmentState {
            emission_probs: Arc::clone(&emission_probs),
            tokens_path: tokens_path.clone(),
            lyrics: lyrics.clone(),
            line_ids: line_ids.clone(),
            anchors: anchors.clone(),
            time_offset_ms,
            audio_duration_ms,
            vocal_regions: vocal_regions.clone(),
        });
    }

    Ok(perform_alignment_internal(
        emission_probs.as_ref(),
        &tokens_path,
        &lyrics,
        &line_ids,
        vocal_activity.as_ref(),
        trans_penalty.unwrap_or(-0.05),
        blank_penalty.unwrap_or(0.0),
        rep_penalty.unwrap_or(0.0),
        &anchors,
        time_offset_ms,
        emission_cache_hit,
        audio_duration_ms,
        &vocal_regions,
    )?)
}

#[command]
pub async fn apply_alignment_tuning(penalty: f32, blank_penalty: Option<f32>, rep_penalty: Option<f32>) -> Result<AlignmentResult, String> {
    let _permit = ALIGNMENT_QUEUE_LOCK.lock().await;
    CANCEL_ALIGNMENT.store(false, Ordering::SeqCst);
    sys_log(&format!("[Alignment] Real-time tuning requested with penalty: {:.3}", penalty));

    // Clone the single cached snapshot and release the parking_lot mutex before
    // the expensive Viterbi pass. The async queue lock above still prevents a
    // new alignment from replacing this snapshot while tuning is in progress.
    let state = CACHED_STATE.lock().as_ref().cloned();
    if let Some(state) = state {
        let result = perform_alignment_internal(
            state.emission_probs.as_ref(),
            &state.tokens_path,
            &state.lyrics,
            &state.line_ids,
            &[],
            penalty,
            blank_penalty.unwrap_or(0.0),
            rep_penalty.unwrap_or(0.0),
            &state.anchors,
            state.time_offset_ms,
            false,
            state.audio_duration_ms,
            &state.vocal_regions,
        )?;
        sys_log("[Alignment] Real-time tuning completed successfully.");
        Ok(result)
    } else {
        Err("캐시된 정렬 데이터가 없습니다. 먼저 정렬을 한번 수행하세요.".to_string())
    }
}

/// 한 줄이 차지하는 타깃 토큰 범위. 줄별 단어 수를 누적해 만든다.
/// 0폭 단어(타 언어·기호)만 있는 줄은 tok_from == tok_to로 비어 있다.
struct LineTokenSpan {
    tok_from: usize,
    tok_to: usize,
}

/// 줄별로 word_spans/타깃 토큰 상의 범위를 계산한다.
fn line_token_spans(
    lyric_lines: &[String],
    word_spans: &[(usize, usize, String)],
) -> Vec<LineTokenSpan> {
    let mut out = Vec::with_capacity(lyric_lines.len());
    let mut wi = 0usize;
    for line in lyric_lines {
        let n_words = line.split_whitespace().count();
        let word_from = wi;
        let word_to = (wi + n_words).min(word_spans.len());
        // 이 줄이 실제로 소비하는 토큰 구간 = 줄 안 단어 span들의 최소~최대
        let mut tok_from = usize::MAX;
        let mut tok_to = 0usize;
        for w in word_from..word_to {
            let (s, e, _) = &word_spans[w];
            if e > s {
                tok_from = tok_from.min(*s);
                tok_to = tok_to.max(*e);
            }
        }
        if tok_from == usize::MAX { tok_from = tok_to; }
        out.push(LineTokenSpan { tok_from, tok_to });
        wi = word_to;
    }
    out
}

/// 앵커 사이 구간을 독립적으로 재정렬해 전역 정렬의 밀림 전파를 끊는다.
///
/// 배경: 지금 정렬은 곡 전체를 한 번의 순차 CTC로 맞춘다. 그래서 중간에 한 번
/// 어긋나면 복구 지점이 없어 그 뒤 모든 줄이 계속 밀린다(한/영 혼합, 코러스,
/// 간주에서 반복적으로 겪은 실패 모드).
///
/// 대책: 전역 경로에서 **음향적으로 확신이 높은 줄을 앵커로 삼고**, 앵커 사이
/// 구간만 그 시간 범위 안에서 다시 정렬한다. 구간이 좁아지면 그 안의 토큰이
/// 해당 시간에 갇히므로, 한 번의 실수가 뒤로 전파되지 않는다.
///
/// 앵커 판정은 그 줄에 배정된 프레임에서의 평균 emission 확률(로그)로 한다 —
/// 모델이 "여기서 이 글자를 들었다"고 강하게 말한 줄만 신뢰한다.
fn refine_with_anchors(
    aligner: &Aligner,
    emission_probs: &Array2<f32>,
    target_tokens: &[usize],
    line_spans: &[LineTokenSpan],
    path: &[usize],
    trans_p: f32,
    blank_p: f32,
    rep_p: f32,
) -> Option<Vec<usize>> {
    let n_frames = path.len();
    if n_frames == 0 || line_spans.len() < 3 {
        return None;
    }

    // 1. 줄별로 배정된 프레임 구간과 평균 확신도를 구한다.
    struct LineInfo { idx: usize, first: usize, last: usize, conf: f32 }
    let mut infos: Vec<LineInfo> = Vec::new();
    for (li, ls) in line_spans.iter().enumerate() {
        if ls.tok_to <= ls.tok_from { continue; } // 토큰 없는 줄(타 언어 등)은 앵커 후보 아님
        let mut first = usize::MAX;
        let mut last = 0usize;
        let mut sum = 0f32;
        let mut cnt = 0usize;
        for (f, &tok_idx) in path.iter().enumerate() {
            if tok_idx == usize::MAX { continue; }
            if tok_idx >= ls.tok_from && tok_idx < ls.tok_to {
                if first == usize::MAX { first = f; }
                last = f;
                sum += emission_probs[[f, target_tokens[tok_idx]]];
                cnt += 1;
            }
        }
        if cnt == 0 || first == usize::MAX { continue; }
        infos.push(LineInfo { idx: li, first, last, conf: sum / cnt as f32 });
    }
    if infos.len() < 3 { return None; }

    // 2. 확신도 상위 줄을 앵커로 (중앙값 이상). 너무 촘촘하면 재정렬 효과가
    //    없으므로 간격도 확보한다.
    let mut confs: Vec<f32> = infos.iter().map(|i| i.conf).collect();
    confs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_conf = confs[confs.len() / 2];

    let mut anchors: Vec<&LineInfo> = Vec::new();
    for info in &infos {
        if info.conf < median_conf { continue; }
        // 단조 증가하는 앵커만 채택(순서가 뒤집힌 건 이미 잘못된 정렬).
        if let Some(prev) = anchors.last() {
            if info.first <= prev.last { continue; }
        }
        anchors.push(info);
    }
    if anchors.len() < 2 { return None; }

    // 3. 앵커 사이 구간을 각각 재정렬해 새 경로를 만든다.
    let mut new_path = path.to_vec();
    let mut changed = false;
    for pair in anchors.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        // 두 앵커 사이에 있는 줄들의 토큰 구간
        let tok_from = line_spans[a.idx].tok_to;
        let tok_to = line_spans[b.idx].tok_from;
        if tok_to <= tok_from { continue; }
        // 그 사이 시간 구간 (앵커의 끝 ~ 다음 앵커의 시작)
        let f_from = a.last + 1;
        let f_to = b.first;
        if f_to <= f_from { continue; }
        // 토큰이 들어갈 최소 프레임도 안 되면 건드리지 않는다.
        if (f_to - f_from) < (tok_to - tok_from) { continue; }

        let sub_tokens = &target_tokens[tok_from..tok_to];
        let sub = aligner.forced_align_range(
            emission_probs, sub_tokens, f_from, f_to, trans_p, blank_p, rep_p,
        );
        if sub.len() != f_to - f_from { continue; }
        // 로컬 토큰 인덱스를 전역 인덱스로 되돌려 경로에 반영.
        for (k, &local) in sub.iter().enumerate() {
            new_path[f_from + k] = if local == usize::MAX { usize::MAX } else { local + tok_from };
        }
        changed = true;
    }

    if changed {
        sys_log(&format!(
            "[Alignment] 앵커 {}개 기준으로 구간 재정렬 (총 {}줄)",
            anchors.len(),
            line_spans.len()
        ));
        Some(new_path)
    } else {
        None
    }
}

/// 사용자가 확정한 하드 앵커로 토큰·프레임 축을 나눠 **구간별로 독립 정렬**한다.
///
/// `refine_with_anchors`가 "이미 밀렸을 수 있는 전역 경로에서 확신도로 앵커를
/// 역산"하는 것과 달리, 여기서는 **그라운드 트루스**(수동 싱크 줄·보컬시작 마커)를
/// 앵커로 받는다. 각 앵커는 "이 토큰 위치가 이 프레임에서 시작한다"는 고정점이라,
/// 앵커 사이 구간에서 한 번 어긋나도 다음 앵커에서 반드시 리셋된다 — 곡 전체로
/// 밀림이 전파되던 근본 문제를 끊는다.
///
/// `anchors`: (토큰 인덱스, 프레임) 쌍의 목록. 프레임·토큰 모두 **순증가**여야 하며
/// (호출 측에서 정제), 암묵적 시작 `(0,0)`과 끝 `(n_tokens, n_frames)`을 더해
/// 구간을 만든다. 반환은 전역 토큰 인덱스(blank는 `usize::MAX`)의 프레임별 경로.
fn segmented_align_with_anchors(
    aligner: &Aligner,
    emission_probs: &Array2<f32>,
    target_tokens: &[usize],
    anchors: &[(usize, usize)],
    trans_p: f32,
    blank_p: f32,
    rep_p: f32,
) -> Vec<usize> {
    let n_frames = emission_probs.nrows();
    let n_tokens = target_tokens.len();
    let mut bounds: Vec<(usize, usize)> = Vec::with_capacity(anchors.len() + 2);
    bounds.push((0, 0));
    bounds.extend_from_slice(anchors);
    bounds.push((n_tokens, n_frames));

    let mut path = vec![usize::MAX; n_frames];
    for w in bounds.windows(2) {
        let (t0, f0) = w[0];
        let (t1, f1) = w[1];
        if f1 <= f0 || t1 <= t0 {
            // 프레임이 없거나 토큰이 없는 구간 — blank로 둔다(간주·인트로 등).
            continue;
        }
        let sub_tokens = &target_tokens[t0..t1];
        let sub = aligner.forced_align_range(emission_probs, sub_tokens, f0, f1, trans_p, blank_p, rep_p);
        if sub.len() != f1 - f0 {
            continue;
        }
        for (k, &local) in sub.iter().enumerate() {
            path[f0 + k] = if local == usize::MAX { usize::MAX } else { local + t0 };
        }
    }
    path
}

/// 프론트가 준 앵커 `(입력 줄 인덱스, ms)`를 정렬에 쓸 `(토큰 인덱스, 프레임)`으로
/// 변환하고, 프레임·토큰이 **순증가**하도록 정제한다(모순된 수동 싱크는 버림).
/// `orig_to_pos`: 입력 줄 인덱스 → 정제된 lyric_lines 위치.
fn resolve_anchor_points(
    anchors: &[(usize, i64)],
    orig_to_pos: &HashMap<usize, usize>,
    line_spans: &[LineTokenSpan],
    frame_duration_ms: f32,
    n_frames: usize,
) -> Vec<(usize, usize)> {
    let mut pts: Vec<(usize, usize)> = Vec::new();
    for &(orig_idx, ms) in anchors {
        if ms < 0 {
            continue;
        }
        let Some(&pos) = orig_to_pos.get(&orig_idx) else { continue };
        if pos >= line_spans.len() {
            continue;
        }
        let tok = line_spans[pos].tok_from;
        let frame = ((ms as f64 / frame_duration_ms as f64).round() as usize).min(n_frames.saturating_sub(1));
        pts.push((tok, frame));
    }
    // 줄 순서(토큰)로 정렬한 뒤 시간이 순증가하는 앵커만 남긴다. 프레임순으로
    // 정렬하면 모순된 수동 싱크 하나(뒷줄을 앞 시각으로) 때문에 정상 앵커들이
    // 통째로 밀려날 수 있어서다 — 줄 순서 기준이면 순서를 어긴 그 하나만 버린다.
    pts.sort_by_key(|&(t, _)| t);

    let mut clean: Vec<(usize, usize)> = Vec::new();
    for (tok, frame) in pts {
        if let Some(&(pt, pf)) = clean.last() {
            // 토큰·프레임 모두 앞 앵커보다 뒤여야 유효(순서 어긴 앵커 폐기).
            if tok <= pt || frame <= pf {
                continue;
            }
        } else if tok == 0 && frame == 0 {
            // (0,0)은 암묵적 시작과 중복 — 명시 앵커로는 무의미.
            continue;
        }
        clean.push((tok, frame));
    }
    clean
}

/// 줄별 음향 확신도(0~1)를 계산한다. 각 줄의 토큰이 최종 경로에서 배정된
/// 프레임에서의 평균 emission 로그확률을 exp()해 기하평균 확률로 돌려준다.
/// 배정 프레임이 없는 줄(타 언어·보간)은 0.0.
fn line_confidences(
    emission_probs: &Array2<f32>,
    target_tokens: &[usize],
    line_spans: &[LineTokenSpan],
    path: &[usize],
) -> Vec<f32> {
    let mut out = Vec::with_capacity(line_spans.len());
    for ls in line_spans {
        if ls.tok_to <= ls.tok_from {
            out.push(0.0);
            continue;
        }
        let mut sum = 0f32;
        let mut cnt = 0usize;
        for (f, &tok_idx) in path.iter().enumerate() {
            if tok_idx == usize::MAX {
                continue;
            }
            if tok_idx >= ls.tok_from && tok_idx < ls.tok_to {
                sum += emission_probs[[f, target_tokens[tok_idx]]];
                cnt += 1;
            }
        }
        if cnt == 0 {
            out.push(0.0);
        } else {
            // 로그확률 평균 → exp로 기하평균 확률(0~1)로. NaN/음수는 0으로 가둔다.
            let c = (sum / cnt as f32).exp();
            out.push(if c.is_finite() { c.clamp(0.0, 1.0) } else { 0.0 });
        }
    }
    out
}

/// 각 줄에 속한 목표 토큰 중 최종 Viterbi 경로가 한 프레임 이상 방문한 비율.
/// CTC가 줄 전체를 blank/보간으로 넘긴 경우를 confidence와 독립적으로 잡는다.
fn line_token_coverages(line_spans: &[LineTokenSpan], path: &[usize]) -> Vec<f32> {
    line_spans.iter().map(|span| {
        let expected = span.tok_to.saturating_sub(span.tok_from);
        if expected == 0 { return 0.0; }
        let mut seen = vec![false; expected];
        for &token_index in path {
            if token_index >= span.tok_from && token_index < span.tok_to {
                seen[token_index - span.tok_from] = true;
            }
        }
        seen.into_iter().filter(|visited| *visited).count() as f32 / expected as f32
    }).collect()
}

fn line_vocal_activity(activity_frames: &[f32], start_frame: usize, end_frame: usize) -> f32 {
    if activity_frames.is_empty() || end_frame <= start_frame { return 1.0; }
    let from = start_frame.min(activity_frames.len());
    let to = end_frame.min(activity_frames.len());
    if to <= from { return 1.0; }
    activity_frames[from..to].iter().sum::<f32>() / (to - from) as f32
}

/// Full-song 20ms VAD를 프런트에 보내기 좋은 연속 구간으로 압축한다.
/// 200ms 이하의 짧은 공백은 리버브/자음 사이 끊김으로 보고 합치고,
/// 160ms보다 짧은 단독 활성 구간은 클릭·누설음일 가능성이 높아 제외한다.
fn summarize_vocal_regions(activity_frames: &[f32], frame_duration_ms: i64) -> Vec<VocalRegion> {
    const ACTIVITY_THRESHOLD: f32 = 0.12;
    const MAX_GAP_FRAMES: usize = 10;
    const MIN_REGION_FRAMES: usize = 8;

    if activity_frames.is_empty() || frame_duration_ms <= 0 {
        return Vec::new();
    }

    let mut raw_runs = Vec::new();
    let mut run_start = None;
    for (frame, &activity) in activity_frames.iter().enumerate() {
        if activity >= ACTIVITY_THRESHOLD {
            if run_start.is_none() {
                run_start = Some(frame);
            }
        } else if let Some(start) = run_start.take() {
            raw_runs.push((start, frame));
        }
    }
    if let Some(start) = run_start {
        raw_runs.push((start, activity_frames.len()));
    }

    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in raw_runs {
        if let Some(previous) = merged.last_mut() {
            if start.saturating_sub(previous.1) <= MAX_GAP_FRAMES {
                previous.1 = end;
                continue;
            }
        }
        merged.push((start, end));
    }

    merged
        .into_iter()
        .filter(|(start, end)| end.saturating_sub(*start) >= MIN_REGION_FRAMES)
        .map(|(start, end)| {
            let activity = activity_frames[start..end].iter().sum::<f32>() / (end - start) as f32;
            VocalRegion {
                start_ms: start as i64 * frame_duration_ms,
                end_ms: end as i64 * frame_duration_ms,
                activity: activity.clamp(0.0, 1.0),
            }
        })
        .collect()
}

/// 전역 coarse 경로의 단어 시각을 줄 단위 범위로 바꾼다. 이 시각은 최종
/// 결과가 아니라 VAD phrase 경계를 찾기 위한 관측값이므로, 경계를 찾지
/// 못하면 호출자는 기존 경로를 그대로 사용한다.
fn line_time_ranges(lyric_lines: &[String], timestamps: &[WordTimestamp]) -> Vec<(i64, i64)> {
    let mut out = Vec::with_capacity(lyric_lines.len());
    let mut word_cursor = 0usize;
    for line in lyric_lines {
        let word_count = line.split_whitespace().count();
        let from = word_cursor.min(timestamps.len());
        let to = word_cursor.saturating_add(word_count).min(timestamps.len());
        if from < to {
            out.push((timestamps[from].start_ms as i64, timestamps[to - 1].end_ms as i64));
        } else {
            out.push((0, 0));
        }
        word_cursor = word_cursor.saturating_add(word_count);
    }
    out
}

/// 인접한 줄 사이에서 충분히 긴 저활동 구간을 찾는다. 이 경계는 모델이
/// 확신한 줄처럼 취급하지 않고, phrase window를 나누는 약한 자동 앵커로만
/// 사용한다. 짧은 자음 공백·리버브 꼬리는 경계로 채택하지 않는다.
fn detect_vad_phrase_anchors(
    line_spans: &[LineTokenSpan],
    line_times: &[(i64, i64)],
    activity_frames: &[f32],
    frame_duration_ms: f32,
) -> Vec<(usize, usize)> {
    const SILENCE_ACTIVITY_THRESHOLD: f32 = 0.12;
    const MIN_SILENCE_FRAMES: usize = 15; // 300ms at the 20ms CTC frame rate

    if activity_frames.is_empty() || line_spans.len() < 2 || line_times.len() != line_spans.len() {
        return Vec::new();
    }
    let mut anchors = Vec::new();
    for i in 0..line_spans.len() - 1 {
        let (line_start, line_end) = line_times[i];
        let (next_start, _) = line_times[i + 1];
        if line_spans[i].tok_to <= line_spans[i].tok_from
            || line_spans[i + 1].tok_to <= line_spans[i + 1].tok_from
            || line_end <= line_start
            || next_start <= line_end
        {
            continue;
        }

        let from = ((line_end as f32 / frame_duration_ms).ceil() as usize).min(activity_frames.len());
        let to = ((next_start as f32 / frame_duration_ms).floor() as usize).min(activity_frames.len());
        if to <= from { continue; }

        let mut best_run = (0usize, 0usize);
        let mut run_start = None;
        for frame in from..to {
            if activity_frames[frame] <= SILENCE_ACTIVITY_THRESHOLD {
                if run_start.is_none() { run_start = Some(frame); }
            } else if let Some(start) = run_start.take() {
                if frame - start > best_run.1 - best_run.0 { best_run = (start, frame); }
            }
        }
        if let Some(start) = run_start {
            if to - start > best_run.1 - best_run.0 { best_run = (start, to); }
        }
        if best_run.1.saturating_sub(best_run.0) >= MIN_SILENCE_FRAMES {
            let boundary_frame = best_run.0 + (best_run.1 - best_run.0) / 2;
            anchors.push((line_spans[i + 1].tok_from, boundary_frame));
        }
    }
    anchors
}

/// 자동 VAD 앵커를 수동 앵커와 합친다. 수동 앵커의 토큰·시간은 절대
/// 이동하지 않으며, 그 사이에서만 자동 앵커를 추가한다. 자동 앵커끼리
/// 순서가 충돌하면 해당 자동 앵커만 버린다.
fn merge_phrase_anchors(
    manual: &[(usize, usize)],
    automatic: &[(usize, usize)],
) -> Vec<(usize, usize)> {
    let mut candidates: Vec<(usize, usize, bool)> = manual
        .iter()
        .map(|&(tok, frame)| (tok, frame, true))
        .collect();
    for &(tok, frame) in automatic {
        if manual.iter().any(|&(manual_tok, _)| manual_tok == tok) { continue; }
        let lower = manual.iter().filter(|&&(t, _)| t < tok).max_by_key(|&&(t, _)| t);
        let upper = manual.iter().filter(|&&(t, _)| t > tok).min_by_key(|&&(t, _)| t);
        if lower.map(|&(_, f)| frame <= f).unwrap_or(false)
            || upper.map(|&(_, f)| frame >= f).unwrap_or(false)
        {
            continue;
        }
        candidates.push((tok, frame, false));
    }
    candidates.sort_by_key(|&(tok, _, is_manual)| (tok, !is_manual));

    let mut out: Vec<(usize, usize, bool)> = Vec::new();
    for candidate in candidates {
        if let Some(last) = out.last() {
            if candidate.0 <= last.0 || candidate.1 <= last.1 {
                if candidate.2 && !last.2 {
                    out.pop();
                } else {
                    continue;
                }
            }
        }
        if let Some(last) = out.last() {
            if candidate.0 <= last.0 || candidate.1 <= last.1 { continue; }
        }
        out.push(candidate);
    }
    out.into_iter().map(|(tok, frame, _)| (tok, frame)).collect()
}

/// 줄의 Viterbi 프레임에서 목표 토큰과 같은 행의 최선의 다른 토큰 사이
/// margin을 계산한다. emission 절대값이 전체 곡에서 흔들려도, 모델이 그
/// 토큰을 다른 후보보다 선택했는지를 별도 증거로 사용할 수 있다.
fn line_acoustic_margins(
    emission_probs: &Array2<f32>,
    target_tokens: &[usize],
    line_spans: &[LineTokenSpan],
    path: &[usize],
) -> Vec<f32> {
    let vocab = emission_probs.ncols();
    line_spans.iter().map(|span| {
        if span.tok_to <= span.tok_from || vocab < 2 { return 0.0; }
        let mut sum = 0.0f32;
        let mut count = 0usize;
        for (frame, &token_index) in path.iter().enumerate() {
            if token_index == usize::MAX || token_index < span.tok_from || token_index >= span.tok_to {
                continue;
            }
            let target_id = target_tokens[token_index].min(vocab - 1);
            let target_score = emission_probs[[frame, target_id]];
            let mut best_other = f32::NEG_INFINITY;
            for id in 0..vocab {
                if id != target_id { best_other = best_other.max(emission_probs[[frame, id]]); }
            }
            let delta = (target_score - best_other).clamp(-20.0, 20.0);
            let margin = 1.0 / (1.0 + (-delta).exp());
            if margin.is_finite() { sum += margin; count += 1; }
        }
        if count == 0 { 0.0 } else { (sum / count as f32).clamp(0.0, 1.0) }
    }).collect()
}

fn multi_evidence_confidences(
    emission: &[f32],
    margins: &[f32],
    coverages: &[f32],
    activities: &[f32],
) -> Vec<f32> {
    emission.iter().enumerate().map(|(i, &raw)| {
        let margin = margins.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0);
        let coverage = coverages.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0);
        let activity = activities.get(i).copied().unwrap_or(1.0).clamp(0.0, 1.0);
        (raw.clamp(0.0, 1.0)
            * (0.70 + 0.30 * margin)
            * (0.75 + 0.25 * coverage)
            * (0.85 + 0.15 * activity)).clamp(0.0, 1.0)
    }).collect()
}

fn perform_alignment_internal(
    emission_probs: &Array2<f32>,
    tokens_path: &Path,
    lyrics: &str,
    line_ids: &[String],
    vocal_activity_frames: &[f32],
    trans_p: f32,
    blank_p: f32,
    rep_p: f32,
    anchors: &[(usize, i64)],
    time_offset_ms: i64,
    emission_cache_hit: bool,
    audio_duration_ms: i64,
    vocal_regions: &[VocalRegion],
) -> Result<AlignmentResult, String> {
    let aligner = Aligner::new(tokens_path.to_str().unwrap())?;
    let frame_duration_ms = 20.0f32;

    // 입력 줄을 **줄 단위로** 정제하면서 원본 인덱스를 보존한다. 앵커는 프론트가
    // 준 입력 줄 인덱스로 오는데, clean_lyrics가 지시어 줄([Chorus] 등)을 통째로
    // 지워 줄 수가 줄면 인덱스가 어긋나기 때문 — orig_of_line로 다시 잇는다.
    let mut lyric_lines: Vec<String> = Vec::new();
    let mut orig_of_line: Vec<usize> = Vec::new();
    for (i, raw) in lyrics.lines().enumerate() {
        let c = clean_lyrics(raw);
        let c = c.trim();
        if !c.is_empty() {
            lyric_lines.push(c.to_owned());
            orig_of_line.push(i);
        }
    }
    let cleaned_lyrics = lyric_lines.join("\n");

    let (target_tokens, word_spans) = aligner.tokenize(&cleaned_lyrics);
    if target_tokens.is_empty() { return Err("유효한 가사 토큰이 없습니다.".to_string()); }

    let line_spans = line_token_spans(&lyric_lines, &word_spans);

    // 사용자 하드 앵커(수동 싱크·보컬시작)를 (토큰, 프레임)으로 변환·정제.
    let orig_to_pos: HashMap<usize, usize> =
        orig_of_line.iter().enumerate().map(|(pos, &orig)| (orig, pos)).collect();
    let anchor_pts = resolve_anchor_points(
        anchors, &orig_to_pos, &line_spans, frame_duration_ms, emission_probs.nrows(),
    );

    let coarse_path = if !anchor_pts.is_empty() {
        // 앵커가 있으면 그 고정점으로 구간을 나눠 정렬한다 — 밀림이 앵커를 넘어
        // 전파되지 않는다. 사용자가 확정한 시각이므로 확신도 재정렬보다 강하다.
        sys_log(&format!("[Alignment] 사용자 앵커 {}개로 구간 분할 정렬", anchor_pts.len()));
        segmented_align_with_anchors(
            &aligner, emission_probs, &target_tokens, &anchor_pts, trans_p, blank_p, rep_p,
        )
    } else {
        // 앵커가 없으면 전역 1회 정렬 후, 확신도 높은 줄을 앵커로 그 사이만 재정렬.
        let global = aligner.forced_align(emission_probs, &target_tokens, trans_p, blank_p, rep_p);
        refine_with_anchors(
            &aligner, emission_probs, &target_tokens, &line_spans,
            &global, trans_p, blank_p, rep_p,
        )
        .unwrap_or(global)
    };
    if CANCEL_ALIGNMENT.load(Ordering::SeqCst) {
        return Err("작업이 사용자에 의해 취소되었습니다.".to_string());
    }

    // 한국어 1차도 전곡 경로를 그대로 신뢰하지 않고, coarse 경로에서 줄
    // 사이의 긴 무성 구간을 찾아 phrase window를 만든다. 자동 경계는 수동
    // 앵커보다 약하므로 모순되면 추가하지 않는다.
    let coarse_timestamps = aligner.get_word_timestamps(
        &coarse_path, &word_spans, frame_duration_ms,
    );
    let coarse_line_times = line_time_ranges(&lyric_lines, &coarse_timestamps);
    let auto_phrase_anchors = detect_vad_phrase_anchors(
        &line_spans,
        &coarse_line_times,
        vocal_activity_frames,
        frame_duration_ms,
    );
    let phrase_anchors = merge_phrase_anchors(&anchor_pts, &auto_phrase_anchors);
    let path = if phrase_anchors.len() > anchor_pts.len() {
        sys_log(&format!(
            "[Alignment] VAD phrase window {}개 추가 (수동 앵커 {}개, 자동 후보 {}개)",
            phrase_anchors.len() - anchor_pts.len(),
            anchor_pts.len(),
            auto_phrase_anchors.len(),
        ));
        segmented_align_with_anchors(
            &aligner, emission_probs, &target_tokens, &phrase_anchors,
            trans_p, blank_p, rep_p,
        )
    } else {
        coarse_path
    };
    if CANCEL_ALIGNMENT.load(Ordering::SeqCst) {
        return Err("작업이 사용자에 의해 취소되었습니다.".to_string());
    }
    let timestamps = aligner.get_word_timestamps(&path, &word_spans, frame_duration_ms);

    // 줄별 음향 확신도 — UI가 낮은 줄을 표시해 우선 검토를 유도한다(고친 줄은
    // 다음 정렬에서 앵커가 되어 선순환).
    let emission_confidences = line_confidences(emission_probs, &target_tokens, &line_spans, &path);
    let coverages = line_token_coverages(&line_spans, &path);
    let margins = line_acoustic_margins(emission_probs, &target_tokens, &line_spans, &path);
    let final_line_times = line_time_ranges(&lyric_lines, &timestamps);
    let activities: Vec<f32> = final_line_times.iter().map(|&(start_ms, end_ms)| {
        let start_frame = (start_ms as f32 / frame_duration_ms) as usize;
        let end_frame = (end_ms as f32 / frame_duration_ms) as usize;
        line_vocal_activity(vocal_activity_frames, start_frame, end_frame)
    }).collect();
    let confidences = multi_evidence_confidences(
        &emission_confidences, &margins, &coverages, &activities,
    );

    let greedy_path = aligner.greedy_decode(emission_probs);

    let mut all_line_alignments = Vec::new();
    let mut word_idx = 0;
    for (li, line_text) in lyric_lines.into_iter().enumerate() {
        let words_in_line: Vec<&str> = line_text.split_whitespace().collect();
        let mut line_words = Vec::new();
        let mut line_start_ms = 0;
        let mut line_end_ms = 0;

        for _ in 0..words_in_line.len() {
            if word_idx < timestamps.len() {
                let ts = &timestamps[word_idx];
                if line_words.is_empty() { line_start_ms = ts.start_ms as i64; }
                line_end_ms = ts.end_ms as i64;
                line_words.push(WordAlignment {
                    word: ts.word.clone(),
                    start_ms: ts.start_ms as i64,
                    end_ms: ts.end_ms as i64,
                });
                word_idx += 1;
            }
        }

        if !line_words.is_empty() {
            let start_frame = (line_start_ms as f32 / frame_duration_ms) as usize;
            let end_frame = (line_end_ms as f32 / frame_duration_ms) as usize;
            let extracted_text = aligner.get_text_from_path(&greedy_path, start_frame, end_frame);

            all_line_alignments.push(LineAlignment {
                segment_id: line_ids.get(orig_of_line[li]).cloned().unwrap_or_default(),
                input_index: orig_of_line[li],
                text: line_text,
                extracted_text,
                start_ms: line_start_ms + time_offset_ms,
                end_ms: line_end_ms + time_offset_ms,
                words: line_words.into_iter().map(|word| WordAlignment {
                    word: word.word,
                    start_ms: word.start_ms + time_offset_ms,
                    end_ms: word.end_ms + time_offset_ms,
                }).collect(),
                confidence: confidences.get(li).copied().unwrap_or(0.0),
                emission_confidence: emission_confidences.get(li).copied().unwrap_or(0.0),
                acoustic_margin: margins.get(li).copied().unwrap_or(0.0),
                token_coverage: coverages.get(li).copied().unwrap_or(0.0),
                vocal_activity: activities.get(li).copied().unwrap_or(1.0),
            });
        }
    }

    // 결과 시간을 자동으로 잘라내지 않는다. CTC가 간주를 한 줄에 강제로
    // 붙였을 수 있으므로, 원본 증거를 그대로 돌려주고 프런트 품질 게이트가
    // 해당 줄만 미싱크/검토 대상으로 남긴다.

    let diagnostics = AlignmentDiagnostics {
        manual_anchor_count: anchor_pts.len(),
        automatic_phrase_anchor_count: phrase_anchors.len().saturating_sub(anchor_pts.len()),
        phrase_window_count: phrase_anchors.len().saturating_add(1),
        phrase_boundary_ms: phrase_anchors.iter()
            .map(|&(_, frame)| frame as i64 * frame_duration_ms as i64 + time_offset_ms)
            .collect(),
        emission_cache_hit,
        audio_duration_ms,
        vocal_regions: vocal_regions.to_vec(),
    };

    Ok(AlignmentResult {
        words: Vec::new(),
        lines: all_line_alignments,
        raw_segments: Vec::new(),
        diagnostics,
    })
}

#[command]
pub async fn get_waveform_summary(handle: AppHandle, audio_path: String) -> Result<WaveformSummary, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    
    // 1. Resolve Path first (Prefers separated vocal)
    let resolved_path = resolve_audio_path(&handle, &audio_path).await?;
    
    // 2. Check Cache with metadata-aware key
    let waveform_cache_dir = paths.cache.join("waveforms");
    if !waveform_cache_dir.exists() {
        fs::create_dir_all(&waveform_cache_dir).ok();
    }
    
    // Use resolved path and its modified time to ensure cache validity
    let mtime = fs::metadata(&resolved_path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
        
    let cache_key_raw = format!("{}_{}", resolved_path.to_string_lossy(), mtime);
    let cache_key = urlencoding::encode(&cache_key_raw).to_string();
    let cache_path = waveform_cache_dir.join(format!("{}.json", cache_key));
    
    if cache_path.exists() {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if let Ok(summary) = serde_json::from_str::<WaveformSummary>(&content) {
                sys_log(&format!("[Alignment] Waveform loaded from cache: {:?}", resolved_path));
                return Ok(summary);
            }
        }
    }

    sys_log(&format!("[Alignment] Generating waveform summary for: {:?}", resolved_path));
    
    let processor = AudioProcessor::new();
    let n_buckets = 2000;
    
    let (points, duration_sec) = processor.create_waveform_summary(&resolved_path, n_buckets)?;
    let summary = WaveformSummary { 
        points, 
        duration_sec
    };

    // 3. Save to Cache
    if let Ok(json) = serde_json::to_string(&summary) {
        fs::write(&cache_path, json).ok();
    }
    
    sys_log(&format!("[Alignment] Waveform summary generated and cached: {} points, {:.2}s", summary.points.len(), duration_sec));
    Ok(summary)
}

/// 유튜브 URL 등을 실제 로컬 오디오 파일 경로로 변환합니다.
async fn resolve_audio_path(handle: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let paths = crate::state::AppPaths::from_handle(handle);
    let normalized_input = path.replace("\\", "/");
    let lower_input = normalized_input.to_lowercase();

    // 1) If this is a separated artifact/path, always prefer vocal waveform.
    let is_explicit_separated = lower_input.contains("/cache/separated/")
        || lower_input.contains("\\cache\\separated\\")
        || lower_input.ends_with("/vocal.wav")
        || lower_input.ends_with("\\vocal.wav")
        || lower_input.ends_with("/vocal.mp3")
        || lower_input.ends_with("\\vocal.mp3")
        || lower_input.ends_with("/inst.wav")
        || lower_input.ends_with("\\inst.wav")
        || lower_input.ends_with("/inst.mp3")
        || lower_input.ends_with("\\inst.mp3");
    if is_explicit_separated {
        let p = PathBuf::from(path);
        if p.is_file() {
            if p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| crate::mr_cache::is_inst_stem_name(n))
                .unwrap_or(false)
            {
                if let Some(parent) = p.parent() {
                    if let Some(vocal) = crate::mr_cache::resolve_vocal(parent) {
                        return Ok(vocal);
                    }
                }
            }
            return Ok(p);
        }
        if let Some(vocal) = crate::mr_cache::resolve_vocal(&p) {
            return Ok(vocal);
        }
    }

    // 2) For normal tracks, if separated outputs exist for the same source, use vocal stem.
    let mut lookup_keys = if path.starts_with("http") {
        youtube_url_variants(path)
    } else {
        let mut v = vec![path.to_string()];
        let normalized = normalize_path_key(path);
        if normalized != path {
            v.push(normalized);
        }
        v
    };
    lookup_keys.sort();
    lookup_keys.dedup();
    for key in lookup_keys {
        let cache_dir = paths.separated.join(urlencoding::encode(&key).to_string());
        if let Some(vocal) = crate::mr_cache::resolve_vocal(&cache_dir) {
            return Ok(vocal);
        }
    }

    // 3) Fallback to original source.
    if !path.starts_with("http") {
        let p = PathBuf::from(path);
        if p.exists() { return Ok(p); }
        return Err(format!("파일을 찾을 수 없습니다: {}", path));
    }

    // 4. temp 폴더에 다운로드된 m4a 파일이 있는지 확인
    // yt_id.m4a 형식이므로 id를 추출해야 함
    let metadata = crate::youtube::YoutubeManager::get_video_metadata(path).await.map_err(|e| e.to_string())?;
    if let Some(id) = metadata.id {
        let temp_m4a = paths.temp.join(format!("yt_{}.m4a", id));
        if temp_m4a.exists() {
            return Ok(temp_m4a);
        }
        
        // 5. 없으면 다운로드 시도 (사용자 요청에 따라)
        sys_log(&format!("[Alignment] Audio file not found for {}, starting download...", path));
        let window = handle.get_webview_window("main").ok_or("메인 윈도우를 찾을 수 없습니다")?;
        let downloaded = crate::youtube::YoutubeManager::download_audio(&window, path, temp_m4a.clone(), true).await?;
        return Ok(downloaded);
    }

    Err("유튜브 오디오 경로를 해소할 수 없습니다.".into())
}

pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

pub struct Aligner {
    token_to_id: HashMap<String, usize>,
    blank_id: usize,
    space_id: Option<usize>,
    unk_id: usize,
    is_syllable_based: bool,
    /// vocab이 라틴 문자(대문자 A–Z) 기반인지 — 영어 wav2vec2 CTC 모델.
    /// 이 경우 토크나이즈는 글자 단위(대문자화), 디코딩은 직결합.
    is_latin_based: bool,
    /// vocab에 아포스트로피(`'`)가 있는지 — 영어 축약형(don't) 유지 여부.
    has_apostrophe: bool,
}

impl Aligner {
    pub fn new(tokens_path: &str) -> Result<Self, String> {
        let file = fs::File::open(tokens_path).map_err(|e| format!("토큰 파일 오픈 실패: {}", e))?;
        let reader = BufReader::new(file);
        let mut token_to_id = HashMap::new();
        let mut has_syllables = false;
        let mut has_latin = false;

        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let line = line.trim_end();
            if line.is_empty() { continue; }
            if let Some(idx) = line.rfind(' ') {
                let token = &line[..idx];
                let id_str = &line[idx + 1..];
                if let Ok(id) = id_str.parse::<usize>() {
                    token_to_id.insert(token.to_string(), id);

                    if let Some(c) = token.chars().next() {
                        let cp = c as u32;
                        // 완성형 한글(AC00-D7AF) → 음절 기반
                        if (0xAC00..=0xD7AF).contains(&cp) {
                            has_syllables = true;
                        }
                        // 단일 라틴 대문자 토큰 → 영어 char-level 모델
                        if token.chars().count() == 1 && c.is_ascii_uppercase() {
                            has_latin = true;
                        }
                    }
                }
            }
        }
        let blank_id = token_to_id.get("[PAD]").copied()
            .or_else(|| token_to_id.get("<pad>").copied())
            .or_else(|| token_to_id.get("<blank>").copied())
            .unwrap_or(0);
        let space_id = token_to_id.get(" ").copied()
            .or_else(|| token_to_id.get("|").copied());
        let unk_id = token_to_id.get("[UNK]").copied()
            .or_else(|| token_to_id.get("<unk>").copied())
            .unwrap_or(blank_id);
        // 라틴 기반은 한글 vocab이 아닐 때만(혼동 방지).
        let is_latin_based = has_latin && !has_syllables;
        let has_apostrophe = token_to_id.contains_key("'");

        Ok(Self {
            token_to_id,
            blank_id,
            space_id,
            unk_id,
            is_syllable_based: has_syllables,
            is_latin_based,
            has_apostrophe,
        })
    }

    /// Whether `c` falls in any Hangul Unicode block (syllables, jamo, or
    /// compatibility jamo) — i.e. something a Korean acoustic model could
    /// plausibly have a real token for.
    fn is_hangul_char(c: char) -> bool {
        let cp = c as u32;
        (0xAC00..=0xD7A3).contains(&cp)   // Hangul syllables
            || (0x1100..=0x11FF).contains(&cp) // Hangul jamo
            || (0x3130..=0x318F).contains(&cp) // Hangul compatibility jamo
    }

    /// 이 vocab(모델)이 음향적으로 표현할 수 있는 "글자"인지.
    /// 라틴 모델 → 라틴 문자(+아포스트로피), 한글 모델 → 한글. 숫자·문장부호·
    /// 특수기호·이모지·타 스크립트 문자는 전부 false → tokenize에서 걸러진다.
    fn is_representable_char(&self, c: char) -> bool {
        if self.is_latin_based {
            c.is_ascii_alphabetic() || (self.has_apostrophe && (c == '\'' || c == '\u{2019}'))
        } else {
            Self::is_hangul_char(c)
        }
    }


    pub fn tokenize(&self, text: &str) -> (Vec<usize>, Vec<(usize, usize, String)>) {
        let mut ids = Vec::new();
        let mut word_spans = Vec::new();
        let words: Vec<&str> = text.split_whitespace().collect();

        for (wi, word) in words.iter().enumerate() {
            let start_idx = ids.len();

            // 글자 이외 문자 필터: 모델이 표현할 수 있는 글자만 남긴다(양끝뿐
            // 아니라 단어 중간의 숫자·문장부호·특수기호·타 언어 문자도 제거).
            // 컬 아포스트로피(’)는 straight(')로 정규화해 vocab과 맞춘다.
            let filtered: String = word
                .chars()
                .filter(|&c| self.is_representable_char(c))
                .map(|c| if c == '\u{2019}' { '\'' } else { c })
                .collect();

            // 남는 글자가 없으면(순수 기호/숫자/타 언어 단어) 정렬 대상에서
            // 제외 — zero-width span으로 두고 get_word_timestamps가 이웃 사이
            // 시간을 나눠 보간한다. word_spans엔 원문 그대로 보존.
            //
            // 다른 언어로만 된 줄(랩/혼합 곡의 영어 블록 등)도 여기서 0폭이
            // 된다. 그 구간의 실제 노래 시간은 **CTC blank가 공짜로 흡수**하므로
            // 별도 조치가 필요 없다. 예전에 "시간이 든다"고 알리려 UNK 토큰으로
            // 채운 적이 있는데, UNK는 음향적 근거가 없어 Viterbi가 프레임을
            // 임의로 빨아들여 한 줄이 수십 초짜리 블럭이 되는 역효과만 났다.
            if filtered.is_empty() {
                word_spans.push((start_idx, start_idx, word.to_string()));
                if wi < words.len() - 1 { if let Some(sid) = self.space_id { ids.push(sid); } }
                continue;
            }

            if self.is_latin_based {
                // 영어 char-level: 대문자화 후 글자마다 매핑(vocab이 대문자 A–Z).
                for c in filtered.chars() {
                    let s = c.to_ascii_uppercase().to_string();
                    ids.push(*self.token_to_id.get(&s).unwrap_or(&self.unk_id));
                }
            } else if self.is_syllable_based {
                // 음절 기반: 완성형 한글이 vocab에 있는 경우
                for c in filtered.chars() {
                    ids.push(*self.token_to_id.get(&c.to_string()).unwrap_or(&self.unk_id));
                }
            } else {
                // 자모 기반: NFD 분해 후 호환 자모로 매핑
                let decomposed = filtered.nfd().collect::<String>();
                for c in decomposed.chars() {
                    let s = self.to_compatibility_jamo(c);
                    ids.push(*self.token_to_id.get(&s).unwrap_or(&self.unk_id));
                }
            }

            if ids.len() == start_idx { ids.push(self.unk_id); }
            word_spans.push((start_idx, ids.len(), word.to_string()));
            if wi < words.len() - 1 { if let Some(sid) = self.space_id { ids.push(sid); } }
        }
        (ids, word_spans)
    }

    fn to_compatibility_jamo(&self, c: char) -> String {
        let cp = c as u32;
        if cp >= 0x1100 && cp <= 0x1112 {
            let mapping = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
            return mapping[(cp - 0x1100) as usize].to_string();
        }
        if cp >= 0x1161 && cp <= 0x1175 {
            let mapping = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
            return mapping[(cp - 0x1161) as usize].to_string();
        }
        if cp >= 0x11A8 && cp <= 0x11C2 {
            let mapping = ['ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
            return mapping[(cp - 0x11A8) as usize].to_string();
        }
        c.to_string()
    }

    pub fn forced_align(&self, emission_probs: &Array2<f32>, target_tokens: &[usize], trans_penalty: f32, blank_penalty: f32, rep_penalty: f32) -> Vec<usize> {
        self.forced_align_range(emission_probs, target_tokens, 0, emission_probs.nrows(), trans_penalty, blank_penalty, rep_penalty)
    }

    /// `forced_align`을 프레임 구간 `[frame_start, frame_end)` 에만 적용한다.
    /// 앵커 사이 구간을 독립적으로 재정렬할 때 쓴다 — 구간을 좁히면 그 안의
    /// 토큰들이 그 시간 범위 안에 갇히므로, 전역 정렬에서 한 번 밀린 결과가
    /// 뒤까지 전파되지 않는다.
    ///
    /// 반환 길이는 `frame_end - frame_start`이고, 값은 `target_tokens` 기준의
    /// **로컬** 인덱스(또는 blank는 `usize::MAX`)다.
    pub fn forced_align_range(
        &self,
        emission_probs: &Array2<f32>,
        target_tokens: &[usize],
        frame_start: usize,
        frame_end: usize,
        trans_penalty: f32,
        blank_penalty: f32,
        rep_penalty: f32,
    ) -> Vec<usize> {
        let mut extended = Vec::with_capacity(target_tokens.len() * 2 + 1);
        for &t in target_tokens { extended.push(self.blank_id); extended.push(t); }
        extended.push(self.blank_id);
        let total_frames = emission_probs.nrows();
        let frame_end = frame_end.min(total_frames);
        let n_frames = frame_end.saturating_sub(frame_start);
        let n_states = extended.len();
        if n_frames == 0 || n_states == 0 { return vec![]; }
        let blank_path = || vec![usize::MAX; n_frames];
        // At least one frame per target token is required, plus an intervening
        // blank for consecutive identical CTC labels. Backtracking an
        // unreachable final state otherwise follows zero-initialized pointers
        // and fabricates a plausible-looking path.
        let repeated_labels = target_tokens.windows(2).filter(|pair| pair[0] == pair[1]).count();
        let min_required_frames = target_tokens.len().saturating_add(repeated_labels);
        if n_frames < min_required_frames
            || self.blank_id >= emission_probs.ncols()
            || target_tokens.iter().any(|&token| token >= emission_probs.ncols())
        {
            return blank_path();
        }
        let at = |t: usize, tok: usize| emission_probs[[frame_start + t, tok]];
        let mut dp = vec![vec![f32::NEG_INFINITY; n_states]; n_frames];
        let mut bp = vec![vec![0usize; n_states]; n_frames];
        dp[0][0] = at(0, extended[0]);
        if n_states > 1 { dp[0][1] = at(0, extended[1]); }
        for t in 1..n_frames {
            if t % 50 == 0 && CANCEL_ALIGNMENT.load(Ordering::SeqCst) {
                return blank_path();
            }
            for s in 0..n_states {
                let mut emit = at(t, extended[s]);
                if extended[s] == self.blank_id {
                    emit += blank_penalty;
                }

                let mut best = dp[t - 1][s];
                if extended[s] != self.blank_id {
                    best += rep_penalty;
                }

                let mut best_from = s;
                if s > 0 {
                    let val = dp[t - 1][s - 1] + trans_penalty;
                    if val > best { best = val; best_from = s - 1; }
                }
                if s > 1 && extended[s] != extended[s - 2] {
                    let val = dp[t - 1][s - 2] + trans_penalty;
                    if val > best { best = val; best_from = s - 2; }
                }
                dp[t][s] = best + emit; bp[t][s] = best_from;
            }
        }
        let mut state = n_states - 1;
        if n_states >= 2 && dp[n_frames - 1][n_states - 2] > dp[n_frames - 1][n_states - 1] { state = n_states - 2; }
        let mut path = vec![0usize; n_frames];
        path[n_frames - 1] = state;
        for t in (0..n_frames - 1).rev() { state = bp[t + 1][state]; path[t] = state; }
        path.iter().map(|&s| if s % 2 == 0 { usize::MAX } else { s / 2 }).collect()
    }

    pub fn get_word_timestamps(&self, path: &[usize], word_spans: &[(usize, usize, String)], frame_duration_ms: f32) -> Vec<WordTimestamp> {
        // Zero-width spans (non-Hangul words skipped by `tokenize`, or a word
        // whose acoustic states the Viterbi path never visited) have no timing
        // of their own — filled in below by interpolating between whichever
        // aligned words bracket them, so every word still gets a timestamp
        // instead of silently vanishing from the result.
        let mut result: Vec<Option<WordTimestamp>> = Vec::with_capacity(word_spans.len());
        for (token_start, token_end, word) in word_spans {
            if token_start == token_end {
                result.push(None);
                continue;
            }
            let mut first_frame = None; let mut last_frame = None;
            for (frame_idx, &token_idx) in path.iter().enumerate() {
                if token_idx != usize::MAX && token_idx >= *token_start && token_idx < *token_end {
                    if first_frame.is_none() { first_frame = Some(frame_idx); }
                    last_frame = Some(frame_idx);
                }
            }
            result.push(first_frame.zip(last_frame).map(|(start, end)| WordTimestamp {
                word: word.clone(),
                start_ms: (start as f32 * frame_duration_ms) as u32,
                end_ms: ((end + 1) as f32 * frame_duration_ms) as u32,
            }));
        }

        const FALLBACK_WORD_MS: u32 = 400;
        let mut i = 0;
        while i < result.len() {
            if result[i].is_some() { i += 1; continue; }
            let gap_start = i;
            let mut gap_end = i;
            while gap_end < result.len() && result[gap_end].is_none() { gap_end += 1; }
            let n = (gap_end - gap_start) as u32;

            let prev_end_ms = if gap_start > 0 { result[gap_start - 1].as_ref().map(|w| w.end_ms) } else { None };
            let next_start_ms = if gap_end < result.len() { result[gap_end].as_ref().map(|w| w.start_ms) } else { None };

            let (range_start, range_end) = match (prev_end_ms, next_start_ms) {
                (Some(s), Some(e)) if e > s => (s, e),
                (Some(s), _) => (s, s + FALLBACK_WORD_MS * n),
                (None, Some(e)) => (e.saturating_sub(FALLBACK_WORD_MS * n), e),
                (None, None) => (0, FALLBACK_WORD_MS * n),
            };

            let span = (range_end - range_start) / n;
            for (k, idx) in (gap_start..gap_end).enumerate() {
                let s = range_start + span * k as u32;
                let e = if k as u32 + 1 == n { range_end } else { s + span };
                result[idx] = Some(WordTimestamp { word: word_spans[idx].2.clone(), start_ms: s, end_ms: e.max(s + 1) });
            }
            i = gap_end;
        }

        result.into_iter().flatten().collect()
    }

    pub fn greedy_decode(&self, emission_probs: &Array2<f32>) -> Vec<usize> {
        let n_frames = emission_probs.nrows();
        let mut path = Vec::with_capacity(n_frames);
        for t in 0..n_frames {
            let mut best_idx = 0; let mut best_prob = f32::NEG_INFINITY;
            for (idx, &prob) in emission_probs.row(t).iter().enumerate() { if prob > best_prob { best_prob = prob; best_idx = idx; } }
            path.push(best_idx);
        }
        path
    }

    pub fn get_text_from_path(&self, path: &[usize], start: usize, end: usize) -> String {
        let end = end.min(path.len()); if start >= end { return String::new(); }
        let mut tokens = Vec::new(); let mut prev = None;
        for &t in &path[start..end] { if t != self.blank_id && Some(t) != prev { tokens.push(t); } prev = Some(t); }
        let mut id_to_token = HashMap::new();
        for (token, &id) in &self.token_to_id { id_to_token.insert(id, token.as_str()); }
        
        let mut parts = Vec::new();
        for id in tokens { 
            if let Some(&token) = id_to_token.get(&id) { 
                parts.push(token); 
            } 
        }
        
        if self.is_syllable_based || self.is_latin_based {
            // 음절-한글 또는 라틴(영어): 토큰을 그대로 직결합(| → 공백).
            parts.join("").replace("|", " ").trim().to_string()
        } else {
            // 자모-한글: 분해된 자모를 음절로 조립.
            self.assemble_hangul(&parts)
        }
    }

    fn assemble_hangul(&self, jamos: &[&str]) -> String {
        let mut combined = String::new();
        let mut cur_syllable = String::new();
        
        // Simple state machine to track syllable structure: empty -> choseong -> jungseong -> jongseong
        #[derive(PartialEq)]
        enum SyllableState { Empty, Choseong, Jungseong, Jongseong }
        let mut state = SyllableState::Empty;

        for &j in jamos {
            if j == " " || j == "|" {
                if !cur_syllable.is_empty() {
                    combined.push_str(&cur_syllable.nfc().collect::<String>());
                    cur_syllable.clear();
                }
                combined.push(' ');
                state = SyllableState::Empty;
                continue;
            }

            let is_vowel = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅜㅝㅞㅟㅠㅡㅢㅣ".contains(j);
            
            match state {
                SyllableState::Empty => {
                    if is_vowel {
                        // Vowel starting a syllable (unusual but possible)
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                        state = SyllableState::Jungseong;
                    } else {
                        cur_syllable.push(self.to_combining_jamo_internal(j, true));
                        state = SyllableState::Choseong;
                    }
                }
                SyllableState::Choseong => {
                    if is_vowel {
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                        state = SyllableState::Jungseong;
                    } else {
                        // Double consonant? Flush previous and start new choseong
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                        state = SyllableState::Choseong;
                    }
                }
                SyllableState::Jungseong => {
                    if is_vowel {
                        // Composite vowel?
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                    } else {
                        let c = self.to_combining_jamo_internal(j, false);
                        if c == ' ' { // Failed to find jongseong version
                            combined.push_str(&cur_syllable.nfc().collect::<String>());
                            cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                            state = SyllableState::Choseong;
                        } else {
                            cur_syllable.push(c);
                            state = SyllableState::Jongseong;
                        }
                    }
                }
                SyllableState::Jongseong => {
                    if is_vowel {
                        // Vowel after Jongseong! (e.g., 각 + ㅏ -> 가 + 가)
                        // Need to pull last jongseong and move it to choseong of next syllable
                        // For simplicity here, we flush and start new vowel syllable
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, false).to_string();
                        state = SyllableState::Jungseong;
                    } else {
                        // New consonant: flush and start next
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                        state = SyllableState::Choseong;
                    }
                }
            }
        }
        
        if !cur_syllable.is_empty() {
            combined.push_str(&cur_syllable.nfc().collect::<String>());
        }
        combined
    }

    fn to_combining_jamo_internal(&self, j: &str, is_initial: bool) -> char {
        match j {
            "ㄱ" => if is_initial { '\u{1100}' } else { '\u{11A8}' },
            "ㄲ" => if is_initial { '\u{1101}' } else { '\u{11A9}' },
            "ㄳ" => '\u{11AA}',
            "ㄴ" => if is_initial { '\u{1102}' } else { '\u{11AB}' },
            "ㄵ" => '\u{11AC}',
            "ㄶ" => '\u{11AD}',
            "ㄷ" => if is_initial { '\u{1103}' } else { '\u{11AE}' },
            "ㄸ" => if is_initial { '\u{1104}' } else { ' ' },
            "ㄹ" => if is_initial { '\u{1105}' } else { '\u{11AF}' },
            "ㄺ" => '\u{11B0}', "ㄻ" => '\u{11B1}', "ㄼ" => '\u{11B2}', "ㄽ" => '\u{11B3}', "ㄾ" => '\u{11B4}', "ㄿ" => '\u{11B5}', "ㅀ" => '\u{11B6}',
            "ㅁ" => if is_initial { '\u{1106}' } else { '\u{11B7}' },
            "ㅂ" => if is_initial { '\u{1107}' } else { '\u{11B8}' },
            "ㅃ" => if is_initial { '\u{1108}' } else { ' ' },
            "ㅄ" => '\u{11B9}',
            "ㅅ" => if is_initial { '\u{1109}' } else { '\u{11BA}' },
            "ㅆ" => if is_initial { '\u{110A}' } else { '\u{11BB}' },
            "ㅇ" => if is_initial { '\u{110B}' } else { '\u{11BC}' },
            "ㅈ" => if is_initial { '\u{110C}' } else { '\u{11BD}' },
            "ㅉ" => if is_initial { '\u{110D}' } else { ' ' },
            "ㅊ" => if is_initial { '\u{110E}' } else { '\u{11BE}' },
            "ㅋ" => if is_initial { '\u{110F}' } else { '\u{11BF}' },
            "ㅌ" => if is_initial { '\u{1110}' } else { '\u{11C0}' },
            "ㅍ" => if is_initial { '\u{1111}' } else { '\u{11C1}' },
            "ㅎ" => if is_initial { '\u{1112}' } else { '\u{11C2}' },
            "ㅏ" => '\u{1161}', "ㅐ" => '\u{1162}', "ㅑ" => '\u{1163}', "ㅒ" => '\u{1164}', "ㅓ" => '\u{1165}', "ㅔ" => '\u{1166}', "ㅕ" => '\u{1167}', "ㅖ" => '\u{1168}',
            "ㅗ" => '\u{1169}', "ㅘ" => '\u{116A}', "ㅙ" => '\u{116B}', "ㅚ" => '\u{116C}', "ㅛ" => '\u{116D}', "ㅜ" => '\u{116E}', "ㅝ" => '\u{116F}', "ㅞ" => '\u{1170}', "ㅟ" => '\u{1171}', "ㅠ" => '\u{1172}',
            "ㅡ" => '\u{1173}', "ㅢ" => '\u{1174}', "ㅣ" => '\u{1175}',
            _ => j.chars().next().unwrap_or(' '),
        }
    }
}

#[cfg(test)]
mod aligner_tests {
    use super::*;

    // The production cache is process-global. Serialize only the cache tests
    // so Rust's default parallel test runner cannot clear another test's data.
    static EMISSION_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn emission_cache_reuses_only_an_identical_audio_model_key() {
        let _test_lock = EMISSION_CACHE_TEST_LOCK.lock();
        EMISSION_CACHE.lock().clear();
        let key = InferenceCacheKey {
            audio_path: "song-vocal.wav".to_string(),
            audio_size: 100,
            audio_modified_ns: 10,
            model_path: "korean-model.onnx".to_string(),
            model_size: 200,
            model_modified_ns: 20,
        };
        let emission = Arc::new(Array2::<f32>::zeros((4, 3)));
        let activity = Arc::new(vec![0.2, 0.4, 0.6, 0.8]);
        store_cached_inference(key.clone(), Arc::clone(&emission), Arc::clone(&activity));

        let (cached_emission, cached_activity) = read_cached_inference(&key).expect("same key should hit");
        assert!(Arc::ptr_eq(&cached_emission, &emission));
        assert!(Arc::ptr_eq(&cached_activity, &activity));

        let mut changed_model = key.clone();
        changed_model.model_modified_ns += 1;
        assert!(read_cached_inference(&changed_model).is_none());
        EMISSION_CACHE.lock().clear();
    }

    #[test]
    fn emission_cache_keeps_korean_and_english_models_for_the_same_song() {
        let _test_lock = EMISSION_CACHE_TEST_LOCK.lock();
        EMISSION_CACHE.lock().clear();
        let korean = InferenceCacheKey {
            audio_path: "song-vocal.wav".to_string(),
            audio_size: 100,
            audio_modified_ns: 10,
            model_path: "korean-model.onnx".to_string(),
            model_size: 200,
            model_modified_ns: 20,
        };
        let mut english = korean.clone();
        english.model_path = "english-model.onnx".to_string();

        let korean_emission = Arc::new(Array2::<f32>::zeros((4, 3)));
        let english_emission = Arc::new(Array2::<f32>::zeros((5, 3)));
        let activity = Arc::new(vec![0.2, 0.4, 0.6, 0.8]);
        store_cached_inference(
            korean.clone(),
            Arc::clone(&korean_emission),
            Arc::clone(&activity),
        );
        store_cached_inference(
            english.clone(),
            Arc::clone(&english_emission),
            Arc::clone(&activity),
        );

        let (cached_korean, _) = read_cached_inference(&korean).expect("Korean model should stay warm");
        let (cached_english, _) = read_cached_inference(&english).expect("English model should stay warm");
        assert!(Arc::ptr_eq(&cached_korean, &korean_emission));
        assert!(Arc::ptr_eq(&cached_english, &english_emission));
        EMISSION_CACHE.lock().clear();
    }

    #[test]
    fn vocal_regions_merge_short_gaps_and_drop_clicks() {
        let mut activity = vec![0.0f32; 80];
        activity[5..15].fill(0.8);   // 100..300ms
        activity[20..30].fill(0.6); // 400..600ms, 100ms gap -> merge
        activity[50..54].fill(0.9); // 80ms click -> drop

        let regions = summarize_vocal_regions(&activity, 20);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].start_ms, 100);
        assert_eq!(regions[0].end_ms, 600);
        assert!(regions[0].activity > 0.4 && regions[0].activity < 0.8);
    }

    #[test]
    fn clean_lyrics_strips_structure_directives_only() {
        // 곡 구조 지시어는 통째로 제거.
        assert_eq!(clean_lyrics("[Chorus]\n사랑해").trim(), "사랑해");
        assert_eq!(clean_lyrics("(Verse 2) 오늘도 걸어").trim(), "오늘도 걸어");
        assert_eq!(clean_lyrics("[후렴]\n너를 사랑해").trim(), "너를 사랑해");
        assert_eq!(clean_lyrics("<Instrumental>").trim(), "");
    }

    #[test]
    fn clean_lyrics_keeps_real_chorus_lyrics() {
        // 괄호 안이 실제 가사(코러스/에코)면 표시만 벗기고 텍스트는 남긴다 —
        // 이게 없으면 forced_align이 곡 전체 순차 정렬에서 오디오에 있는
        // 코러스와 텍스트가 어긋나 그 이후 줄이 전부 밀린다.
        let cleaned = clean_lyrics("사랑해 (사랑해) 널");
        assert!(cleaned.contains("사랑해"));
        // 괄호로 감싸졌던 "사랑해"도 남아 있어야 하므로, "사랑해"가 최소 2번 등장.
        assert_eq!(cleaned.matches("사랑해").count(), 2);

        let cleaned_en = clean_lyrics("You're the one (the only one)");
        assert!(cleaned_en.contains("the only one"));
    }

    #[test]
    fn clean_lyrics_directive_match_is_whole_content_only() {
        // "Chorus"는 지시어지만 "Chorus of angels"는 실제 가사 문구이므로 유지.
        let cleaned = clean_lyrics("(Chorus of angels) sings");
        assert!(cleaned.contains("Chorus of angels"));
    }

    #[test]
    fn lrc_sync_status_detects_real_timestamps() {
        // 실제(0이 아닌) 타임스탬프가 하나라도 있으면 synced
        let synced = "[00:00.00]첫 줄\n[00:12.34]둘째 줄";
        assert_eq!(lrc_sync_status(synced), "synced");
        // 전부 00:00.00 (Meloming 시드/미타이밍) → unsynced
        let unsynced = "[00:00.00]첫 줄\n[00:00.00]둘째 줄";
        assert_eq!(lrc_sync_status(unsynced), "unsynced");
        // 타임스탬프가 아예 없음 → unsynced
        assert_eq!(lrc_sync_status("가사만 있고 태그 없음"), "unsynced");
        // 트리플렛 태그가 붙어도 시간만 보면 됨
        let triplet = "[00:00.00][orig]原文\n[00:05.00][pron]발음";
        assert_eq!(lrc_sync_status(triplet), "synced");
    }

    /// Writes a minimal syllable-based tokens.txt covering just the characters
    /// these tests need, returns its path. Caller is responsible for cleanup.
    fn write_test_vocab(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("align_test_vocab_{}_{}.txt", name, std::process::id()));
        let vocab = "[PAD] 0\n[UNK] 1\n  2\n나 3\n는 4\n가 5\n수 6\n다 7\n안 8\n녕 9\n";
        fs::write(&path, vocab).unwrap();
        path
    }

    /// 영어 wav2vec2 char-level vocab을 모방한 tokens.txt (대문자 A–Z, |, ').
    fn write_english_vocab(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("align_en_vocab_{}_{}.txt", name, std::process::id()));
        let mut vocab = String::from("<pad> 0\n<s> 1\n</s> 2\n<unk> 3\n| 4\n");
        let mut id = 5;
        for c in 'A'..='Z' {
            vocab.push_str(&format!("{} {}\n", c, id));
            id += 1;
        }
        vocab.push_str(&format!("' {}\n", id));
        fs::write(&path, vocab).unwrap();
        path
    }

    #[test]
    fn detects_latin_vocab_and_tokenizes_english() {
        let vocab_path = write_english_vocab("detect");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        assert!(aligner.is_latin_based, "대문자 A–Z vocab은 라틴으로 인식돼야 함");
        assert!(!aligner.is_syllable_based);
        assert!(aligner.has_apostrophe);

        // 소문자 입력이 대문자로 매핑되고 아포스트로피가 유지되는지
        let (ids, spans) = aligner.tokenize("don't stop");
        assert_eq!(spans.len(), 2);
        // 두 단어 모두 실제 토큰을 생성(zero-width 아님)
        assert!(spans[0].1 > spans[0].0);
        assert!(spans[1].1 > spans[1].0);
        // UNK가 섞이지 않아야 함(전부 vocab에 있는 글자)
        assert!(!ids.contains(&aligner.unk_id), "표현 가능한 영어 단어에 UNK가 없어야 함");
    }

    #[test]
    fn filters_digits_and_symbols_from_words() {
        let vocab_path = write_english_vocab("filter");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        // "2", "♪…", 숫자 섞인 단어 → 글자 외 문자가 걸러짐
        let (ids, spans) = aligner.tokenize("I have 2 cats ♪");
        // 단어 4개: I / have / 2 / cats / ♪ → split_whitespace 기준 5개
        assert_eq!(spans.len(), 5);
        // "2"와 "♪"는 남는 글자가 없어 zero-width 스킵
        let two = spans.iter().find(|s| s.2 == "2").unwrap();
        assert_eq!(two.0, two.1, "순수 숫자 단어는 zero-width");
        let note = spans.iter().find(|s| s.2 == "♪").unwrap();
        assert_eq!(note.0, note.1, "순수 특수기호 단어는 zero-width");
        // "have"/"cats"는 정상 토큰화, UNK 없음
        assert!(!ids.contains(&aligner.unk_id));

        // 단어 중간 숫자도 제거되는지: "l0ve" → "lve"(전부 vocab에 있어 UNK 없음)
        let (ids2, spans2) = aligner.tokenize("l0ve");
        assert!(spans2[0].1 > spans2[0].0);
        assert!(!ids2.contains(&aligner.unk_id), "단어 중간 숫자가 제거돼 UNK가 없어야 함");
    }

    #[test]
    fn korean_char_filter_still_works() {
        let vocab_path = write_test_vocab("kofilter");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        // 한글 모드에서도 숫자·기호가 걸러지고, 순수 기호 단어는 zero-width
        let (_ids, spans) = aligner.tokenize("나는 123 가수 !!");
        assert_eq!(spans.len(), 4);
        let num = spans.iter().find(|s| s.2 == "123").unwrap();
        assert_eq!(num.0, num.1);
        let bang = spans.iter().find(|s| s.2 == "!!").unwrap();
        assert_eq!(bang.0, bang.1);
    }

    #[test]
    fn is_hangul_char_classifies_korean_vs_latin() {
        assert!(Aligner::is_hangul_char('가'));
        assert!(Aligner::is_hangul_char('\u{1100}')); // Hangul jamo block
        assert!(Aligner::is_hangul_char('ㄱ')); // compatibility jamo
        assert!(!Aligner::is_hangul_char('a'));
        assert!(!Aligner::is_hangul_char('Z'));
        assert!(!Aligner::is_hangul_char('!'));
    }

    #[test]
    fn tokenize_skips_non_hangul_words_as_zero_width_spans() {
        let vocab_path = write_test_vocab("skip");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();

        let (ids, spans) = aligner.tokenize("나는 hater 다");
        std::fs::remove_file(&vocab_path).ok();

        assert_eq!(spans.len(), 3, "every word should still get a span entry");
        // "나는" — real Hangul, non-empty width.
        assert_ne!(spans[0].0, spans[0].1);
        // "hater" — pure Latin, must be zero-width (excluded from forced-align targets).
        assert_eq!(spans[1].0, spans[1].1, "English word must not consume CTC target tokens");
        assert_eq!(spans[1].2, "hater");
        // "다" — real Hangul again.
        assert_ne!(spans[2].0, spans[2].1);

        // No [UNK] ids should have been emitted for "hater" at all — its
        // characters must be completely absent from the target sequence,
        // not merely mapped to unk_id.
        let unk_count = ids.iter().filter(|&&id| id == aligner.unk_id).count();
        assert_eq!(unk_count, 0, "skipped word must not contribute any UNK ids");
    }

    #[test]
    fn word_timestamps_interpolates_gaps_between_aligned_neighbors() {
        let vocab_path = write_test_vocab("interp");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        // Two real words (token index ranges [0,2) and [2,4)) with a
        // zero-width word in between (simulating a skipped English word),
        // followed by a frame path that only ever visits the two real words.
        let word_spans = vec![
            (0usize, 2usize, "안녕".to_string()),
            (2, 2, "hey".to_string()),
            (2, 4, "나".to_string()),
        ];
        // 10 frames: first half assigned to token-index 0/1 range (word 0),
        // second half to token-index 2/3 range (word 2). MAX = blank.
        let path = vec![0, 0, 1, 1, usize::MAX, usize::MAX, 2, 2, 3, 3];

        let timestamps = aligner.get_word_timestamps(&path, &word_spans, 20.0);

        assert_eq!(timestamps.len(), 3, "the interpolated word must not be dropped");
        assert_eq!(timestamps[0].word, "안녕");
        assert_eq!(timestamps[2].word, "나");
        let gap_word = &timestamps[1];
        assert_eq!(gap_word.word, "hey");
        // Interpolated word must sit chronologically between its neighbors.
        assert!(gap_word.start_ms >= timestamps[0].end_ms);
        assert!(gap_word.end_ms <= timestamps[2].start_ms);
        assert!(gap_word.end_ms > gap_word.start_ms);
    }

    #[test]
    fn line_token_spans_maps_lines_to_token_ranges() {
        let vocab_path = write_test_vocab("spans");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        // 2번째 줄은 영어 전용 → 토큰을 소비하지 않아 빈 구간이어야 한다.
        let text = "나는 가수\nonly english\n안녕 다";
        let (_tokens, word_spans) = aligner.tokenize(text);
        let lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
        let spans = line_token_spans(&lines, &word_spans);

        assert_eq!(spans.len(), 3);
        assert!(spans[0].tok_to > spans[0].tok_from, "한국어 줄은 토큰 소비");
        assert_eq!(spans[1].tok_from, spans[1].tok_to, "영어 전용 줄은 토큰 없음");
        assert!(spans[2].tok_to > spans[2].tok_from, "한국어 줄은 토큰 소비");
        // 줄 순서대로 토큰 구간이 증가해야 한다.
        assert!(spans[2].tok_from >= spans[0].tok_to);
    }

    #[test]
    fn vad_phrase_anchors_use_only_long_silent_gaps() {
        let spans = vec![
            LineTokenSpan { tok_from: 0, tok_to: 3 },
            LineTokenSpan { tok_from: 3, tok_to: 6 },
        ];
        let times = vec![(0, 200), (800, 1000)];
        let mut activity = vec![0.8f32; 60];
        for frame in 10..40 { activity[frame] = 0.0; }

        let anchors = detect_vad_phrase_anchors(&spans, &times, &activity, 20.0);
        assert_eq!(anchors, vec![(3, 25)], "300ms 이상의 무성 구간 중앙만 경계가 되어야 함");

        for frame in 10..40 { activity[frame] = 0.3; }
        assert!(detect_vad_phrase_anchors(&spans, &times, &activity, 20.0).is_empty());
    }

    #[test]
    fn phrase_anchor_merge_never_moves_manual_anchors() {
        let manual = vec![(2usize, 20usize), (8, 80)];
        let automatic = vec![(5usize, 50), (2, 10), (7, 90)];
        let merged = merge_phrase_anchors(&manual, &automatic);
        assert_eq!(merged, vec![(2, 20), (5, 50), (8, 80)]);
    }

    #[test]
    fn multi_evidence_confidence_penalizes_weak_margin_and_coverage() {
        let strong = multi_evidence_confidences(&[0.8], &[0.9], &[1.0], &[1.0])[0];
        let weak = multi_evidence_confidences(&[0.8], &[0.1], &[0.5], &[0.0])[0];
        assert!(strong > weak);
        assert!(strong <= 0.8 && weak > 0.0);
    }

    /// 앵커 재정렬이 "구간을 가두는" 핵심 동작을 하는지: 뒤쪽 구간을 다시
    /// 정렬해도 앵커가 잡아둔 시간 범위를 벗어나지 않아야 한다.
    #[test]
    fn anchor_refinement_keeps_tokens_inside_their_frame_window() {
        let vocab_path = write_test_vocab("anchor");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        let tokens = vec![
            *aligner.token_to_id.get("나").unwrap(),
            *aligner.token_to_id.get("는").unwrap(),
        ];
        // 40프레임 중 20~30 구간에서만 해당 토큰 확률이 높은 emission을 만든다.
        let vocab = 10;
        let mut e = Array2::<f32>::from_elem((40, vocab), -8.0);
        for f in 0..40 { e[[f, aligner.blank_id]] = -0.2; }
        for f in 20..25 { e[[f, tokens[0]]] = 5.0; }
        for f in 25..30 { e[[f, tokens[1]]] = 5.0; }

        // 구간 [20,30)으로 제한해 정렬하면 두 토큰이 그 안에만 배치돼야 한다.
        let sub = aligner.forced_align_range(&e, &tokens, 20, 30, -0.05, 0.0, 0.0);
        assert_eq!(sub.len(), 10, "반환 길이는 구간 길이와 같아야 함");
        let visited: Vec<usize> = sub.iter().copied().filter(|&t| t != usize::MAX).collect();
        assert!(!visited.is_empty(), "구간 안에서 토큰이 배치돼야 함");
        assert!(visited.iter().all(|&t| t < tokens.len()), "로컬 인덱스 범위 유지");

        // 전체 구간 정렬과 비교 — 구간 제한이 실제로 다른 결과를 만들 수 있어야
        // 의미가 있다(같은 함수로 전체를 돌린 것과 길이가 다름).
        let full = aligner.forced_align(&e, &tokens, -0.05, 0.0, 0.0);
        assert_eq!(full.len(), 40);
    }

    #[test]
    fn forced_align_rejects_infeasible_repeated_token_window() {
        let vocab_path = write_test_vocab("shortrepeat");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        let token = *aligner.token_to_id.get("나").unwrap();
        let emission = Array2::<f32>::from_elem((2, 10), -1.0);
        // CTC needs 나-blank-나: two frames cannot represent this target.
        let path = aligner.forced_align_range(
            &emission,
            &[token, token],
            0,
            2,
            -0.05,
            0.0,
            0.0,
        );
        assert_eq!(path, vec![usize::MAX; 2]);
    }

    #[test]
    fn forced_align_rejects_token_ids_outside_model_vocab() {
        let vocab_path = write_test_vocab("badvocab");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        let emission = Array2::<f32>::from_elem((4, 3), -1.0);
        let path = aligner.forced_align_range(
            &emission,
            &[99],
            0,
            4,
            -0.05,
            0.0,
            0.0,
        );
        assert_eq!(path, vec![usize::MAX; 4]);
    }

    #[test]
    fn segmented_anchor_confines_tokens_to_their_segment() {
        let vocab_path = write_test_vocab("seg");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        let tokens = vec![
            *aligner.token_to_id.get("나").unwrap(),
            *aligner.token_to_id.get("는").unwrap(),
        ];
        // 두 토큰 모두 어디서나 그럴듯한 emission — 오직 앵커만 위치를 가둔다.
        let vocab = 10;
        let mut e = Array2::<f32>::from_elem((40, vocab), -8.0);
        for f in 0..40 {
            e[[f, aligner.blank_id]] = -0.2;
            e[[f, tokens[0]]] = 1.0;
            e[[f, tokens[1]]] = 1.0;
        }

        // 앵커: 뒤 토큰(는, 글로벌 인덱스 1)이 프레임 20에서 시작.
        let path = segmented_align_with_anchors(&aligner, &e, &tokens, &[(1usize, 20usize)], -0.05, 0.0, 0.0);
        assert_eq!(path.len(), 40);
        for f in 0..20 {
            assert_ne!(path[f], 1, "앵커 이전 구간에 뒤 토큰이 새면 안 됨 (frame {})", f);
        }
        assert!((20..40).any(|f| path[f] == 1), "앵커 이후 구간에 뒤 토큰이 배치돼야 함");
    }

    #[test]
    fn resolve_anchor_points_drops_out_of_order_manual_sync() {
        // 3줄, 토큰 시작 0/4/8. 2번째 줄의 수동 싱크만 순서를 어겨(뒷줄이 앞 시각)
        // 있을 때, 정상 앵커 2개는 살고 모순된 하나만 버려져야 한다.
        let line_spans = vec![
            LineTokenSpan { tok_from: 0, tok_to: 3 },
            LineTokenSpan { tok_from: 4, tok_to: 7 },
            LineTokenSpan { tok_from: 8, tok_to: 11 },
        ];
        let orig_to_pos: HashMap<usize, usize> =
            [(0usize, 0usize), (1, 1), (2, 2)].into_iter().collect();

        // line0@1000ms(frame50), line1@200ms(frame10, 모순), line2@2000ms(frame100)
        let anchors = vec![(0usize, 1000i64), (1, 200), (2, 2000)];
        let pts = resolve_anchor_points(&anchors, &orig_to_pos, &line_spans, 20.0, 1000);

        // line1은 line0보다 이른 시각이라 폐기 → (tok0,frame50), (tok8,frame100)만.
        assert_eq!(pts, vec![(0usize, 50usize), (8usize, 100usize)]);
    }

    #[test]
    fn line_confidences_reflect_emission_strength() {
        // 토큰 2개짜리 두 줄. 첫 줄은 강한 emission, 둘째 줄은 약한 emission.
        let line_spans = vec![
            LineTokenSpan { tok_from: 0, tok_to: 2 },
            LineTokenSpan { tok_from: 2, tok_to: 4 },
            LineTokenSpan { tok_from: 4, tok_to: 4 }, // 토큰 없는 줄(타 언어) → 0
        ];
        let target_tokens = vec![1usize, 2, 3, 4];
        let vocab = 6;
        let mut e = Array2::<f32>::from_elem((4, vocab), -8.0);
        // 프레임0,1 → 첫 줄 토큰(로그확률 ≈ ln(0.9)= -0.105): 확신도 높음
        e[[0, 1]] = (0.9f32).ln();
        e[[1, 2]] = (0.9f32).ln();
        // 프레임2,3 → 둘째 줄 토큰(로그확률 = ln(0.1)= -2.30): 확신도 낮음
        e[[2, 3]] = (0.1f32).ln();
        e[[3, 4]] = (0.1f32).ln();
        let path = vec![0usize, 1, 2, 3]; // 전역 토큰 인덱스

        let conf = line_confidences(&e, &target_tokens, &line_spans, &path);
        assert_eq!(conf.len(), 3);
        assert!((conf[0] - 0.9).abs() < 0.05, "강한 줄 확신도 ≈ 0.9: {}", conf[0]);
        assert!((conf[1] - 0.1).abs() < 0.05, "약한 줄 확신도 ≈ 0.1: {}", conf[1]);
        assert_eq!(conf[2], 0.0, "토큰 없는 줄은 0");
        assert!(conf[0] > conf[1], "강한 줄이 약한 줄보다 확신도 높아야");
    }

    #[test]
    fn token_coverage_rejects_tokens_not_visited_by_the_path() {
        let spans = vec![
            LineTokenSpan { tok_from: 0, tok_to: 3 },
            LineTokenSpan { tok_from: 3, tok_to: 5 },
        ];
        // 첫 줄은 0, 2만 방문하고 1은 놓침; 둘째 줄은 모두 방문.
        let coverage = line_token_coverages(&spans, &[0, 2, 3, 4, usize::MAX]);
        assert!((coverage[0] - (2.0 / 3.0)).abs() < f32::EPSILON);
        assert_eq!(coverage[1], 1.0);
    }

    /// 다른 언어 줄이 낀 혼합 곡에서, 그 구간을 CTC blank가 흡수해 자기 언어
    /// 줄의 타이밍이 정확히 유지되는지. (UNK 토큰으로 채우면 UNK는 음향적 근거가
    /// 없어 프레임을 임의로 빨아들여 한 줄이 수십 초로 늘어난다 — 그 회귀 방지.)
    #[test]
    fn foreign_section_is_absorbed_by_blank_not_stretched() {
        let vocab_path = write_test_vocab("mixed");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&vocab_path).ok();

        // "나는" / "It's over tonight"(영어 줄 전체) / "가수다"
        let text = "나는\nIt's over tonight\n가수다";
        let (tokens, spans) = aligner.tokenize(text);

        // 영어 줄 단어들은 정렬 대상 토큰을 소비하지 않아야 한다(0폭).
        // 그래야 그 구간을 blank가 흡수한다.
        let en: Vec<_> = spans.iter().filter(|s| s.2.chars().all(|c| !Aligner::is_hangul_char(c))).collect();
        assert!(!en.is_empty(), "영어 단어 span이 있어야 함");
        for s in &en {
            assert_eq!(s.0, s.1, "영어 줄 단어 '{}'는 0폭이어야 함(blank가 흡수)", s.2);
        }
        // UNK가 타깃 시퀀스에 섞이면 안 된다.
        assert!(
            !tokens.contains(&aligner.unk_id),
            "낯선 줄을 UNK로 채우면 프레임을 임의 흡수해 블럭이 수십 초로 늘어난다"
        );

        // 40프레임(=0.8초/프레임 20ms) 중 앞 8프레임 "나는", 가운데 24프레임은
        // 영어 구간(blank), 마지막 8프레임 "가수다"인 경로를 만든다.
        let ko: Vec<_> = spans.iter().filter(|s| s.0 != s.1).collect();
        assert_eq!(ko.len(), 2, "한국어 단어 2개");
        let mut path = Vec::new();
        for _ in 0..8 { path.push(ko[0].0); }            // 나는
        for _ in 0..24 { path.push(usize::MAX); }        // 영어 구간 = blank
        for _ in 0..8 { path.push(ko[1].0); }            // 가수다

        let ts = aligner.get_word_timestamps(&path, &spans, 20.0);
        let first = ts.iter().find(|t| t.word == "나는").unwrap();
        let last = ts.iter().find(|t| t.word == "가수다").unwrap();

        // 한국어 줄이 영어 구간에 끌려가 늘어나지 않아야 한다.
        let first_dur = first.end_ms - first.start_ms;
        assert!(
            first_dur <= 200,
            "'나는'이 영어 구간까지 삼켜 늘어남: {}ms",
            first_dur
        );
        // 마지막 줄은 영어 구간 뒤(≥ 640ms)에서 시작 — 밀리지 않고 제자리.
        assert!(
            last.start_ms >= 600,
            "'가수다'가 영어 구간 앞으로 당겨짐: {}ms",
            last.start_ms
        );
    }
}

#[command]
pub async fn save_lrc_file(handle: AppHandle, audio_path: String, content: String) -> Result<String, String> {
    sys_log(&format!(
        "[Alignment] save_lrc_file requested. is_url={}, path={}, content_len={}",
        audio_path.starts_with("http"),
        audio_path,
        content.len()
    ));
    let lrc_path = if audio_path.starts_with("http") {
        let paths = crate::state::AppPaths::from_handle(&handle);
        write_lrc_to_url_cache(&paths, &audio_path, &content)?
    } else {
        let audio_file = PathBuf::from(&audio_path);
        if !audio_file.exists() {
            return Err(format!("원본 오디오 파일을 찾을 수 없습니다: {}", audio_path));
        }
        if !audio_file.is_file() {
            return Err(format!("오디오 경로가 파일이 아닙니다: {}", audio_path));
        }
        let lrc_path = audio_file.with_extension("lrc");
        fs::write(&lrc_path, content).map_err(|e| format!("LRC 저장 실패: {}", e))?;
        lrc_path
    };

    let saved_path = lrc_path.to_string_lossy().to_string();
    sys_log(&format!("[Alignment] LRC saved to {}", saved_path));
    Ok(saved_path)
}

/// Writes LRC content to the URL-keyed cache dir (`<separated>/<urlencoded url>/lyric.lrc`)
/// and mirrors it to all `youtube_url_variants()` cache-key forms, so future
/// lookups find it regardless of which URL form was used to reference the
/// track. Returns the primary path written.
fn write_lrc_to_url_cache(paths: &crate::state::AppPaths, url: &str, content: &str) -> Result<PathBuf, String> {
    let cache_key = urlencoding::encode(url).to_string();
    let base_dir = paths.separated.join(&cache_key);
    sys_log(&format!(
        "[Alignment] Saving URL LRC to cache. key={}, dir={}",
        cache_key,
        base_dir.to_string_lossy()
    ));
    if !base_dir.exists() {
        fs::create_dir_all(&base_dir).map_err(|e| format!("LRC 저장 폴더 생성 실패: {}", e))?;
    }
    let primary = base_dir.join("lyric.lrc");
    fs::write(&primary, content).map_err(|e| format!("LRC 저장 실패: {}", e))?;

    // Mirror save to common URL variants so future loads find legacy/alternate forms too.
    for variant in youtube_url_variants(url) {
        let mirror_key = urlencoding::encode(&variant).to_string();
        let mirror_dir = paths.separated.join(&mirror_key);
        if mirror_dir != base_dir {
            if !mirror_dir.exists() {
                if let Err(e) = fs::create_dir_all(&mirror_dir) {
                    sys_log(&format!(
                        "[Alignment] Mirror dir create failed. key={}, dir={}, err={}",
                        mirror_key,
                        mirror_dir.to_string_lossy(),
                        e
                    ));
                }
            }
            if let Err(e) = fs::write(mirror_dir.join("lyric.lrc"), content) {
                sys_log(&format!(
                    "[Alignment] Mirror LRC write failed. key={}, dir={}, err={}",
                    mirror_key,
                    mirror_dir.to_string_lossy(),
                    e
                ));
            } else {
                sys_log(&format!(
                    "[Alignment] Mirror LRC write ok. key={}, dir={}",
                    mirror_key,
                    mirror_dir.to_string_lossy()
                ));
            }
        }
    }
    Ok(primary)
}

/// Returns true if an LRC already exists for this URL under any of the same
/// search paths `load_lrc_file` checks (URL branch only).
fn url_lrc_exists(paths: &crate::state::AppPaths, url: &str) -> bool {
    for key_src in youtube_url_variants(url) {
        let cache_key = urlencoding::encode(&key_src).to_string();
        let cache_dir = paths.separated.join(&cache_key);
        if cache_dir.join("lyric.lrc").is_file() || cache_dir.join("vocal.lrc").is_file() {
            return true;
        }
    }
    false
}

/// Seeds a local `.lrc` from raw lyric text (e.g. pulled from Meloming) when no
/// LRC exists yet for this URL. Each non-blank input line becomes an
/// unsynced placeholder line (`start: 0`), matching the shape `parseLrc`
/// already treats as "text without a timestamp". Never overwrites existing
/// sync data — a no-op if any LRC is already found for this URL.
pub fn seed_lrc_if_missing(paths: &crate::state::AppPaths, url: &str, lyrics_text: &str) -> Result<(), String> {
    if url_lrc_exists(paths, url) {
        return Ok(());
    }
    let content: String = lyrics_text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| format!("[00:00.00]{}", l))
        .collect::<Vec<_>>()
        .join("\n");
    if content.is_empty() {
        return Ok(());
    }
    write_lrc_to_url_cache(paths, url, &content)?;
    sys_log(&format!("[Alignment] Seeded LRC from Meloming lyrics_text for url={}", url));
    Ok(())
}

/// Builds the ordered list of candidate LRC file paths for an audio path
/// (URL cache variants for http:// sources, sibling/cache/legacy paths for
/// local files). Shared by `load_lrc_file` and `read_lrc_content` so the
/// resolution scheme stays in one place.
fn lrc_search_paths(paths: &crate::state::AppPaths, audio_path: &str) -> Vec<PathBuf> {
    let mut search_paths = Vec::new();
    if audio_path.starts_with("http") {
        for key_src in youtube_url_variants(audio_path) {
            let cache_key = urlencoding::encode(&key_src).to_string();
            let cache_dir = paths.separated.join(&cache_key);
            search_paths.push(cache_dir.join("lyric.lrc"));
            search_paths.push(cache_dir.join("vocal.lrc"));
        }
    } else {
        let original_file = PathBuf::from(audio_path);
        search_paths.push(original_file.with_extension("lrc"));

        let cache_key = urlencoding::encode(audio_path).to_string();
        let cache_dir = paths.separated.join(&cache_key);
        search_paths.push(cache_dir.join("lyric.lrc"));
        search_paths.push(cache_dir.join("vocal.lrc"));

        let normalized = normalize_path_key(audio_path);
        if normalized != audio_path {
            let norm_key = urlencoding::encode(&normalized).to_string();
            let norm_cache_dir = paths.separated.join(&norm_key);
            search_paths.push(norm_cache_dir.join("lyric.lrc"));
            search_paths.push(norm_cache_dir.join("vocal.lrc"));
        }

        if let Some(parent) = original_file.parent() {
            search_paths.push(parent.join("lyric.lrc"));
            search_paths.push(parent.join("vocal.lrc"));
        }
    }
    search_paths
}

/// Reads an audio path's LRC content if any candidate file exists. Synchronous
/// and lightweight — used both by `load_lrc_file` and the library's per-song
/// sync-status classification.
pub fn read_lrc_content(paths: &crate::state::AppPaths, audio_path: &str) -> Option<String> {
    for p in lrc_search_paths(paths, audio_path) {
        if p.is_file() {
            if let Ok(content) = fs::read_to_string(&p) {
                return Some(content);
            }
        }
    }
    None
}

/// Classifies an LRC's sync state: `"synced"` if any line carries a real
/// (non-zero) `[mm:ss.xx]` timestamp, else `"unsynced"` (lyrics present but
/// all lines sit at 00:00.00, e.g. a Meloming seed or pasted-but-untimed
/// lyrics). Callers treat missing/blank content as `"none"`.
pub fn lrc_sync_status(content: &str) -> &'static str {
    let re = regex::Regex::new(r"\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]").unwrap();
    for cap in re.captures_iter(content) {
        let min: f64 = cap[1].parse().unwrap_or(0.0);
        let sec: f64 = cap[2].parse().unwrap_or(0.0);
        if min * 60.0 + sec > 0.0 {
            return "synced"; // 첫 non-zero 타임스탬프에서 조기 종료
        }
    }
    "unsynced"
}

#[command]
pub async fn load_lrc_file(handle: AppHandle, audio_path: String) -> Result<String, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    sys_log(&format!(
        "[Alignment] load_lrc_file requested. is_url={}, path={}",
        audio_path.starts_with("http"),
        audio_path
    ));

    for p in lrc_search_paths(&paths, &audio_path) {
        if p.exists() && p.is_file() {
            sys_log(&format!("[Alignment] Found LRC file at: {:?}", p));
            return fs::read_to_string(&p).map_err(|e| format!("LRC 읽기 실패: {}", e));
        }
    }

    let tried = if audio_path.starts_with("http") {
        youtube_url_variants(&audio_path)
            .into_iter()
            .map(|v| {
                let k = urlencoding::encode(&v).to_string();
                format!("{} => {}", v, k)
            })
            .collect::<Vec<_>>()
            .join(" | ")
    } else {
        "(local path)".to_string()
    };
    sys_log(&format!(
        "[Alignment] LRC file not found. tried_keys={}, cache_root={}",
        tried,
        paths.separated.to_string_lossy()
    ));
    Err("LRC file not found".to_string())
}
