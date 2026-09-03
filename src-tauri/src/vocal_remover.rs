use std::path::{Path, PathBuf};
use std::time::Instant;
use std::sync::atomic::{AtomicBool, Ordering};
use ort::session::Session;
use ort::value::{Value, ValueType};
use ndarray::{self, Array4};
use std::sync::Arc;
use parking_lot::Mutex;
use once_cell::sync::Lazy;
use crate::audio_player::sys_log;
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider};
use ort::execution_providers::DirectMLExecutionProvider;
use ort::execution_providers::TensorRTExecutionProvider;
use rustfft::{FftPlanner, num_complex::Complex};
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};
use anyhow::{anyhow, Result};
const IDLE_PIPELINE_CAPACITY: usize = 4;
static RUNTIME_DIAGNOSTICS_LOGGED: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

fn pipeline_capacity(live_priority: bool) -> usize {
    if live_priority { 1 } else { IDLE_PIPELINE_CAPACITY }
}

fn trim_padding_in_place(channels: &mut [Vec<f32>], start: usize, end: usize) {
    for channel in channels {
        channel.truncate(end);
        channel.drain(..start);
    }
}

pub trait InferenceEngine: Send + Sync {
    fn separate(&self, audio_path: &Path, output_dir: &Path, cancel_flag: Arc<AtomicBool>, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf)>;
    fn validate_harmony_stems(&self, input: &Path, lead: &Path, backing: &Path) -> Result<(f32, f32, f32)>;
    fn get_provider(&self) -> String;
    fn get_model_name(&self) -> String;
}

#[cfg(test)]
mod harmony_tests {
    use super::{harmony_quality_metrics, pipeline_capacity, trim_padding_in_place};

    #[test]
    fn live_priority_keeps_only_one_pipeline_packet() {
        assert_eq!(pipeline_capacity(true), 1);
        assert_eq!(pipeline_capacity(false), 4);
    }

    #[test]
    fn padding_trim_reuses_channel_allocations() {
        let mut channels = vec![vec![0.0, 1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0, 7.0]];
        let capacities: Vec<_> = channels.iter().map(Vec::capacity).collect();
        trim_padding_in_place(&mut channels, 1, 3);
        assert_eq!(channels, vec![vec![1.0, 2.0], vec![5.0, 6.0]]);
        assert_eq!(channels.iter().map(Vec::capacity).collect::<Vec<_>>(), capacities);
    }

    #[test]
    fn accepts_reconstructable_lead_and_backing() {
        let input = vec![1.0, -1.0, 0.5, -0.5];
        let lead = vec![0.8, -0.8, 0.4, -0.4];
        let backing = vec![0.2, -0.2, 0.1, -0.1];
        let (_, backing_ratio, error) = harmony_quality_metrics(&input, &lead, &backing).unwrap();
        assert!(backing_ratio > 0.1);
        assert!(error < 1e-5);
    }

    #[test]
    fn rejects_silent_backing_and_bad_reconstruction() {
        let input = vec![1.0; 100];
        assert!(harmony_quality_metrics(&input, &vec![1.0; 100], &vec![0.0; 100]).is_err());
        assert!(harmony_quality_metrics(&input, &vec![0.1; 100], &vec![0.1; 100]).is_err());
    }

    #[test]
    fn rejects_the_observed_duplicated_harmony_shape() {
        let input = vec![1.0; 100];
        let lead = vec![1.0; 100];
        let backing = vec![1.0; 100];
        let error = harmony_quality_metrics(&input, &lead, &backing).unwrap_err().to_string();
        assert!(error.contains("duplicated"));
    }

    #[test]
    fn rejects_reconstruction_error_above_quarter_scale() {
        let input = vec![1.0; 100];
        let lead = vec![0.6; 100];
        let backing = vec![0.1; 100];
        assert!(harmony_quality_metrics(&input, &lead, &backing).is_err());
    }
}

fn harmony_quality_metrics(input: &[f32], lead: &[f32], backing: &[f32]) -> Result<(f32, f32, f32)> {
    let len = input.len().min(lead.len()).min(backing.len());
    if len == 0 { return Err(anyhow!("Harmony stems are empty")); }
    let mut input_sq = 0.0f64;
    let mut lead_sq = 0.0f64;
    let mut backing_sq = 0.0f64;
    let mut error_sq = 0.0f64;
    for i in 0..len {
        let x = input[i] as f64;
        let l = lead[i] as f64;
        let b = backing[i] as f64;
        input_sq += x * x;
        lead_sq += l * l;
        backing_sq += b * b;
        let e = x - l - b;
        error_sq += e * e;
    }
    let denom = input_sq.max(1e-12).sqrt();
    let metrics = (
        (lead_sq.sqrt() / denom) as f32,
        (backing_sq.sqrt() / denom) as f32,
        (error_sq.sqrt() / denom) as f32,
    );
    if !(0.02..=2.5).contains(&metrics.0) { return Err(anyhow!("Invalid lead energy ratio: {:.4}", metrics.0)); }
    if !(0.005..=2.0).contains(&metrics.1) { return Err(anyhow!("Invalid backing energy ratio: {:.4}", metrics.1)); }
    if metrics.0 >= 0.90 && metrics.1 >= 0.90 && metrics.2 > 0.15 {
        return Err(anyhow!(
            "Harmony outputs appear duplicated: lead_ratio={:.4}, backing_ratio={:.4}, reconstruction_error={:.4}",
            metrics.0, metrics.1, metrics.2
        ));
    }
    if metrics.2 > 0.25 {
        return Err(anyhow!(
            "Harmony reconstruction error too high: {:.4} (lead_ratio={:.4}, backing_ratio={:.4})",
            metrics.2, metrics.0, metrics.1
        ));
    }
    Ok(metrics)
}

#[derive(Clone)]
pub struct StftEngine {
    n_fft: usize,
    hop_length: usize,
    window: Vec<f32>,
    fft: Arc<dyn rustfft::Fft<f32>>,
    ifft: Arc<dyn rustfft::Fft<f32>>,
}

impl StftEngine {
    pub fn new(n_fft: usize, hop_length: usize) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(n_fft);
        let ifft = planner.plan_fft_inverse(n_fft);
        
        let window: Vec<f32> = (0..n_fft)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n_fft as f32).cos()))
            .collect();
            
        Self { n_fft, hop_length, window, fft, ifft }
    }

    pub fn stft_ndarray(&self, samples: &[f32], target_bins: usize) -> ndarray::Array2<Complex<f32>> {
        let num_samples = samples.len();
        let n_fft = self.n_fft;
        let num_frames = if num_samples < n_fft { 0 } else { (num_samples - n_fft) / self.hop_length + 1 };
        
        let mut stft_result = ndarray::Array2::from_elem((num_frames, target_bins), Complex::new(0.0f32, 0.0f32));
        let mut input = vec![Complex::new(0.0f32, 0.0f32); n_fft];

        let throttle = crate::separation::live_priority_active();
        for (f_idx, start) in (0..=num_samples.saturating_sub(n_fft)).step_by(self.hop_length).enumerate() {
            if throttle && (f_idx % 2 == 0) { 
                std::thread::sleep(std::time::Duration::from_millis(1)); 
            }
            if f_idx >= num_frames { break; }
            for i in 0..n_fft {
                input[i] = Complex::new(samples[start + i] * self.window[i], 0.0);
            }
            self.fft.process(&mut input);
            
            let n_bins = (n_fft / 2 + 1).min(target_bins);
            for b_idx in 0..n_bins {
                stft_result[[f_idx, b_idx]] = input[b_idx];
            }
        }
        stft_result
    }

    pub fn istft_ndarray(&self, frames: &ndarray::Array2<Complex<f32>>, target_len: usize) -> Vec<f32> {
        let n_fft = self.n_fft;
        let num_frames = frames.shape()[0];
        let max_len = num_frames * self.hop_length + n_fft;
        let mut output = vec![0.0; max_len];
        let mut window_sum = vec![0.0; max_len];
        
        let mut complex_buffer = vec![Complex::new(0.0f32, 0.0f32); n_fft];
        let n_bins_limit = n_fft / 2 + 1;
        let bins_in_frame = frames.shape()[1];

        let throttle = crate::separation::live_priority_active();
        for f_idx in 0..num_frames {
            if throttle && (f_idx % 2 == 0) { 
                std::thread::sleep(std::time::Duration::from_millis(1)); 
            }
            let start = f_idx * self.hop_length;
            
            // Reset buffer
            for i in 0..n_fft { complex_buffer[i] = Complex::new(0.0, 0.0); }
            
            for b_idx in 0..bins_in_frame {
                if b_idx < n_bins_limit {
                    let bin = frames[[f_idx, b_idx]];
                    complex_buffer[b_idx] = bin;
                    if b_idx > 0 && b_idx < n_fft / 2 {
                        complex_buffer[n_fft - b_idx] = Complex::new(bin.re, -bin.im);
                    }
                }
            }
            self.ifft.process(&mut complex_buffer);
            
            for i in 0..n_fft {
                if start + i < output.len() {
                    let sample = complex_buffer[i].re / (n_fft as f32);
                    output[start + i] += sample * self.window[i];
                    window_sum[start + i] += self.window[i] * self.window[i];
                }
            }
        }
        
        let mut final_samples = Vec::with_capacity(target_len);
        for i in 0..target_len {
            if i < output.len() {
                if window_sum[i] > 1e-6 {
                    final_samples.push(output[i] / window_sum[i]);
                } else {
                    final_samples.push(output[i]);
                }
            } else {
                final_samples.push(0.0);
            }
        }

        // Final samples normalization is no longer needed here as OLA handles it.
        // Fading at the boundaries of each chunk is removed to ensure phase consistency for OLA.
        final_samples
    }

    pub fn stft(&self, samples: &[f32], target_bins: usize) -> Vec<Vec<[f32; 2]>> {
        let num_samples = samples.len();
        let n_fft = self.n_fft;
        let num_frames = if num_samples < n_fft { 0 } else { (num_samples - n_fft) / self.hop_length + 1 };
        let mut stft_result = Vec::with_capacity(num_frames);
        
        let mut input = vec![Complex::new(0.0f32, 0.0f32); n_fft];

        let throttle = crate::separation::live_priority_active();
        for (f_idx, start) in (0..=num_samples.saturating_sub(n_fft)).step_by(self.hop_length).enumerate() {
            if throttle && (f_idx % 4 == 0) { std::thread::yield_now(); }
            for i in 0..n_fft {
                input[i] = Complex::new(samples[start + i] * self.window[i], 0.0);
            }
            self.fft.process(&mut input);
            
            let mut frame = Vec::with_capacity(target_bins);
            let n_bins = (n_fft / 2 + 1).min(target_bins);
            for i in 0..n_bins {
                frame.push([input[i].re, input[i].im]);
            }
            // Fill remaining bins if target_bins > n_bins
            for _ in n_bins..target_bins {
                frame.push([0.0, 0.0]);
            }
            stft_result.push(frame);
        }
        stft_result
    }

    pub fn istft(&self, frames: &Vec<Vec<[f32; 2]>>, target_len: usize) -> Vec<f32> {
        let n_fft = self.n_fft;
        let num_frames = frames.len();
        let max_len = num_frames * self.hop_length + n_fft;
        let mut output = vec![0.0; max_len];
        let mut window_sum = vec![0.0; max_len];
        
        let mut complex_buffer = vec![Complex::new(0.0f32, 0.0f32); n_fft];
        let n_bins_limit = n_fft / 2 + 1;

        let throttle = crate::separation::live_priority_active();
        for (f_idx, frame) in frames.iter().enumerate() {
            if throttle && (f_idx % 4 == 0) { std::thread::yield_now(); }
            let start = f_idx * self.hop_length;
            
            // Reset buffer
            for i in 0..n_fft { complex_buffer[i] = Complex::new(0.0, 0.0); }
            
            for (i, &bin) in frame.iter().enumerate() {
                if i < n_bins_limit {
                    complex_buffer[i] = Complex::new(bin[0], bin[1]);
                    if i > 0 && i < n_fft / 2 {
                        complex_buffer[n_fft - i] = Complex::new(bin[0], -bin[1]);
                    }
                }
            }
            self.ifft.process(&mut complex_buffer);
            
            for i in 0..n_fft {
                if start + i < output.len() {
                    let sample = complex_buffer[i].re / (n_fft as f32);
                    output[start + i] += sample * self.window[i];
                    window_sum[start + i] += self.window[i] * self.window[i];
                }
            }
        }
        
        let mut final_samples = Vec::with_capacity(target_len);
        for i in 0..target_len {
            if i < output.len() {
                if window_sum[i] > 1e-6 {
                    final_samples.push(output[i] / window_sum[i]);
                } else {
                    final_samples.push(output[i]);
                }
            } else {
                final_samples.push(0.0);
            }
        }

        // Fading at the boundaries of each chunk is removed to ensure phase consistency for OLA.
        final_samples
    }
}

/// How the ONNX model consumes and produces audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    /// Rust-side STFT → model estimates a spectrogram/mask → Rust-side iSTFT.
    /// Used by the built-in MDX/Kim/KARA models.
    Spectrogram,
    /// The model embeds STFT/iSTFT and works directly on waveforms:
    /// input `[1, 2, N]` (planar stereo) → output `[1, sources, 2, N]`.
    /// Used by Mel-Band RoFormer ONNX exports.
    RawWaveform,
}

/// Explicit STFT / architecture parameters for a model.
///
/// Built-in models leave this as `None` and rely on filename heuristics in
/// `separate`. Custom (user-added) models carry an explicit `ModelParams`
/// derived from an architecture preset so that arbitrary ONNX files that do
/// not match the built-in name patterns still separate correctly.
#[derive(Debug, Clone)]
pub struct ModelParams {
    pub engine: EngineKind,
    pub is_mdx: bool,
    pub is_roformer: bool,
    pub is_kara: bool,
    pub n_fft: usize,
    pub hop_length: usize,
    pub target_bins: usize,
    pub outputs_instrumental: bool,
    /// Index of the vocal stem on the `sources` axis of a RawWaveform model's
    /// output. Ignored by Spectrogram models.
    pub vocal_source_index: usize,
}

#[derive(Clone)]
pub struct WaveformRemover {
    session: Arc<Mutex<Session>>,
    model_name: String,
    active_provider: String,
    outputs_instrumental: bool,
    params: Option<ModelParams>,
}

impl WaveformRemover {
    fn log_runtime_diagnostics_once() {
        if RUNTIME_DIAGNOSTICS_LOGGED.swap(true, Ordering::Relaxed) {
            return;
        }

        sys_log(&format!(
            "[AI-ENGINE] Runtime diagnostics: os={}, arch={}, family={}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::env::consts::FAMILY
        ));
    }

    fn detect_instrumental_output(model_id_hint: Option<&str>, model_name: &str) -> bool {
        if let Some(id) = model_id_hint {
            let lower_id = id.to_ascii_lowercase();
            if lower_id.contains("inst") || lower_id.contains("kara") || lower_id.contains("instrumental") {
                return true;
            }
            if lower_id == "kim" || lower_id.contains("vocal") {
                return false;
            }
        }

        let lower_name = model_name.to_ascii_lowercase();
        lower_name.contains("inst")
            || lower_name.contains("kara")
            || lower_name.contains("instrumental")
    }

    pub fn new(model_path: &Path, model_id_hint: Option<&str>) -> Result<Self> {
        Self::new_with_params(model_path, model_id_hint, None)
    }

    pub fn new_with_params(
        model_path: &Path,
        model_id_hint: Option<&str>,
        params: Option<ModelParams>,
    ) -> Result<Self> {
        Self::log_runtime_diagnostics_once();
        let threads: usize = 1;
        sys_log(&format!("[AI-ENGINE] Initializing with conservative settings (intra-op threads: {})", threads));
        let init_started = Instant::now();
        let file_size = model_path.metadata().map(|m| m.len()).unwrap_or(0);
        sys_log(&format!("[AI-ENGINE] Model file: {:?} ({} bytes)", model_path, file_size));

        // Keep prior fast-path on Windows (GPU by default), while allowing explicit
        // opt-in/opt-out via env var across platforms.
        let gpu_opt_in = match std::env::var("LIVE_MR_ENABLE_GPU") {
            Ok(v) => v == "1" || v.eq_ignore_ascii_case("true"),
            Err(_) => true,
        };

        // RawWaveform models (Mel-Band RoFormer) run a single, very heavy
        // dispatch per chunk (conv-emulated STFT + full attention over an
        // 8s waveform). On DirectML this routinely exceeds the Windows TDR
        // watchdog budget and kills the GPU device mid-inference
        // (DXGI_ERROR_DEVICE_REMOVED / 887A0005), which is unrecoverable
        // until the process restarts. CUDA's kernel scheduling doesn't hit
        // the same wall in practice, so DirectML is skipped for this engine
        // kind and CUDA/CPU are tried instead.
        let is_raw_waveform = params.as_ref().map_or(false, |p| p.engine == EngineKind::RawWaveform);

        let mut providers_to_try = Vec::new();
        if gpu_opt_in {
            // TensorRT는 선택 설치형 GPU 팩(~2GB)이 있을 때만 쓸 수 있다. 이 모델은
            // 노드 5118개가 융합되지 않은 채 남아 커널 실행 오버헤드에 묶여 있어서
            // (GPU 사용률 7%) CUDA EP로도 CPU보다 느리다. TensorRT는 그래프를 융합해
            // 청크당 14.1초 → 0.85초로 떨어뜨린다(실측, RTX 2070).
            // MDX(Kim_Vocal_2 등)는 DirectML에서 이미 곡당 18.5초로 잘 돈다. 거기에
            // 모델별 2~3분짜리 엔진 빌드를 붙일 이득이 확인되지 않았으므로, 실제
            // 병목인 RawWaveform에만 적용한다. (MDX+TensorRT는 측정 후 판단)
            if is_raw_waveform && crate::gpu_pack::is_installed() {
                let cache = crate::gpu_pack::trt_engine_cache_dir();
                std::fs::create_dir_all(&cache).ok();
                providers_to_try.push((
                    "GPU (TensorRT)",
                    TensorRTExecutionProvider::default()
                        .with_device_id(0)
                        // 엔진 빌드는 GPU 아키텍처별로 2~3분 걸린다. 캐시하면 이후 로드 12초.
                        .with_engine_cache(true)
                        .with_engine_cache_path(cache.to_string_lossy().as_ref())
                        .build()
                        .error_on_failure(),
                ));
            } else if is_raw_waveform {
                sys_log("[AI-ENGINE] GPU 가속 팩 미설치 — TensorRT 건너뜀 (설정에서 설치하면 분리 속도가 크게 빨라집니다)");
            }

            if is_raw_waveform {
                sys_log("[AI-ENGINE] RawWaveform model: skipping DirectML (known TDR/device-removed risk on heavy single-shot dispatches)");
            } else {
                providers_to_try.push((
                    "GPU (DirectML)",
                    DirectMLExecutionProvider::default().build().error_on_failure(),
                ));
            }
            providers_to_try.push((
                "GPU (CUDA)",
                CUDAExecutionProvider::default()
                    .with_device_id(0)
                    .build()
                    .error_on_failure(),
            ));
            // Keep CPU as the final fallback when GPU is explicitly enabled.
            providers_to_try.push(("CPU", CPUExecutionProvider::default().build()));
        } else {
            sys_log("[AI-ENGINE] GPU providers disabled (set LIVE_MR_ENABLE_GPU=1 to enable)");
            providers_to_try.push(("CPU", CPUExecutionProvider::default().build()));
        }

        let mut session_opt = None;
        let mut active_provider = "Unknown".to_string();

        for (name, ep) in providers_to_try {
            sys_log(&format!("[AI-ENGINE] Trying provider: {}", name));
            let provider_started = Instant::now();
            let session_res: Result<Session, ort::Error> = (|| {
                sys_log(&format!("[AI-ENGINE] Provider {} builder start", name));

                let builder_started = Instant::now();
                let mut builder = Session::builder()?
                    .with_intra_threads(threads)?
                    // Level1은 융합을 거의 하지 않아 CPU 경로가 청크당 39초까지 갔다.
                    // Level3(ORT 기본)에서 14.1초로 줄고, 출력 통계는 소수점 8자리까지
                    // 동일했다(샘플 141만 개 비교).
                    .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?;
                sys_log(&format!(
                    "[AI-ENGINE] Provider {} builder ready in {} ms",
                    name,
                    builder_started.elapsed().as_millis()
                ));

                let use_default_cpu_path = name == "CPU";

                if use_default_cpu_path {
                    sys_log(&format!("[AI-ENGINE] Provider {} commit start (default path)", name));
                    let commit_started = Instant::now();
                    let result = builder.commit_from_file(model_path);
                    sys_log(&format!(
                        "[AI-ENGINE] Provider {} commit finished in {} ms",
                        name,
                        commit_started.elapsed().as_millis()
                    ));
                    result
                } else {
                    let ep_started = Instant::now();
                    sys_log(&format!("[AI-ENGINE] Provider {} EP registration start", name));
                    // ep는 error_on_failure()로 만든다 — ort의 기본 동작은 EP 등록 실패를
                    // 경고만 남기고 CPU로 조용히 계속 진행하는 것이라, "Using: GPU (CUDA)"를
                    // 찍으면서 실제로는 CPU로 도는 상태가 오래 발각되지 않았다. 실패를
                    // 오류로 올려야 아래 루프가 정직하게 다음 프로바이더로 넘어간다.
                    let mut builder = builder
                        .with_execution_providers([ep])?
                        ;
                    sys_log(&format!(
                        "[AI-ENGINE] Provider {} EP registration done in {} ms",
                        name,
                        ep_started.elapsed().as_millis()
                    ));
                    sys_log(&format!("[AI-ENGINE] Provider {} commit start (explicit EP path)", name));
                    let commit_started = Instant::now();
                    let result = builder.commit_from_file(model_path);
                    sys_log(&format!(
                        "[AI-ENGINE] Provider {} commit finished in {} ms",
                        name,
                        commit_started.elapsed().as_millis()
                    ));
                    result
                }
            })();

            match session_res {
                Ok(session) => {
                    session_opt = Some(session);
                    active_provider = name.to_string();
                    break;
                }
                Err(e) => {
                    sys_log(&format!(
                        "[AI-ENGINE] Provider {} failed or unavailable after {} ms: {}",
                        name,
                        provider_started.elapsed().as_millis(),
                        e
                    ));
                }
            }
        }

        let session = session_opt.ok_or_else(|| anyhow!("[AI-ENGINE] Failed to initialize any execution provider"))?;
        let model_name = model_path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        // A custom model's preset dictates its output type; otherwise fall back
        // to detecting it from the id hint / filename.
        let outputs_instrumental = match &params {
            Some(p) => p.outputs_instrumental,
            None => Self::detect_instrumental_output(model_id_hint, &model_name),
        };

        sys_log(&format!(
            "[AI-ENGINE] Model loaded: {}, Provider: {}, instrumental_output={}, custom_params={}, total_init_ms={}",
            model_name,
            active_provider,
            outputs_instrumental,
            params.is_some(),
            init_started.elapsed().as_millis()
        ));
        Ok(Self {
            session: Arc::new(Mutex::new(session)),
            model_name,
            active_provider,
            outputs_instrumental,
            params,
        })
    }
}

impl InferenceEngine for WaveformRemover {
    fn get_provider(&self) -> String {
        self.active_provider.clone()
    }
    fn get_model_name(&self) -> String {
        self.model_name.clone()
    }
    fn separate(&self, audio_path: &Path, output_dir: &Path, cancel_flag: Arc<AtomicBool>, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf)> {
        // Raw-waveform models (Mel-Band RoFormer) take a completely different
        // inference path: no Rust-side STFT, the model consumes audio directly.
        if self.params.as_ref().map_or(false, |p| p.engine == EngineKind::RawWaveform) {
            return self.separate_raw(audio_path, output_dir, cancel_flag, on_progress);
        }

        let start_time = Instant::now();
        sys_log(&format!("DEBUG: [WaveformRemover] Starting advanced separation for: {:?}. Using: {}", audio_path, self.active_provider));
        // Emit an early progress tick so UI does not stay visually frozen at 0%.
        on_progress(1.0);
        
        if !output_dir.exists() {
            std::fs::create_dir_all(output_dir)?;
        }

        // 1. Load and Resample (always to 44.1kHz for these models)
        let load_and_resample_start = Instant::now();
        let (raw_samples, sample_rate, channels) = self.load_any_audio(audio_path)?;
        
        // Normalize path for reliable cancellation check (ignore slash direction only)
        let path_str = audio_path.to_string_lossy().to_string().replace("\\", "/");
        
        let is_cancelled = || {
            cancel_flag.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str)
        };

        if is_cancelled() {
            return Err(anyhow!("Cancelled before processing"));
        }

        let target_sample_rate = 44100;
        let mut processed_samples = if sample_rate != target_sample_rate {
            sys_log(&format!("DEBUG: [WaveformRemover] Resampling from {} to {}", sample_rate, target_sample_rate));
            let padding_samples = (sample_rate as f32 * 0.1) as usize; // 100ms padding for resampler
            let num_channels = channels as usize;

            // 1. Pad audio to prevent resampler artifacts at boundaries
            let mut padded_samples = vec![0.0f32; padding_samples * num_channels];
            padded_samples.extend_from_slice(&raw_samples);
            padded_samples.extend_from_slice(&vec![0.0f32; padding_samples * num_channels]);
            
            if is_cancelled() {
                return Err(anyhow!("Cancelled before resampling"));
            }

            // 2. Resample the padded audio
            let resampled_padded = self.resample(&padded_samples, sample_rate, target_sample_rate, num_channels)?;
            
            if is_cancelled() {
                return Err(anyhow!("Cancelled after resampling"));
            }

            // 3. Calculate samples to trim from resampled output
            let resample_ratio = target_sample_rate as f64 / sample_rate as f64;
            let trim_samples = (padding_samples as f64 * resample_ratio) as usize;

            // 4. Trim the resampled audio to remove padded silence
            if resampled_padded.len() > 2 * trim_samples * num_channels {
                let start_index = trim_samples * num_channels;
                let end_index = resampled_padded.len() - (trim_samples * num_channels);
                resampled_padded[start_index..end_index].to_vec()
            } else {
                resampled_padded
            }
        } else {
            raw_samples
        };
        // Audio decode/resample completed.
        on_progress(5.0);

        // [ENHANCE] Always add 1.0s silence padding for AI Stabilizing
        let ai_padding_sec = 1.0;
        let ai_padding_samples = (target_sample_rate as f32 * ai_padding_sec) as usize;
        let num_channels = channels as usize;
        
        let mut final_v_padded = vec![0.0f32; ai_padding_samples * num_channels];
        final_v_padded.extend_from_slice(&processed_samples);
        final_v_padded.extend_from_slice(&vec![0.0f32; ai_padding_samples * num_channels]);
        processed_samples = final_v_padded;
        
        sys_log(&format!("PERF: [WaveformRemover] Audio load & resample (+ 1.0s Padding) took: {:?}", load_and_resample_start.elapsed()));

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled before model parameter detection"));
        }

        let setup_start = Instant::now();
        let ch_count = channels as usize;
        let total_samples = processed_samples.len() / ch_count;

        // 2. Model Parameter Auto-Detection
        let session_guard = self.session.lock();
        let input_shape = match session_guard.inputs()[0].dtype() {
            ValueType::Tensor { shape, .. } => shape.clone(),
            _ => return Err(anyhow!("Unexpected input type")),
        };
        let input_rank = input_shape.len();
        drop(session_guard);

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled after model detection"));
        }

        // Custom models supply explicit architecture params (from a preset);
        // built-in models detect them from the filename below.
        let (is_mdx, is_roformer, is_kara) = match &self.params {
            Some(p) => (p.is_mdx, p.is_roformer, p.is_kara),
            None => (
                self.model_name.contains("MDX") || self.model_name.contains("Kim"),
                self.model_name.contains("RoFormer"),
                self.model_name.contains("KARA"),
            ),
        };
        sys_log(&format!("DEBUG: [WaveformRemover] Model identification: is_mdx={}, is_roformer={}, is_kara={}, custom_params={}, model={}", is_mdx, is_roformer, is_kara, self.params.is_some(), self.model_name));

        let mut n_fft = 2048;
        let mut hop_length = 512;
        let mut target_bins = 1025;
        let mut required_samples = 354848;

        if let Some(p) = &self.params {
            // Explicit preset params. `required_samples` is still refined from
            // the ONNX input shape below, matching the built-in code path.
            n_fft = p.n_fft;
            hop_length = p.hop_length;
            target_bins = p.target_bins;
            if is_mdx {
                if input_rank >= 4 {
                    let frames = input_shape[3] as usize; // MDX Shape: [1, 4, bins, frames]
                    if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
                }
            } else if is_roformer || (input_rank == 4 && input_shape[3] == 2) {
                if input_rank == 4 {
                    let frames = input_shape[1] as usize;
                    if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
                }
            }
        } else if is_mdx {
            n_fft = 7680;
            hop_length = 1024;
            target_bins = 3072;

            // [FIX] KARA 2 모델 전용 파라미터 (2048 Bins 모델 대응)
            if self.model_name.contains("KARA") {
                n_fft = 4096;
                target_bins = 2048;
            }

            if input_rank >= 4 {
                let frames = input_shape[3] as usize; // MDX Shape: [1, 4, bins, frames]
                if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
            }
        } else if is_roformer || (input_rank == 4 && input_shape[3] == 2) {
            // Roformer: [2, frames, bins, 2] or some variants
            n_fft = 2048;
            hop_length = 512;
            target_bins = 1025;
            if input_rank == 4 {
                let frames = input_shape[1] as usize;
                if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
            }
        }

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled before STFT engine creation"));
        }

        sys_log(&format!("DEBUG: [WaveformRemover] Params: FFT={}, HOP={}, REQ_SAMPLES={}", n_fft, hop_length, required_samples));

        let stft_engine = StftEngine::new(n_fft, hop_length);

        // 3. Prepare Channels (Wrap in Arc to avoid cloning)
        let mut channels_raw = vec![vec![0.0f32; total_samples]; ch_count];
        for (f_idx, chunk) in processed_samples.chunks_exact(ch_count).enumerate() {
            for (c_idx, &sample) in chunk.iter().enumerate() {
                channels_raw[c_idx][f_idx] = sample;
            }
        }
        let channels_data = Arc::new(channels_raw);

        // 4. Overlap-Add Setup
        let overlap_size = if is_kara {
            // KARA needs heavy overlap (50%) to suppress clicking noises
            required_samples / 2
        } else if is_mdx { 
            88200.min(required_samples / 4) 
        } else if is_roformer {
            // Roformers usually need smaller overlap but we still want smooth OLA
            (2048 * 4).min(required_samples / 4)
        } else { 
            4096.min(required_samples / 4) 
        };
        let step_size = required_samples - overlap_size;
        
        let final_vocal = Arc::new(Mutex::new(vec![vec![0.0f32; total_samples]; ch_count]));
        let final_inst = Arc::new(Mutex::new(vec![vec![0.0f32; total_samples]; ch_count]));
        let weight_sum = Arc::new(Mutex::new(vec![0.0f32; total_samples]));

        // Sin-squared windows for smooth OLA
        let chunk_window = Arc::new((0..required_samples)
            .map(|i| {
                if i < overlap_size {
                    let ratio = i as f32 / overlap_size as f32;
                    (ratio * std::f32::consts::PI / 2.0).sin().powi(2)
                } else if i >= required_samples - overlap_size {
                    let ratio = (required_samples - 1 - i) as f32 / overlap_size as f32;
                    (ratio * std::f32::consts::PI / 2.0).sin().powi(2)
                } else {
                    1.0
                }
            })
            .collect::<Vec<f32>>());

        let num_chunks = (total_samples + step_size - 1) / step_size;
        sys_log(&format!("PERF: [WaveformRemover] Parameter setup took: {:?}", setup_start.elapsed()));
        // Parameter discovery/setup completed.
        on_progress(10.0);

        // --- 3-STAGE PIPELINE SETUP ---
        let _pipeline_start = Instant::now();
        // STAGE 1: Preprocessing (STFT) Thread
        let pipeline_capacity = pipeline_capacity(crate::separation::live_priority_active());
        sys_log(&format!("PERF: [AI-ENGINE] Pipeline capacity={} live_priority={}", pipeline_capacity, pipeline_capacity == 1));
        let (pre_tx, pre_rx) = std::sync::mpsc::sync_channel::<(usize, Value, Vec<Vec<f32>>, usize, bool, bool)>(pipeline_capacity);
        let (post_tx, post_rx) = std::sync::mpsc::sync_channel::<(usize, Vec<Value>, Vec<Vec<f32>>, usize, bool, bool)>(pipeline_capacity);

        // STAGE 1: Preprocessing (STFT) Thread
        let channels_data_clone = Arc::clone(&channels_data);
        let stft_engine_clone = stft_engine.clone();
        let cancel_flag_prep = cancel_flag.clone();
        let path_str_prep = path_str.clone();
        let pre_tx_clone = pre_tx.clone();
        std::thread::spawn(move || {
            let prep_start = Instant::now();
            
            let check_cancel = || {
                cancel_flag_prep.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str_prep)
            };

            for chunk_idx in 0..num_chunks {
                if check_cancel() { break; }
                
                // [FIX] Broadcast Mode Throttle (More aggressive)
                if crate::separation::live_priority_active() {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
                
                let mut chunk_start = chunk_idx * step_size;
                let mut is_last_chunk_at_end = false;
                if chunk_start + required_samples > total_samples {
                    chunk_start = total_samples.saturating_sub(required_samples);
                    is_last_chunk_at_end = true;
                }
                
                let mut current_chunks = vec![vec![0.0f32; required_samples]; ch_count];
                for ch in 0..ch_count {
                    let end_idx = (chunk_start + required_samples).min(total_samples);
                    let len = end_idx - chunk_start;
                    current_chunks[ch][..len].copy_from_slice(&channels_data_clone[ch][chunk_start..end_idx]);
                }

                // Pre-gain scaling (currently disabled for Inst HQ 3 to preserve quality)

                // Internal parallelism for Left/Right channels is still maintained
                let (left_stft, right_stft) = if ch_count > 1 {
                    if crate::separation::live_priority_active() {
                        let l = stft_engine_clone.stft_ndarray(&current_chunks[0], target_bins);
                        let r = stft_engine_clone.stft_ndarray(&current_chunks[1], target_bins);
                        (l, r)
                    } else {
                        rayon::join(
                            || stft_engine_clone.stft_ndarray(&current_chunks[0], target_bins),
                            || stft_engine_clone.stft_ndarray(&current_chunks[1], target_bins)
                        )
                    }
                } else {
                    let l = stft_engine_clone.stft_ndarray(&current_chunks[0], target_bins);
                    (l.clone(), l)
                };

                let num_frames = left_stft.shape()[0];
                let input_value_res = if is_mdx {
                    let mut stereo_tensor = Array4::<f32>::zeros((1, 4, target_bins, num_frames));
                    for b in 0..target_bins {
                        for f in 0..num_frames {
                            let l = left_stft[[f, b]];
                            let r = right_stft[[f, b]];
                            stereo_tensor[[0, 0, b, f]] = l.re;
                            stereo_tensor[[0, 1, b, f]] = l.im;
                            stereo_tensor[[0, 2, b, f]] = r.re;
                            stereo_tensor[[0, 3, b, f]] = r.im;
                        }
                    }
                    Value::from_array(stereo_tensor)
                } else {
                    let mut stereo_tensor = Array4::<f32>::zeros((2, num_frames, target_bins, 2));
                    for f in 0..num_frames {
                        for b in 0..target_bins {
                            let l = left_stft[[f, b]];
                            let r = right_stft[[f, b]];
                            stereo_tensor[[0, f, b, 0]] = l.re;
                            stereo_tensor[[0, f, b, 1]] = l.im;
                            stereo_tensor[[1, f, b, 0]] = r.re;
                            stereo_tensor[[1, f, b, 1]] = r.im;
                        }
                    }
                    Value::from_array(stereo_tensor)
                };

                if let Ok(input_value) = input_value_res {
                    if pre_tx_clone.send((chunk_idx, input_value.into_dyn(), current_chunks, chunk_start, is_last_chunk_at_end, is_kara)).is_err() {
                        break;
                    }
                }
            }
            sys_log(&format!("PERF: [AI-ENGINE] Stage 1 (Preprocessing) thread finished in {:?}.", prep_start.elapsed()));
        });

        // STAGE 2: Inference Loop (Main Thread - GPU Inference)
        let session_clone = Arc::clone(&self.session);
        
        let cancel_flag_infer = cancel_flag.clone();
        let path_str_infer = path_str.clone();
        std::thread::spawn(move || {
            let infer_start = Instant::now();
            while let Ok((chunk_idx, input_tensor, current_chunks, chunk_start, is_last_chunk, is_kara_chunk)) = pre_rx.recv() {
                if cancel_flag_infer.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str_infer) { break; }
                
                let outputs_vec_res = {
                    let mut session_guard = session_clone.lock();
                    session_guard.run(ort::inputs![input_tensor])
                        .map(|outputs| outputs.into_iter().map(|(_, v)| v).collect::<Vec<Value>>())
                };

                if let Ok(outputs_vec) = outputs_vec_res {
                    if post_tx.send((chunk_idx, outputs_vec, current_chunks, chunk_start, is_last_chunk, is_kara_chunk)).is_err() { break; }
                }
            }
            drop(post_tx);
            sys_log(&format!("PERF: [AI-ENGINE] Stage 2 (Inference) thread finished in {:?}.", infer_start.elapsed()));
        });

        // STAGE 3: Post-processing (iSTFT & OLA) Thread
        let stft_engine_clone_2 = stft_engine.clone();
        let chunk_window_clone = Arc::clone(&chunk_window);
        let final_vocal_clone = Arc::clone(&final_vocal);
        let final_inst_clone = Arc::clone(&final_inst);
        let weight_sum_clone = Arc::clone(&weight_sum);
        let compensation = 1.0f32;
        let is_instrumental_model = self.outputs_instrumental;

        let cancel_flag_post = cancel_flag.clone();
        let path_str_post = path_str.clone();
        let post_handle = std::thread::spawn(move || {
            let post_proc_start = Instant::now();
            let mut processed_count = 0;
            while let Ok((chunk_idx, outputs, current_chunks, chunk_start, _is_last_chunk_at_end, _is_kara_node)) = post_rx.recv() {
                if cancel_flag_post.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str_post) { break; }
                
                // Extract Result from Tensor
                let owned_data: Vec<f32> = if let Ok((_shape, slice)) = outputs[0].try_extract_tensor::<f32>() {
                    slice.to_vec()
                } else {
                    sys_log(&format!("ERROR: [AI-ENGINE] Failed to extract output tensor for chunk {}", chunk_idx));
                    break;
                };

                let total_elements = owned_data.len();
                let frames = total_elements / (4 * target_bins);

                let mut res_l = ndarray::Array2::from_elem((frames, target_bins), Complex::new(0.0f32, 0.0f32));
                let mut res_r = ndarray::Array2::from_elem((frames, target_bins), Complex::new(0.0f32, 0.0f32));
                
                if is_mdx {
                    for b in 0..target_bins {
                        let offset = b * frames;
                        for f in 0..frames {
                            let base = offset + f;
                            res_l[[f, b]] = Complex::new(
                                owned_data[0 * target_bins * frames + base],
                                owned_data[1 * target_bins * frames + base]
                            );
                            res_r[[f, b]] = Complex::new(
                                owned_data[2 * target_bins * frames + base],
                                owned_data[3 * target_bins * frames + base]
                            );
                        }
                    }
                } else {
                    for f in 0..frames {
                        let f_offset = f * target_bins * 2;
                        for b in 0..target_bins {
                            let base = f_offset + b * 2;
                            res_l[[f, b]] = Complex::new(owned_data[base + 0], owned_data[base + 1]);
                            res_r[[f, b]] = Complex::new(
                                owned_data[frames * target_bins * 2 + base + 0],
                                owned_data[frames * target_bins * 2 + base + 1]
                            );
                        }
                    }
                }

                let req_samples_inner = current_chunks[0].len();
                let (voc_l, voc_r) = if ch_count > 1 {
                    if crate::separation::live_priority_active() {
                        let l = stft_engine_clone_2.istft_ndarray(&res_l, req_samples_inner);
                        let r = stft_engine_clone_2.istft_ndarray(&res_r, req_samples_inner);
                        (l, r)
                    } else {
                        rayon::join(
                            || stft_engine_clone_2.istft_ndarray(&res_l, req_samples_inner),
                            || stft_engine_clone_2.istft_ndarray(&res_r, req_samples_inner)
                        )
                    }
                } else {
                    let l = stft_engine_clone_2.istft_ndarray(&res_l, req_samples_inner);
                    (l.clone(), l)
                };
                let vocal_res = vec![voc_l, voc_r];

                let mut local_vocal = vec![vec![0.0f32; req_samples_inner]; ch_count];
                let mut local_inst = vec![vec![0.0f32; req_samples_inner]; ch_count];
                let mut local_weight = vec![0.0f32; req_samples_inner];

                for ch in 0..ch_count {
                    for i in 0..req_samples_inner {
                        let w = chunk_window_clone[i];
                        
                        // Note: For Inst models (like Inst HQ 3 or KARA), the model output is the instrumental track.
                        let model_output_sample = vocal_res[ch][i] * compensation;
                        let orig_sample = current_chunks[ch][i]; 
                        
                        if is_instrumental_model {
                            local_inst[ch][i] = model_output_sample * w;
                            local_vocal[ch][i] = (orig_sample - model_output_sample) * w;
                        } else {
                            local_vocal[ch][i] = model_output_sample * w;
                            local_inst[ch][i] = (orig_sample - model_output_sample) * w;
                        }
                        
                        if ch == 0 { local_weight[i] = w; }
                    }
                }

                {
                    let mut vocal_guard = final_vocal_clone.lock();
                    let mut inst_guard = final_inst_clone.lock();
                    let mut weight_guard = weight_sum_clone.lock();
                    
                    for ch in 0..ch_count {
                        for i in 0..req_samples_inner {
                            let out_idx = chunk_start + i;
                            if out_idx < total_samples {
                                vocal_guard[ch][out_idx] += local_vocal[ch][i];
                                inst_guard[ch][out_idx] += local_inst[ch][i];
                                if ch == 0 { weight_guard[out_idx] += local_weight[i]; }
                            }
                        }
                    }
                }
                
                processed_count += 1;
                if num_chunks > 0 {
                    // Keep processing range in 10..99 and emit every chunk for smoother UI.
                    let processing_pct = 10.0 + ((processed_count as f32 / num_chunks as f32) * 89.0);
                    on_progress(processing_pct.min(99.0));
                }
            }
            sys_log(&format!("PERF: [AI-ENGINE] Stage 3 (Post-processing) thread finished in {:?}. (Processed {} chunks)", post_proc_start.elapsed(), processed_count));
        });

        // Wait for all stages to finish
        drop(pre_tx); // Signals Stage 2 to stop after finishing remaining packets
        
        let _ = post_handle.join(); 
        
        // [FIX] Check if the process was cancelled before finalizing
        if is_cancelled() {
            return Err(anyhow!("Separation Cancelled during processing"));
        }

        sys_log("DEBUG: [WaveformRemover] Pipelined processing complete.");

        // Finalize OLA Normalization
        let finalize_start = Instant::now();
        // Extract inner vectors from Arc<Mutex<...>>
        let mut final_vocal_inner = Arc::try_unwrap(final_vocal).map_err(|_| anyhow!("Arc unwrap failed"))?.into_inner();
        let mut final_inst_inner = Arc::try_unwrap(final_inst).map_err(|_| anyhow!("Arc unwrap failed"))?.into_inner();
        let weight_sum_inner = Arc::try_unwrap(weight_sum).map_err(|_| anyhow!("Arc unwrap failed"))?.into_inner();

        for i in 0..total_samples {
            if weight_sum_inner[i] > 1e-10 {
                for ch in 0..ch_count {
                    final_vocal_inner[ch][i] /= weight_sum_inner[i];
                    final_inst_inner[ch][i] /= weight_sum_inner[i];
                }
            }
        }

        // 6. Trim Padding (Remove 1.0s from both ends)
        let ai_padding_samples = (target_sample_rate as f32 * 1.0) as usize;
        if total_samples > 2 * ai_padding_samples {
            let start = ai_padding_samples;
            let end = total_samples - ai_padding_samples;
            trim_padding_in_place(&mut final_vocal_inner, start, end);
            trim_padding_in_place(&mut final_inst_inner, start, end);
            sys_log(&format!("DEBUG: [WaveformRemover] Trimming AI Stabilizing padding ({} samples).", ai_padding_samples));
        } else {
            sys_log("WARN: [WaveformRemover] Result too short to trim padding, results might have edge artifacts.");
        }

        // 7. Save Results (post-process once; MP3 = pcm16 temp → encode, WAV = 32-bit float)
        let format = crate::mr_cache::current_format();
        let (vocal_path, inst_path) = crate::mr_cache::mr_output_paths_for(output_dir, format);
        sys_log(&format!(
            "DEBUG: [WaveformRemover] Saving MR cache as {} ({:?}, {:?})",
            format.as_str(),
            vocal_path.file_name(),
            inst_path.file_name()
        ));
        self.save_mr(&final_vocal_inner, &vocal_path, target_sample_rate)
            .map_err(|e| anyhow!("Vocal save failed: {}", e))?;
        self.save_mr(&final_inst_inner, &inst_path, target_sample_rate)
            .map_err(|e| anyhow!("Inst save failed: {}", e))?;

        sys_log(&format!("PERF: [WaveformRemover] Finalize & Save took: {:?}", finalize_start.elapsed()));
        sys_log(&format!("PERF: [WaveformRemover] Total separation time for track: {:?}", start_time.elapsed()));
        
        sys_log("DEBUG: [WaveformRemover] Advanced Separation complete with 3-stage pipeline.");
        Ok((vocal_path, inst_path))
    }

    fn validate_harmony_stems(&self, input: &Path, lead: &Path, backing: &Path) -> Result<(f32, f32, f32)> {
        let (input_samples, input_rate, input_channels) = self.load_any_audio(input)?;
        let (lead_samples, lead_rate, lead_channels) = self.load_any_audio(lead)?;
        let (backing_samples, backing_rate, backing_channels) = self.load_any_audio(backing)?;
        if input_rate != lead_rate || input_rate != backing_rate
            || input_channels != lead_channels || input_channels != backing_channels {
            return Err(anyhow!("Harmony stems have incompatible sample rate/channel layout"));
        }
        let duration_tolerance = ((input_samples.len() as f64 * 0.01) as usize)
            .max(input_rate as usize * input_channels as usize / 5);
        if input_samples.len().abs_diff(lead_samples.len()) > duration_tolerance
            || input_samples.len().abs_diff(backing_samples.len()) > duration_tolerance {
            return Err(anyhow!(
                "Harmony stems have incompatible duration (input={}, lead={}, backing={})",
                input_samples.len(), lead_samples.len(), backing_samples.len()
            ));
        }
        let len = input_samples.len().min(lead_samples.len()).min(backing_samples.len());
        if len < input_rate as usize {
            return Err(anyhow!("Harmony stems are too short"));
        }
        harmony_quality_metrics(&input_samples[..len], &lead_samples[..len], &backing_samples[..len])
    }
}

impl WaveformRemover {
    /// Separation path for RawWaveform models (Mel-Band RoFormer ONNX):
    /// the model embeds STFT/iSTFT and maps `[1, 2, N]` waveform chunks to
    /// `[1, sources, 2, N]` separated stems. Sequential chunked inference with
    /// windowed overlap-add; no Rust-side STFT is involved.
    fn separate_raw(
        &self,
        audio_path: &Path,
        output_dir: &Path,
        cancel_flag: Arc<AtomicBool>,
        on_progress: Box<dyn Fn(f32) + Send>,
    ) -> Result<(PathBuf, PathBuf)> {
        let start_time = Instant::now();
        let params = self.params.clone().ok_or_else(|| anyhow!("RawWaveform path requires ModelParams"))?;
        sys_log(&format!(
            "DEBUG: [WaveformRemover] Starting raw-waveform separation for: {:?}. Using: {}",
            audio_path, self.active_provider
        ));
        on_progress(1.0);

        if !output_dir.exists() {
            std::fs::create_dir_all(output_dir)?;
        }

        // 1. Load & resample to 44.1kHz (same approach as the spectrogram path).
        let (raw_samples, sample_rate, channels) = self.load_any_audio(audio_path)?;
        let path_str = audio_path.to_string_lossy().to_string().replace("\\", "/");
        let is_cancelled = || {
            cancel_flag.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str)
        };
        if is_cancelled() {
            return Err(anyhow!("Cancelled before processing"));
        }

        let target_sample_rate = 44100u32;
        let num_channels = (channels as usize).max(1);
        let processed_samples = if sample_rate != target_sample_rate {
            sys_log(&format!("DEBUG: [WaveformRemover] Resampling from {} to {}", sample_rate, target_sample_rate));
            let padding_samples = (sample_rate as f32 * 0.1) as usize; // 100ms padding for resampler
            let mut padded = vec![0.0f32; padding_samples * num_channels];
            padded.extend_from_slice(&raw_samples);
            padded.extend_from_slice(&vec![0.0f32; padding_samples * num_channels]);
            if is_cancelled() {
                return Err(anyhow!("Cancelled before resampling"));
            }
            let resampled = self.resample(&padded, sample_rate, target_sample_rate, num_channels)?;
            let ratio = target_sample_rate as f64 / sample_rate as f64;
            let trim = (padding_samples as f64 * ratio) as usize;
            if resampled.len() > 2 * trim * num_channels {
                resampled[trim * num_channels..resampled.len() - trim * num_channels].to_vec()
            } else {
                resampled
            }
        } else {
            raw_samples
        };
        on_progress(5.0);

        // 2. 1.0s silence padding on both ends (AI stabilization, same as MDX path).
        let ai_padding_samples = (target_sample_rate as f32 * 1.0) as usize;
        let mut padded = vec![0.0f32; ai_padding_samples * num_channels];
        padded.extend_from_slice(&processed_samples);
        padded.extend_from_slice(&vec![0.0f32; ai_padding_samples * num_channels]);
        drop(processed_samples);

        // 3. Interleaved → fixed stereo planar (the model expects exactly 2 channels;
        //    mono input is duplicated, extra channels are dropped).
        let total_samples = padded.len() / num_channels;
        let mut mix = vec![vec![0.0f32; total_samples]; 2];
        for (f_idx, frame) in padded.chunks_exact(num_channels).enumerate() {
            let l = frame[0];
            let r = if num_channels >= 2 { frame[1] } else { frame[0] };
            mix[0][f_idx] = l;
            mix[1][f_idx] = r;
        }
        drop(padded);

        if is_cancelled() {
            return Err(anyhow!("Cancelled before model parameter detection"));
        }

        // 4. Chunk size from the ONNX input shape [1, 2, N]; dynamic axes fall
        //    back to 8s @ 44.1kHz (the common Mel-Band RoFormer export).
        let input_shape = {
            let session_guard = self.session.lock();
            match session_guard.inputs()[0].dtype() {
                ValueType::Tensor { shape, .. } => shape.clone(),
                _ => return Err(anyhow!("Unexpected input type")),
            }
        };
        let mut chunk_size = 352800usize;
        if input_shape.len() == 3 && input_shape[2] > 0 {
            chunk_size = input_shape[2] as usize;
        }
        let overlap_size = chunk_size / 4;
        let step_size = chunk_size - overlap_size;
        let num_chunks = (total_samples + step_size - 1) / step_size;
        sys_log(&format!(
            "DEBUG: [WaveformRemover] Raw params: chunk={}, overlap={}, chunks={}, vocal_source_index={}",
            chunk_size, overlap_size, num_chunks, params.vocal_source_index
        ));

        // Sin-squared window for smooth OLA (same formula as the spectrogram path).
        let window: Vec<f32> = (0..chunk_size)
            .map(|i| {
                if i < overlap_size {
                    let ratio = i as f32 / overlap_size as f32;
                    (ratio * std::f32::consts::PI / 2.0).sin().powi(2)
                } else if i >= chunk_size - overlap_size {
                    let ratio = (chunk_size - 1 - i) as f32 / overlap_size as f32;
                    (ratio * std::f32::consts::PI / 2.0).sin().powi(2)
                } else {
                    1.0
                }
            })
            .collect();

        let mut final_vocal = vec![vec![0.0f32; total_samples]; 2];
        let mut final_inst = vec![vec![0.0f32; total_samples]; 2];
        let mut weight_sum = vec![0.0f32; total_samples];

        on_progress(10.0);
        let inference_start = Instant::now();

        // 5. Sequential chunked inference (the model itself is the bottleneck;
        //    a multi-stage pipeline buys nothing here).
        for (chunk_idx, chunk_start) in (0..total_samples).step_by(step_size).enumerate() {
            if is_cancelled() {
                return Err(anyhow!("Separation Cancelled during processing"));
            }

            // Build [1, 2, chunk] planar input, zero-padded past the end.
            let avail = (total_samples - chunk_start).min(chunk_size);
            let mut input_vec = vec![0.0f32; 2 * chunk_size];
            for ch in 0..2 {
                input_vec[ch * chunk_size..ch * chunk_size + avail]
                    .copy_from_slice(&mix[ch][chunk_start..chunk_start + avail]);
            }

            let input_value = Value::from_array(([1usize, 2, chunk_size], input_vec))?;
            let outputs_vec: Vec<Value> = {
                let mut session_guard = self.session.lock();
                session_guard
                    .run(ort::inputs![input_value])
                    .map(|outputs| outputs.into_iter().map(|(_, v)| v).collect::<Vec<Value>>())
            }?;
            let (out_shape, out_data) = outputs_vec[0].try_extract_tensor::<f32>()?;

            // Interpret output: rank 4 = [1, sources, ch, N]; rank 3 = [1, ch, N]
            // (single-stem export; the complement is derived from the mix).
            let rank = out_shape.len();
            let (n_sources, out_ch, out_len) = if rank == 4 {
                (out_shape[1] as usize, out_shape[2] as usize, out_shape[3] as usize)
            } else if rank == 3 {
                (1usize, out_shape[1] as usize, out_shape[2] as usize)
            } else {
                return Err(anyhow!("Unexpected output rank {} from raw-waveform model", rank));
            };
            if n_sources == 0 || out_ch == 0 || out_len == 0 {
                return Err(anyhow!("Empty output tensor from raw-waveform model"));
            }

            let primary_idx = params.vocal_source_index.min(n_sources - 1);
            let secondary_idx = (0..n_sources).find(|&s| s != primary_idx);
            let copy_len = out_len.min(avail);

            for ch in 0..2 {
                let src_ch = ch.min(out_ch - 1);
                for i in 0..copy_len {
                    let w = window[i];
                    let out_idx = chunk_start + i;
                    let primary = out_data[(primary_idx * out_ch + src_ch) * out_len + i];

                    let (vocal_s, inst_s) = match secondary_idx {
                        Some(sec) => {
                            let secondary = out_data[(sec * out_ch + src_ch) * out_len + i];
                            // vocal_source_index points at the vocal stem.
                            (primary, secondary)
                        }
                        None => {
                            // Single-stem export: derive the complement from the mix.
                            let residual = mix[ch][out_idx] - primary;
                            if params.outputs_instrumental {
                                (residual, primary)
                            } else {
                                (primary, residual)
                            }
                        }
                    };

                    final_vocal[ch][out_idx] += vocal_s * w;
                    final_inst[ch][out_idx] += inst_s * w;
                    if ch == 0 {
                        weight_sum[out_idx] += w;
                    }
                }
            }

            let processing_pct = 10.0 + (((chunk_idx + 1) as f32 / num_chunks as f32) * 89.0);
            on_progress(processing_pct.min(99.0));

            // Broadcast-protection mode: yield between chunks to reduce contention.
            if crate::separation::live_priority_active() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        sys_log(&format!("PERF: [WaveformRemover] Raw inference took: {:?}", inference_start.elapsed()));

        if is_cancelled() {
            return Err(anyhow!("Separation Cancelled during processing"));
        }

        // 6. OLA normalization.
        for i in 0..total_samples {
            if weight_sum[i] > 1e-10 {
                for ch in 0..2 {
                    final_vocal[ch][i] /= weight_sum[i];
                    final_inst[ch][i] /= weight_sum[i];
                }
            }
        }

        // 7. Trim the 1.0s stabilization padding.
        if total_samples > 2 * ai_padding_samples {
            let start = ai_padding_samples;
            let end = total_samples - ai_padding_samples;
            trim_padding_in_place(&mut final_vocal, start, end);
            trim_padding_in_place(&mut final_inst, start, end);
        } else {
            sys_log("WARN: [WaveformRemover] Result too short to trim padding, results might have edge artifacts.");
        }

        // 8. Save via the shared MR cache path.
        let format = crate::mr_cache::current_format();
        let (vocal_path, inst_path) = crate::mr_cache::mr_output_paths_for(output_dir, format);
        sys_log(&format!(
            "DEBUG: [WaveformRemover] Saving MR cache as {} ({:?}, {:?})",
            format.as_str(),
            vocal_path.file_name(),
            inst_path.file_name()
        ));
        self.save_mr(&final_vocal, &vocal_path, target_sample_rate)
            .map_err(|e| anyhow!("Vocal save failed: {}", e))?;
        self.save_mr(&final_inst, &inst_path, target_sample_rate)
            .map_err(|e| anyhow!("Inst save failed: {}", e))?;

        sys_log(&format!("PERF: [WaveformRemover] Total raw separation time for track: {:?}", start_time.elapsed()));
        Ok((vocal_path, inst_path))
    }

    fn load_any_audio(&self, path: &Path) -> Result<(Vec<f32>, u32, u8)> {
        let file = std::fs::File::open(path)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            hint.with_extension(ext);
        }

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())?;

        let mut format = probed.format;
        let track = format.tracks().iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow!("No supported audio track found"))?;
        
        let track_id = track.id;
        let sample_rate = track.codec_params.sample_rate.ok_or_else(|| anyhow!("Unknown sample rate"))?;
        
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())?;

        let mut samples: Vec<f32> = Vec::new();
        let mut detected_channels: Option<usize> = track.codec_params.channels.map(|c| c.count());

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(_)) => break,
                Err(e) => return Err(e.into()),
            };

            if packet.track_id() != track_id { continue; }

            let decoded = decoder.decode(&packet)?;
            
            // If channels not yet detected from metadata, get from the actual buffer
            let ch_count = detected_channels.get_or_insert_with(|| decoded.spec().channels.count());
            
            samples.extend_from_slice(&self.audio_bufref_to_samples(&decoded, *ch_count));
        }

        let final_channels = detected_channels.ok_or_else(|| anyhow!("Could not determine channel count"))? as u8;
        Ok((samples, sample_rate, final_channels))
    }

    fn audio_bufref_to_samples(&self, audio_buf: &AudioBufferRef<'_>, channels: usize) -> Vec<f32> {
        let frames = audio_buf.frames();
        if frames == 0 { return Vec::new(); }
        
        let mut samples = Vec::with_capacity(frames * channels);
        let ch_count = audio_buf.spec().channels.count();
        let process_chs = channels.min(ch_count);

        match audio_buf {
            AudioBufferRef::F32(buf) => {
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f]); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::S32(buf) => {
                let scale = 1.0 / 2147483648.0;
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f] as f32 * scale); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::S24(buf) => {
                let scale = 1.0 / 8388608.0;
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f].0 as f32 * scale); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::S16(buf) => {
                let scale = 1.0 / 32768.0;
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f] as f32 * scale); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::U8(buf) => {
                for f in 0..frames {
                    for c in 0..process_chs { samples.push((buf.chan(c)[f] as f32 - 128.0) / 128.0); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            _ => samples.resize(frames * channels, 0.0),
        }
        samples
    }

    fn resample(&self, samples: &[f32], source_rate: u32, target_rate: u32, channels: usize) -> Result<Vec<f32>> {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };
        
        let mut resampler = SincFixedIn::<f32>::new(
            target_rate as f64 / source_rate as f64,
            2.0,
            params,
            samples.len() / channels,
            channels,
        )?;

        let mut interleaved = vec![vec![0.0f32; samples.len() / channels]; channels];
        for (f_idx, chunk) in samples.chunks_exact(channels).enumerate() {
            for (c_idx, &sample) in chunk.iter().enumerate() {
                interleaved[c_idx][f_idx] = sample;
            }
        }

        let resampled = resampler.process(&interleaved, None)?;
        let mut result = Vec::with_capacity(resampled[0].len() * channels);
        for f_idx in 0..resampled[0].len() {
            for c_idx in 0..channels {
                result.push(resampled[c_idx][f_idx]);
            }
        }
        Ok(result)
    }

    fn save_mr(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<()> {
        match crate::mr_cache::current_format() {
            crate::mr_cache::MrCacheFormat::Mp3 => self.save_mp3(samples, path, rate),
            crate::mr_cache::MrCacheFormat::Wav => self.save_wav(samples, path, rate),
        }
    }

    fn save_wav(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<()> {
        let processed = if self.outputs_instrumental {
            self.process_inst_stem(samples, rate)?
        } else {
            self.process_kim_stem(samples, rate)?
        };
        Self::write_float_wav(&processed, path, rate)
    }

    /// MP3: post-process → 16-bit temp WAV → ffmpeg 320k (no giant float WAV on disk).
    fn save_mp3(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<()> {
        let processed = if self.outputs_instrumental {
            self.process_inst_stem(samples, rate)?
        } else {
            self.process_kim_stem(samples, rate)?
        };
        let temp_wav = crate::mr_encode::mp3_encode_temp_wav_path(path);
        crate::mr_encode::write_stereo_wav_pcm16(&temp_wav, rate, &processed)?;
        let result = crate::mr_encode::encode_wav_file_to_mp3(&temp_wav, path);
        let _ = std::fs::remove_file(&temp_wav);
        result
    }

    fn write_float_wav(processed: &[Vec<f32>], path: &Path, rate: u32) -> Result<()> {
        let num_channels = processed.len();
        if num_channels == 0 {
            return Ok(());
        }
        let spec = hound::WavSpec {
            channels: num_channels as u16,
            sample_rate: rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec)?;
        let num_frames = processed[0].len();
        for i in 0..num_frames {
            for ch in 0..num_channels {
                writer.write_sample(processed[ch][i])?;
            }
        }
        writer.finalize()?;
        Ok(())
    }

    fn process_kim_stem(&self, samples: &Vec<Vec<f32>>, rate: u32) -> Result<Vec<Vec<f32>>> {
        let num_channels = samples.len();
        if num_channels == 0 {
            return Ok(Vec::new());
        }
        let num_frames = samples[0].len();
        let out_ch = num_channels.min(2);
        let mut out: Vec<Vec<f32>> = (0..out_ch)
            .map(|_| Vec::with_capacity(num_frames))
            .collect();

        if num_frames < 200 {
            if num_frames > 0 {
                for i in 0..num_frames {
                    for ch in 0..out_ch {
                        out[ch].push(samples[ch][i].clamp(-1.0, 1.0));
                    }
                }
            }
            return Ok(out);
        }

        let total_samples_f64 = (num_channels * num_frames) as f64;
        let mut dc_offset_sum = 0.0f64;
        for ch_samples in samples {
            for s in ch_samples {
                dc_offset_sum += *s as f64;
            }
        }
        let dc_offset = (dc_offset_sum / total_samples_f64) as f32;

        let mut sum_sq = 0.0f64;
        for ch_samples in samples {
            for s in ch_samples {
                let s_corrected = (*s - dc_offset) as f64;
                sum_sq += s_corrected * s_corrected;
            }
        }
        let rms = (sum_sq / total_samples_f64).sqrt() as f32;
        let target_rms = 10.0_f32.powf(-16.0 / 20.0);
        let gain = if rms > 1e-6 {
            (target_rms / rms).min(8.0)
        } else {
            1.0
        };

        let threshold = 0.90f32;
        let margin = 1.0 - threshold;
        let fade_frames = (rate as f32 * (15.0 / 1000.0)) as usize;
        let fade_in_end = fade_frames.min(num_frames / 2).max(1);
        let fade_out_start = num_frames.saturating_sub(fade_frames);
        let fade_out_len = (num_frames - fade_out_start).max(1);

        for i in 0..num_frames {
            let fade_multiplier = if i < fade_in_end {
                (i as f32 / fade_in_end as f32).powi(2)
            } else if i >= fade_out_start {
                let progress = (i - fade_out_start) as f32 / fade_out_len as f32;
                (1.0 - progress.min(1.0)).powi(2)
            } else {
                1.0
            };

            for ch in 0..out_ch {
                let mut s = (samples[ch][i] - dc_offset) * gain * fade_multiplier;
                let abs_s = s.abs();
                if abs_s > threshold {
                    let sign = s.signum();
                    s = sign * (threshold + margin * ((abs_s - threshold) / margin).tanh());
                }
                out[ch].push(s.clamp(-1.0, 1.0));
            }
        }
        Ok(out)
    }

    fn process_inst_stem(&self, samples: &Vec<Vec<f32>>, rate: u32) -> Result<Vec<Vec<f32>>> {
        let num_channels = samples.len();
        if num_channels == 0 {
            return Ok(Vec::new());
        }
        let num_frames = samples[0].len();
        let out_ch = num_channels.min(2);
        let mut out: Vec<Vec<f32>> = (0..out_ch)
            .map(|_| Vec::with_capacity(num_frames))
            .collect();

        let total_samples_f64 = (num_channels * num_frames) as f64;
        let mut dc_offset_sum = 0.0f64;
        for ch_samples in samples {
            for s in ch_samples {
                dc_offset_sum += *s as f64;
            }
        }
        let dc_offset = (dc_offset_sum / total_samples_f64) as f32;

        let mut max_peak = 0.0f32;
        for ch_samples in samples {
            for s in ch_samples {
                max_peak = max_peak.max((*s - dc_offset).abs());
            }
        }

        let target_peak = 10.0_f32.powf(-1.0 / 20.0);
        let gain = if max_peak > 1e-6 {
            (target_peak / max_peak).min(2.0)
        } else {
            1.0
        };

        let threshold = 0.95f32;
        let margin = 0.98f32 - threshold;
        let fade_frames = (rate as f32 * (5.0 / 1000.0)) as usize;
        let fade_in_end = fade_frames.min(num_frames / 2).max(1);
        let fade_out_start = num_frames.saturating_sub(fade_frames);
        let fade_out_len = (num_frames - fade_out_start).max(1);

        for i in 0..num_frames {
            let fade_multiplier = if i < fade_in_end {
                i as f32 / fade_in_end as f32
            } else if i >= fade_out_start {
                1.0 - (i - fade_out_start) as f32 / fade_out_len as f32
            } else {
                1.0
            };

            for ch in 0..out_ch {
                let mut s = (samples[ch][i] - dc_offset) * gain * fade_multiplier;
                let abs_s = s.abs();
                if abs_s > threshold {
                    let sign = s.signum();
                    s = sign * (threshold + margin * ((abs_s - threshold) / margin).tanh());
                }
                out[ch].push(s.clamp(-1.0, 1.0));
            }
        }
        Ok(out)
    }
}
