use rodio::source::Source;
use cpal::Sample;
use rubato::{FftFixedIn, Resampler};
use ndarray::Array1;
use std::path::Path;
use std::io::BufReader;
use std::fs::File;

pub struct AudioProcessor {
    pub target_sample_rate: u32,
}

/// 트레잇 메소드 인식 문제를 해결하기 위한 제네릭 헬퍼 함수
fn convert_to_f32_vec<S>(source: S) -> Vec<f32> 
where 
    S: Source, 
    S::Item: Sample 
{
    source.map(|s: S::Item| s.to_sample::<f32>()).collect()
}

impl AudioProcessor {
    pub fn new() -> Self {
        Self {
            target_sample_rate: 16000,
        }
    }

    /// 다양한 오디오 파일을 로드하고 16kHz로 리샘플링 및 ZMUV 정규화된 Array1<f32>을 반환합니다.
    pub fn load_and_preprocess<P: AsRef<Path>>(&self, path: P) -> Result<Array1<f32>, String> {
        let file = File::open(path).map_err(|e| format!("파일을 열 수 없습니다: {}", e))?;
        let decoder = rodio::Decoder::new(BufReader::new(file))
            .map_err(|e| format!("오디오 디코딩 실패: {}", e))?;

        let source_sample_rate = decoder.sample_rate().get();
        let channels = decoder.channels().get() as usize;

        // 제네릭 헬퍼를 통해 안전하게 f32 변환 및 수집
        let samples = convert_to_f32_vec(decoder);

        // 다중 채널인 경우 모노로 믹싱
        let mut final_samples = if channels > 1 {
            samples
                .chunks_exact(channels)
                .map(|chunk: &[f32]| chunk.iter().sum::<f32>() / channels as f32)
                .collect::<Vec<f32>>()
        } else {
            samples
        };

        // 16kHz로 리샘플링
        if source_sample_rate != self.target_sample_rate {
            final_samples = self.resample(&final_samples, source_sample_rate, self.target_sample_rate)?;
        }

        // 전처리 필터 적용
        self.apply_high_pass(&mut final_samples, 80.0);
        self.apply_pre_emphasis(&mut final_samples, 0.97);
        self.apply_zmuv(&mut final_samples);

        Ok(Array1::from_vec(final_samples))
    }

    /// Alignment-quality VAD용: 음성 전처리(ZMUV/강조) 이전의 16 kHz mono를
    /// 반환한다. 분리 보컬의 짧은 RMS가 실제 무성 구간을 구분하는 보조 신호가
    /// 되므로, 진폭 정보를 없애는 ZMUV 전 단계가 필요하다.
    pub fn load_mono_resampled_raw<P: AsRef<Path>>(&self, path: P) -> Result<Vec<f32>, String> {
        let file = File::open(path).map_err(|e| format!("파일을 열 수 없습니다: {}", e))?;
        let decoder = rodio::Decoder::new(BufReader::new(file))
            .map_err(|e| format!("오디오 디코딩 실패: {}", e))?;
        let source_sample_rate = decoder.sample_rate().get();
        let channels = decoder.channels().get() as usize;
        let samples = convert_to_f32_vec(decoder);
        let mut mono = if channels > 1 {
            samples.chunks_exact(channels)
                .map(|chunk: &[f32]| chunk.iter().sum::<f32>() / channels as f32)
                .collect::<Vec<f32>>()
        } else {
            samples
        };
        if source_sample_rate != self.target_sample_rate {
            mono = self.resample(&mono, source_sample_rate, self.target_sample_rate)?;
        }
        Ok(mono)
    }

    /// 20ms 단위의 보컬 활동도(0~1). RMS의 90백분위에 대해 상대 임계값을
    /// 사용하므로, 곡별 마스터링 볼륨 차이에 덜 민감하다.
    pub fn vocal_activity_frames(&self, raw_samples: &[f32], frame_count: usize) -> Vec<f32> {
        if raw_samples.is_empty() || frame_count == 0 { return vec![0.0; frame_count]; }
        let samples_per_frame = (self.target_sample_rate as f32 * 0.020) as usize;
        let mut rms: Vec<f32> = raw_samples.chunks(samples_per_frame.max(1))
            .map(|chunk| (chunk.iter().map(|x| x * x).sum::<f32>() / chunk.len().max(1) as f32).sqrt())
            .collect();
        if rms.is_empty() { return vec![0.0; frame_count]; }
        let mut sorted = rms.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let p90 = sorted[((sorted.len() - 1) as f32 * 0.90).round() as usize].max(1e-5);
        let floor = (p90 * 0.08).max(0.0008);
        rms.iter_mut().for_each(|v| *v = ((*v - floor) / (p90 - floor).max(1e-5)).clamp(0.0, 1.0));
        (0..frame_count).map(|i| {
            let source = i * rms.len() / frame_count;
            rms[source.min(rms.len() - 1)]
        }).collect()
    }

    /// 시각화용 파형 데이터를 생성합니다.
    pub fn create_waveform_summary<P: AsRef<Path>>(&self, path: P, n_buckets: usize) -> Result<(Vec<(f32, f32)>, f32), String> {
        let file = File::open(path).map_err(|e| format!("파일을 열 수 없습니다: {}", e))?;
        let decoder = rodio::Decoder::new(BufReader::new(file))
            .map_err(|e| format!("오디오 디코딩 실패: {}", e))?;

        let sample_rate = decoder.sample_rate().get();
        let channels = decoder.channels().get() as usize;
        let total_duration = decoder.total_duration().unwrap_or(std::time::Duration::from_secs(0));
        let duration_sec = total_duration.as_secs_f32();
        
        let all_samples = convert_to_f32_vec(decoder);
        let mono_samples: Vec<f32> = if channels > 1 {
            all_samples.chunks_exact(channels).map(|c: &[f32]| c.iter().sum::<f32>() / channels as f32).collect()
        } else { all_samples };
        
        let dur = mono_samples.len() as f32 / sample_rate as f32;
        let spb = (mono_samples.len() / n_buckets).max(1);
        let mut pts = Vec::with_capacity(n_buckets);
        
        for i in 0..n_buckets {
            let start = i * spb;
            if start >= mono_samples.len() { break; }
            let end = (start + spb).min(mono_samples.len());
            let chunk = &mono_samples[start..end];
            let (mut min, mut max) = (0.0, 0.0);
            for &s in chunk { if s < min { min = s; } if s > max { max = s; } }
            pts.push((min, max));
        }

        // 정규화 (가장 큰 진폭을 기준으로 스케일링하여 시각화 최적화)
        let max_amp = pts.iter().map(|(min, max)| min.abs().max(max.abs())).fold(0.0f32, |a, b| a.max(b));
        if max_amp > 0.0 {
            for p in pts.iter_mut() {
                p.0 /= max_amp;
                p.1 /= max_amp;
            }
        }

        // 정규화 (가장 큰 진폭을 기준으로 스케일링하여 시각화 최적화)
        let max_amp = pts.iter().map(|(min, max)| min.abs().max(max.abs())).fold(0.0f32, |a, b| a.max(b));
        if max_amp > 0.0 {
            for p in pts.iter_mut() {
                p.0 /= max_amp;
                p.1 /= max_amp;
            }
        }

        Ok((pts, if duration_sec > 0.0 { duration_sec } else { dur }))
    }

    fn apply_zmuv(&self, samples: &mut [f32]) {
        if samples.is_empty() { return; }
        let n = samples.len() as f32;
        let mean = samples.iter().sum::<f32>() / n;
        let variance = samples.iter().map(|&x| (x - mean).powi(2)).sum::<f32>() / n;
        let std = (variance + 1e-7).sqrt();
        for x in samples.iter_mut() {
            *x = (*x - mean) / std;
        }
    }

    fn apply_high_pass(&self, samples: &mut [f32], cutoff: f32) {
        let dt = 1.0 / self.target_sample_rate as f32;
        let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff);
        let alpha = rc / (rc + dt);
        let mut prev_x = 0.0;
        let mut prev_y = 0.0;
        for x in samples.iter_mut() {
            let cur_x = *x;
            let cur_y = alpha * (prev_y + cur_x - prev_x);
            *x = cur_y;
            prev_x = cur_x;
            prev_y = cur_y;
        }
    }

    fn apply_pre_emphasis(&self, samples: &mut [f32], coefficient: f32) {
        if samples.len() < 2 { return; }
        for i in (1..samples.len()).rev() {
            samples[i] = samples[i] - coefficient * samples[i-1];
        }
        samples[0] = samples[0] * (1.0 - coefficient);
    }

    fn resample(&self, input: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>, String> {
        let chunk_size = 1024;
        let mut resampler = FftFixedIn::<f32>::new(
            from_rate as usize,
            to_rate as usize,
            chunk_size,
            1, 1,
        ).map_err(|e| format!("리샘플러 생성 실패: {}", e))?;

        let mut output = Vec::new();
        for chunk in input.chunks(chunk_size) {
            let mut padded = chunk.to_vec();
            if padded.len() < chunk_size {
                padded.resize(chunk_size, 0.0);
            }
            let waves_in = vec![padded];
            let waves_out = resampler.process(&waves_in, None).map_err(|e| format!("리샘플링 실패: {}", e))?;
            output.extend_from_slice(&waves_out[0]);
        }
        Ok(output)
    }

    pub fn get_mel_spectrogram(&self, samples: &[f32]) -> Vec<f32> {
        let n_fft = 400;
        let hop_length = 160;
        let n_mels = 80;
        let n_frames = samples.len() / hop_length;
        let mut mel_data = Vec::with_capacity(n_frames * n_mels);
        for f in 0..n_frames {
            let start = f * hop_length;
            if start + n_fft > samples.len() { break; }
            let mut windowed = vec![0.0; n_fft];
            for i in 0..n_fft {
                let multiplier = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n_fft - 1) as f32).cos());
                windowed[i] = samples[start + i] * multiplier;
            }
            let mut fft_mag = vec![0.0; n_fft / 2 + 1];
            for k in 0..fft_mag.len() {
                let (mut re, mut im) = (0.0, 0.0);
                for n in 0..n_fft {
                    let angle = 2.0 * std::f32::consts::PI * k as f32 * n as f32 / n_fft as f32;
                    re += windowed[n] * angle.cos();
                    im -= windowed[n] * angle.sin();
                }
                fft_mag[k] = (re * re + im * im).sqrt();
            }
            for m in 0..n_mels {
                let center_idx = ((n_fft / 2) as f32 * (m as f32 / n_mels as f32)) as usize;
                let energy = fft_mag.get(center_idx).cloned().unwrap_or(0.0);
                mel_data.push((energy + 1e-9).ln());
            }
        }
        mel_data
    }
}
