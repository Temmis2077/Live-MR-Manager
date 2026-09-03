use std::collections::{VecDeque, HashSet, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::path::PathBuf;

use rodio::{Source, Player, MixerDeviceSink, DeviceSinkBuilder};
use crate::types::AppState;
use parking_lot::Mutex;
use once_cell::sync::Lazy;
use tauri::Emitter;
use cpal::traits::{HostTrait, DeviceTrait};

pub static ACTIVE_DOWNLOADS: Lazy<Mutex<HashSet<PathBuf>>> = Lazy::new(|| Mutex::new(HashSet::new()));
pub static DOWNLOAD_FINISHED_NOTIFIER: Lazy<Mutex<HashMap<PathBuf, Arc<tokio::sync::Notify>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub static DOWNLOAD_ERRORS: Lazy<Mutex<HashMap<PathBuf, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub static CANCEL_REQUESTS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
pub static IS_PREPARING_PLAYBACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn append_sys_log_file(message: &str) {
    let log_path = {
        if let Some(paths) = crate::state::APP_PATHS.lock().as_ref() {
            paths.root.join("logs").join("app.log")
        } else {
            let base = std::env::temp_dir().join("osw");
            base.join("logs").join("app.log")
        }
    };

    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(f, "[{}] {}", ts, message);
    }
}

pub fn sys_log(message: &str) {
    println!("{}", message);
    append_sys_log_file(message);
    if let Some(guard) = crate::state::MAIN_WINDOW.try_lock() {
        if let Some(window) = guard.as_ref() {
            let _ = window.emit("sys-log", message.to_string());
        }
    }
}

// --- Status types are now in types.rs ---

// --- Streaming Support ---

pub struct StreamingReader {
    pub file: File,
    pub is_youtube: bool,
    pub path: PathBuf,
}

impl StreamingReader {
    pub fn new(path: PathBuf, is_youtube: bool) -> std::io::Result<Self> {
        let file = File::open(&path)?;
        Ok(Self { file, is_youtube, path })
    }
}

impl Read for StreamingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let n = self.file.read(buf)?;
            if n > 0 {
                // println!("[AUDIO_DEBUG] StreamingReader read {} bytes", n);
                return Ok(n);
            } else if self.is_youtube {
                // Check if still downloading
                let still_downloading = {
                    let downloads = ACTIVE_DOWNLOADS.lock();
                    downloads.contains(&self.path)
                };
                
                if still_downloading {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    continue;
                } else {
                    // Download finished and no more data
                    return Ok(0);
                }
            } else {
                return Ok(0);
            }
        }
    }
}

impl Seek for StreamingReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}

// --- Custom Audio Sources ---

/// Dynamic volume control source using atomic bits for f32 volume.
pub struct DynamicVolumeSource<S> where S: Source<Item = f32> {
    pub input: S,
    pub volume: Arc<AtomicU32>, // Shared target volume (bits of f32)
    pub current_vol: f32,       // Internal state for fading
}

impl<S> DynamicVolumeSource<S> where S: Source<Item = f32> {
    pub fn new(input: S, volume: Arc<AtomicU32>) -> Self {
        Self {
            input,
            volume,
            current_vol: 0.0,
        }
    }
}

impl<S> Iterator for DynamicVolumeSource<S> where S: Source<Item = f32> {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        let s = self.input.next()?;
        let target_vol_bits = self.volume.load(Ordering::Relaxed);
        let target_vol = f32::from_bits(target_vol_bits) / 125.0; // Linear scale for tracks to avoid nested quadratic drop
        
        // Smoothly interpolate current_vol towards target_vol

        // Smoothly interpolate current_vol towards target_vol
        // Fade duration: 100ms
        const FADE_DURATION: f32 = 0.1; 
        let sample_rate = self.input.sample_rate().get() as f32;
        let step = 1.0 / (sample_rate * FADE_DURATION);

        if (self.current_vol - target_vol).abs() > step {
            if self.current_vol < target_vol {
                self.current_vol += step;
            } else {
                self.current_vol -= step;
            }
        } else {
            self.current_vol = target_vol;
        }
        
        Some(s * self.current_vol)
    }
}

impl<S> Source for DynamicVolumeSource<S> where S: Source<Item = f32> {
    fn current_span_len(&self) -> Option<usize> { self.input.current_span_len() }
    fn channels(&self) -> NonZeroU16 { self.input.channels() }
    fn sample_rate(&self) -> NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)
    }
}

/// 임계값 이하는 그대로 통과, 이상은 부드럽게 포화시켜 |출력|이 1.0을 넘지
/// 않게 한다(무상태·룩어헤드 없음 → RT-safe). 여러 소스를 합산할 때 생기는
/// 클리핑(디지털 오버플로 왜곡)을 막는 안전 리미터.
pub fn soft_clip(x: f32, threshold: f32) -> f32 {
    let a = x.abs();
    if a <= threshold {
        x
    } else {
        let over = (a - threshold) / (1.0 - threshold);
        x.signum() * (threshold + (1.0 - threshold) * over.tanh())
    }
}

/// 버스 출력 끝단 소프트 리미터. `enabled`(0/1 atomic)로 켜고 끌 수 있다.
pub struct SoftClipSource<S> where S: Source<Item = f32> {
    pub input: S,
    pub threshold: f32,
    pub enabled: Arc<AtomicU32>, // 1 = on, 0 = bypass
}

impl<S> SoftClipSource<S> where S: Source<Item = f32> {
    pub fn new(input: S, threshold: f32, enabled: Arc<AtomicU32>) -> Self {
        Self { input, threshold, enabled }
    }
}

impl<S> Iterator for SoftClipSource<S> where S: Source<Item = f32> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let s = self.input.next()?;
        if self.enabled.load(Ordering::Relaxed) == 0 {
            Some(s)
        } else {
            Some(soft_clip(s, self.threshold))
        }
    }
}

impl<S> Source for SoftClipSource<S> where S: Source<Item = f32> {
    fn current_span_len(&self) -> Option<usize> { self.input.current_span_len() }
    fn channels(&self) -> NonZeroU16 { self.input.channels() }
    fn sample_rate(&self) -> NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)
    }
}

/// 메트로놈 클릭 소스. 공유 atomic에서 BPM을 **매 박자 읽어** 클릭 간격을
/// 실시간 반영한다(재생 중 BPM을 바꿔도 다음 박자부터 즉시 적용, 위상 연속).
/// 4박마다 다운비트를 조금 높은 음으로 강조한다. 재생 위치(프레임)에서
/// 시작하도록 start_frame을 받는다. (무한 스트림이라 사용 측에서 take_duration으로
/// 곡 길이만큼 잘라 쓴다.)
pub struct MetronomeSource {
    sample_rate: u32,
    channels: u16,
    bpm_bits: Arc<AtomicU32>, // f32 bits, 0 이하면 120으로 처리
    click_len: u64,           // 프레임 단위
    frame_in_beat: u64,       // 현재 박자 시작 이후 프레임 수
    samples_per_beat: u64,    // 현재 박자 길이(박자 시작 시 BPM으로 확정)
    beat_index: u64,          // 다운비트 강조용
    ch_i: u16,
}

impl MetronomeSource {
    fn resolve_bpm(bits: &Arc<AtomicU32>) -> f32 {
        let b = f32::from_bits(bits.load(Ordering::Relaxed));
        if b <= 0.0 { 120.0 } else { b }
    }

    fn spb_for(bpm: f32, sample_rate: u32) -> u64 {
        (((60.0 / bpm) * sample_rate as f32) as u64).max(1)
    }

    pub fn new(bpm_bits: Arc<AtomicU32>, sample_rate: u32, channels: u16, start_frame: u64) -> Self {
        // 시작 위치를 현재 BPM 기준 박자 위상으로 환산.
        let bpm0 = Self::resolve_bpm(&bpm_bits);
        let spb0 = Self::spb_for(bpm0, sample_rate);
        Self {
            sample_rate,
            channels: channels.max(1),
            bpm_bits,
            click_len: ((sample_rate as f32) * 0.03) as u64, // 30ms
            frame_in_beat: start_frame % spb0,
            samples_per_beat: spb0,
            beat_index: start_frame / spb0,
            ch_i: 0,
        }
    }
}

impl Iterator for MetronomeSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = if self.frame_in_beat < self.click_len {
            let t = self.frame_in_beat as f32 / self.sample_rate as f32;
            // 선형 감쇠 엔벨로프.
            let env = 1.0 - (self.frame_in_beat as f32 / self.click_len as f32);
            // 4박마다 다운비트 강조(높은 음).
            let freq = if self.beat_index % 4 == 0 { 1500.0 } else { 1000.0 };
            (2.0 * std::f32::consts::PI * freq * t).sin() * env * 0.4
        } else {
            0.0
        };
        // 모든 채널에 동일 값. 채널 인덱스가 한 바퀴 돌면 프레임 전진.
        self.ch_i += 1;
        if self.ch_i >= self.channels {
            self.ch_i = 0;
            self.frame_in_beat += 1;
            // 박자 경계 도달 시 다음 박자 길이를 현재 BPM으로 다시 확정(실시간 반영).
            if self.frame_in_beat >= self.samples_per_beat {
                self.frame_in_beat = 0;
                self.beat_index = self.beat_index.wrapping_add(1);
                let bpm = Self::resolve_bpm(&self.bpm_bits);
                self.samples_per_beat = Self::spb_for(bpm, self.sample_rate);
            }
        }
        Some(sample)
    }
}

impl Source for MetronomeSource {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> NonZeroU16 { NonZeroU16::new(self.channels).unwrap_or(NonZeroU16::new(2).unwrap()) }
    fn sample_rate(&self) -> NonZeroU32 { NonZeroU32::new(self.sample_rate).unwrap_or(NonZeroU32::new(44100).unwrap()) }
    fn total_duration(&self) -> Option<Duration> { None }
    fn try_seek(&mut self, _pos: Duration) -> Result<(), rodio::source::SeekError> { Ok(()) }
}

/// Source for real-time pitch and tempo shifting.
pub struct StretchedSource<S> where S: Source<Item = f32> {
    pub input: S,
    pub stretcher: signalsmith_stretch::Stretch,
    pub pitch: Arc<AtomicU32>,
    pub tempo: Arc<AtomicU32>,
    pub pos: Arc<AtomicU64>,
    pub buffer: VecDeque<f32>,
    pub input_channels: usize,
    pub remainder_frames: f32, // For precise tempo matching
    pub remainder_pos: f32,    // For precise progress reporting
    pub last_pitch: f32,       // For caching
    pub last_tempo: f32,       // For caching
    pub output_buffer: Vec<f32>, // Reusable buffer to avoid allocations
}

impl<S> StretchedSource<S> where S: Source<Item = f32> {
    pub fn new(input: S, pitch: Arc<AtomicU32>, tempo: Arc<AtomicU32>, pos: Arc<AtomicU64>) -> Self {
        let channels = input.channels().get() as u32;
        let rate = input.sample_rate().get();
        Self {
            input,
            stretcher: signalsmith_stretch::Stretch::preset_default(channels, rate),
            pitch,
            tempo,
            pos,
            buffer: VecDeque::new(),
            input_channels: channels as usize,
            remainder_frames: 0.0,
            remainder_pos: 0.0,
            last_pitch: 0.0,
            last_tempo: 1.0,
            output_buffer: Vec::with_capacity(2048 * channels as usize), // Pre-allocate enough space
        }
    }
}

impl<S> Iterator for StretchedSource<S> where S: Source<Item = f32> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let pitch_semitones = f32::from_bits(self.pitch.load(Ordering::Relaxed));
        let tempo_scale = f32::from_bits(self.tempo.load(Ordering::Relaxed)).max(0.1); // Prevent div by zero

        // 1. Pop from buffer if available
        if let Some(s) = self.buffer.pop_front() {
            // Track progress relative to the output samples
            // For every output sample, we've "traversed" tempo_scale worth of original samples
            if self.buffer.len() % self.input_channels == 0 {
                self.remainder_pos += tempo_scale;
                let whole_samples = self.remainder_pos.floor();
                if whole_samples >= 1.0 {
                    self.pos.fetch_add(whole_samples as u64, Ordering::Relaxed);
                    self.remainder_pos -= whole_samples;
                }
            }
            return Some(s);
        }

        // 2. Read input block
        let block_size = 1024;
        let mut input_interleaved: Vec<f32> = Vec::with_capacity(block_size * self.input_channels);
        for _ in 0..block_size {
            for _ in 0..self.input_channels {
                if let Some(s) = self.input.next() {
                    input_interleaved.push(s);
                }
            }
        }

        let frames_read = input_interleaved.len() / self.input_channels;
        if frames_read == 0 { return None; }

        // 3. Stretch or Bypass
        if pitch_semitones == 0.0 && (tempo_scale - 1.0).abs() < 0.001 {
            // Bypass mode
            for s in input_interleaved {
                self.buffer.push_back(s);
            }
            self.remainder_frames = 0.0; // Reset error
            self.last_pitch = 0.0;
            self.last_tempo = 1.0;
        } else {
            // Stretch mode
            // Only update pitch if it changed significantly
            if (pitch_semitones - self.last_pitch).abs() > 0.01 {
                let pitch_factor = 2.0f32.powf(pitch_semitones / 12.0);
                self.stretcher.set_transpose_factor(pitch_factor, None);
                self.last_pitch = pitch_semitones;
            }
            self.last_tempo = tempo_scale;
            
            // Calculate precise output frames with error diffusion
            let total_needed = (frames_read as f32 / tempo_scale) + self.remainder_frames;
            let output_frames = total_needed.floor() as usize;
            self.remainder_frames = total_needed - output_frames as f32;
            
            if output_frames > 0 {
                // Resize internal buffer if needed (usually stays constant)
                let needed_samples = output_frames * self.input_channels;
                if self.output_buffer.len() < needed_samples {
                    self.output_buffer.resize(needed_samples, 0.0);
                }
                
                // Use slice of internal buffer directly
                let target_slice = &mut self.output_buffer[0..needed_samples];
                self.stretcher.process(&input_interleaved, target_slice);
                
                // Re-borrow for the loop
                for &s in self.output_buffer[0..needed_samples].iter() {
                    self.buffer.push_back(s);
                }
            }
        }

        // 4. Return first sample from new buffer
        self.buffer.pop_front().map(|s| {
            if self.buffer.len() % self.input_channels == 0 {
                self.remainder_pos += tempo_scale;
                let whole_samples = self.remainder_pos.floor();
                if whole_samples >= 1.0 {
                    self.pos.fetch_add(whole_samples as u64, Ordering::Relaxed);
                    self.remainder_pos -= whole_samples;
                }
            }
            s
        })
    }
}

impl<S> Source for StretchedSource<S> where S: Source<Item = f32> {
    #[allow(deprecated)]
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> std::num::NonZeroU16 { std::num::NonZeroU16::new((self.input_channels as u16).max(1)).unwrap() }
    fn sample_rate(&self) -> std::num::NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)?;
        self.buffer.clear();
        self.stretcher.reset();
        self.remainder_frames = 0.0;
        self.remainder_pos = 0.0;
        Ok(())
    }
}

// --- PlaybackProgress and SeekToArgs are in types.rs or defined locally ---
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SeekToArgs {
    pub position_ms: u64,
}

// --- App Handler Struct ---

// --- AppState is in types.rs ---

/// 출력 버스의 역할. 정렬 기준·기본값·UI 분기에 쓰인다.
/// Monitor = 내가 듣는 저지연 경로, Capture = 방송/녹음으로 나가는 정렬 경로.
/// (미래: InputBus 등 형제 개념이 같은 지연 모델로 들어온다.)
#[derive(Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BusRole {
    Monitor,
    Capture,
}

/// 하나의 출력 버스 설정. 트랜스포트(sink/player)는 AudioHandler가 별도로 들고
/// 있고, 여기서는 **버스별 설정/상태**(장치·레이트·채널·지연 보정·추정 지연)만
/// 다룬다. 지연 보정과 미래 버스 확장이 이 타입을 중심으로 이뤄진다.
pub struct OutputBus {
    pub role: BusRole,
    /// 선택된 장치 이름(빈 문자열: Monitor=시스템 기본 / Capture=꺼짐).
    pub device_name: Mutex<String>,
    /// 현재 열린 장치의 실제 설정(리샘플 타깃).
    pub sample_rate: Arc<AtomicU32>,
    pub channels: Arc<AtomicU32>, // u16 값을 u32로 보관
    /// 사용자 지연 보정(ms, f32 bits, ≥0). 이 버스 믹스를 그만큼 늦춰 정렬.
    pub delay_ms: Arc<AtomicU32>,
    /// 장치 버퍼 기반 추정 지연(ms, f32 bits). 보정 시작값 안내용(읽기전용).
    pub est_latency_ms: Arc<AtomicU32>,
}

impl OutputBus {
    pub fn new(role: BusRole, rate: u32, channels: u32) -> Self {
        Self {
            role,
            device_name: Mutex::new(String::new()),
            sample_rate: Arc::new(AtomicU32::new(rate)),
            channels: Arc::new(AtomicU32::new(channels)),
            delay_ms: Arc::new(AtomicU32::new(0f32.to_bits())),
            est_latency_ms: Arc::new(AtomicU32::new(0f32.to_bits())),
        }
    }
    pub fn delay_ms_val(&self) -> f32 {
        f32::from_bits(self.delay_ms.load(Ordering::Relaxed)).max(0.0)
    }
    pub fn est_latency_val(&self) -> f32 {
        f32::from_bits(self.est_latency_ms.load(Ordering::Relaxed))
    }
}

pub struct AudioHandler {
    // 출력 장치는 런타임에 교체될 수 있으므로 sink와 player를 함께 잠그고 바꾼다.
    // (device 전환 시 새 sink에 새 player를 연결해 통째로 교체)
    pub _stream: Mutex<MixerDeviceSink>, // Keep alive (모니터 트랜스포트)
    pub controller: Mutex<Player>,       // 모니터 트랜스포트
    /// 모니터 버스 설정(항상 켜져 있는 주 출력).
    pub monitor: OutputBus,
    pub state: Mutex<AppState>,
    pub active_pitch: Arc<AtomicU32>,
    pub active_tempo: Arc<AtomicU32>,
    pub current_pos_samples: Arc<AtomicU64>,
    pub total_duration_ms: Arc<AtomicU64>,
    pub track_sample_rate: Arc<AtomicU32>,
    pub vocal_volume: Arc<AtomicU32>, // 모니터 채널 보컬 게인, f32 bits
    pub backing_volume: Arc<AtomicU32>, // 모니터 채널 화음/코러스 게인, f32 bits
    pub instrumental_volume: Arc<AtomicU32>, // 모니터 채널 인스트 게인, f32 bits
    pub mon_metro_volume: Arc<AtomicU32>, // 모니터 채널 메트로놈 게인
    pub mr_vocal_volume: Arc<AtomicU32>,  // MR 채널 보컬 게인
    pub mr_backing_volume: Arc<AtomicU32>, // MR 채널 화음/코러스 게인
    pub mr_inst_volume: Arc<AtomicU32>,   // MR 채널 인스트 게인
    pub mr_metro_volume: Arc<AtomicU32>,  // MR 채널 메트로놈 게인
    pub backing_available: Arc<AtomicU32>, // 현재 곡의 별도 화음 stem 존재 여부
    /// 메트로놈 BPM(f32 bits). 재생 중 변경을 클릭에 실시간 반영하기 위해 공유.
    /// 0 이하면 소스가 120으로 처리.
    pub metro_bpm: Arc<AtomicU32>,
    /// 출력 소프트 리미터 on/off (1/0). 기본 켜짐(합산 클리핑 방지). 재생 중 즉시 반영.
    pub limiter_enabled: Arc<AtomicU32>,
    /// 마스터 게인(Player.set_volume에 넣는 최종값, f32 bits). 장치 전환 시 새
    /// player에 다시 적용하기 위해 보관한다(마스터 볼륨은 player에만 있으므로).
    pub master_gain: Arc<AtomicU32>,
    // MR(캡처) 채널 트랜스포트(2번째 출력, 선택). 버스 설정은 `mr`에.
    pub mr_stream: Mutex<Option<MixerDeviceSink>>,
    pub mr_controller: Mutex<Option<Player>>,
    /// MR(캡처) 버스 설정. device_name이 비면 채널 꺼짐(모니터만 재생).
    pub mr: OutputBus,
    pub playback_cv: parking_lot::Condvar,
}

/// 지정한 이름의 출력 장치를 열어 (sink, sample_rate, channels, 실제 장치 이름,
/// 추정 지연 ms)을 돌려준다. None이거나 매칭 실패면 시스템 기본 장치로 폴백한다.
pub fn open_output_sink(
    device_name: Option<&str>,
) -> Result<(MixerDeviceSink, u32, u16, String, f32), String> {
    let host = cpal::default_host();

    // 요청한 이름과 일치하는 장치를 먼저 찾는다.
    let picked: Option<cpal::Device> = device_name.filter(|s| !s.is_empty()).and_then(|want| {
        host.output_devices().ok().and_then(|devs| {
            devs.into_iter()
                .find(|d| d.description().map(|desc| desc.name() == want).unwrap_or(false))
        })
    });

    let (stream, resolved) = if let Some(dev) = picked {
        let name = dev
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "Unknown Device".into());
        let s = DeviceSinkBuilder::from_device(dev)
            .map_err(|e| e.to_string())?
            .open_stream()
            .map_err(|e| e.to_string())?;
        (s, name)
    } else {
        // 기본 장치. (요청 이름이 없거나 그 장치가 사라진 경우)
        let s = DeviceSinkBuilder::open_default_sink().map_err(|e| e.to_string())?;
        let name = host
            .default_output_device()
            .and_then(|d| d.description().ok().map(|x| x.name().to_string()))
            .unwrap_or_else(|| "기본 장치".into());
        (s, name)
    };

    let cfg = stream.config();
    let rate = u32::from(cfg.sample_rate()).max(1);
    let channels = u16::from(cfg.channel_count()).max(1);
    let est_latency_ms = estimate_latency_ms(cfg.buffer_size(), rate);
    Ok((stream, rate, channels, resolved, est_latency_ms))
}

/// 장치 버퍼 크기로 출력 지연을 대략 추정한다(보정 시작값 안내용).
/// 고정 버퍼면 buffer/rate, 아니면 rodio 빌더가 목표로 하는 ~50ms를 쓴다.
/// 드라이버 지연은 알 수 없으므로 어디까지나 baseline이다.
fn estimate_latency_ms(buffer: &cpal::BufferSize, rate: u32) -> f32 {
    match buffer {
        cpal::BufferSize::Fixed(frames) => (*frames as f32) / (rate as f32) * 1000.0,
        cpal::BufferSize::Default => 50.0,
    }
}

/// Settings DB에 저장된 출력 장치 이름(없으면 None → 기본 장치).
fn saved_output_device() -> Option<String> {
    saved_setting("output_device")
}

fn saved_setting(key: &str) -> Option<String> {
    let db = crate::state::DB.lock();
    db.query_row(
        "SELECT value FROM Settings WHERE key = ?",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.is_empty())
}

pub static AUDIO_HANDLER: Lazy<Result<Arc<AudioHandler>, String>> = Lazy::new(|| {
    // 저장된 장치를 우선 열되, 실패하면 기본 장치로 폴백.
    let saved = saved_output_device();
    let (stream, mut device_rate, mut device_channels, device_name, mon_est) =
        match open_output_sink(saved.as_deref()) {
            Ok(v) => v,
            Err(e) => match open_output_sink(None) {
                Ok(v) => v,
                Err(_) => return Err(format!("오디오 출력을 열지 못했습니다: {}", e)),
            },
        };

    if device_rate == 0 { device_rate = 44100; }
    if device_channels == 0 { device_channels = 2; }

    sys_log(&format!("[AUDIO] Device Initialized: {} ({}Hz, {}ch, ~{:.0}ms)", device_name, device_rate, device_channels, mon_est));

    let player = Player::connect_new(&stream.mixer());

    let monitor = OutputBus::new(BusRole::Monitor, device_rate, device_channels as u32);
    *monitor.device_name.lock() = device_name;
    monitor.est_latency_ms.store(mon_est.to_bits(), Ordering::Relaxed);
    if let Some(d) = saved_setting("output_delay_ms").and_then(|s| s.parse::<f32>().ok()) {
        monitor.delay_ms.store(d.max(0.0).to_bits(), Ordering::Relaxed);
    }

    let mr = OutputBus::new(BusRole::Capture, device_rate, device_channels as u32);
    if let Some(d) = saved_setting("mr_delay_ms").and_then(|s| s.parse::<f32>().ok()) {
        mr.delay_ms.store(d.max(0.0).to_bits(), Ordering::Relaxed);
    }

    // MR 채널(2번째 출력) 복원 — 저장된 장치가 있으면 best-effort로 연다.
    let (mr_stream_opt, mr_player_opt) =
        match saved_setting("mr_output_device").and_then(|n| open_output_sink(Some(&n)).ok()) {
            Some((s, r, c, name, est)) => {
                let p = Player::connect_new(&s.mixer());
                sys_log(&format!("[AUDIO] MR channel restored: {} ({}Hz, {}ch, ~{:.0}ms)", name, r, c, est));
                mr.sample_rate.store(r, Ordering::Relaxed);
                mr.channels.store(c as u32, Ordering::Relaxed);
                mr.est_latency_ms.store(est.to_bits(), Ordering::Relaxed);
                *mr.device_name.lock() = name;
                (Some(s), Some(p))
            }
            None => (None, None),
        };

    Ok(Arc::new(AudioHandler {
        _stream: Mutex::new(stream),
        controller: Mutex::new(player),
        monitor,
        state: Mutex::new(AppState::default()),
        active_pitch: Arc::new(AtomicU32::new(0f32.to_bits())),
        active_tempo: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        current_pos_samples: Arc::new(AtomicU64::new(0)),
        total_duration_ms: Arc::new(AtomicU64::new(0)),
        track_sample_rate: Arc::new(AtomicU32::new(device_rate)),
        vocal_volume: Arc::new(AtomicU32::new(100.0f32.to_bits())),
        backing_volume: Arc::new(AtomicU32::new(100.0f32.to_bits())),
        instrumental_volume: Arc::new(AtomicU32::new(100.0f32.to_bits())),
        mon_metro_volume: Arc::new(AtomicU32::new(0.0f32.to_bits())),
        mr_vocal_volume: Arc::new(AtomicU32::new(0.0f32.to_bits())),
        mr_backing_volume: Arc::new(AtomicU32::new(100.0f32.to_bits())),
        mr_inst_volume: Arc::new(AtomicU32::new(0.0f32.to_bits())),
        mr_metro_volume: Arc::new(AtomicU32::new(0.0f32.to_bits())),
        backing_available: Arc::new(AtomicU32::new(0)),
        metro_bpm: Arc::new(AtomicU32::new(0.0f32.to_bits())),
        limiter_enabled: Arc::new(AtomicU32::new(1)), // 기본 켜짐
        master_gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        mr_stream: Mutex::new(mr_stream_opt),
        mr_controller: Mutex::new(mr_player_opt),
        mr,
        playback_cv: parking_lot::Condvar::new(),
    }))
});

#[cfg(test)]
mod metro_tests {
    use super::*;

    #[test]
    fn soft_clip_transparent_below_and_bounded_above() {
        // 임계값 이하는 그대로.
        assert!((soft_clip(0.5, 0.8) - 0.5).abs() < 1e-6);
        assert!((soft_clip(-0.5, 0.8) + 0.5).abs() < 1e-6);
        assert!((soft_clip(0.8, 0.8) - 0.8).abs() < 1e-6);
        // 임계값 이상은 1.0을 절대 넘지 않음(양·음 모두).
        for x in [0.9f32, 1.0, 1.5, 3.0, 100.0] {
            let y = soft_clip(x, 0.8);
            assert!(y <= 1.0 && y > 0.8, "x={x} → y={y} (0.8<y<=1.0)");
            assert!((soft_clip(-x, 0.8) + y).abs() < 1e-6, "대칭성");
        }
    }

    #[test]
    fn spb_and_resolve_math() {
        assert_eq!(MetronomeSource::spb_for(120.0, 44100), 22050);
        assert_eq!(MetronomeSource::spb_for(240.0, 44100), 11025);
        let z = Arc::new(AtomicU32::new(0f32.to_bits()));
        assert_eq!(MetronomeSource::resolve_bpm(&z), 120.0, "0이면 120으로 처리");
    }

    // 재생 중 BPM 변경이 클릭 간격에 실시간 반영되는지: 120→240으로 바꾸면
    // 같은 시간에 박자가 약 2배로 진행돼야 한다.
    #[test]
    fn bpm_change_applies_live() {
        let bpm = Arc::new(AtomicU32::new(120f32.to_bits()));
        let mut m = MetronomeSource::new(bpm.clone(), 44100, 1, 0);
        for _ in 0..44100 { m.next(); } // 1초 @120 → 2박
        let beats_120 = m.beat_index;
        bpm.store(240f32.to_bits(), Ordering::Relaxed);
        for _ in 0..44100 { m.next(); } // 1초 @240 → 약 4박
        let added = m.beat_index - beats_120;
        assert_eq!(beats_120, 2, "120 BPM 1초 = 2박");
        assert!(added >= 3, "240 BPM 1초 ≈ 4박(실시간 반영), got {}", added);
    }
}
