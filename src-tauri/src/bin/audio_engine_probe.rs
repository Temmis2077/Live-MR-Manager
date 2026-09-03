//! Manual same-device probe for the current Rodio path (A) and a direct CPAL
//! fixed-block callback (B). It changes no settings and writes JSON to stdout.

use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rodio::{DeviceSinkBuilder, Player, Source};
use serde::Serialize;
use tauri_app_lib::audio_core::{AudioTelemetry, BlockGraph, SineStem, SoftClipNode};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    candidate: &'static str,
    device: String,
    sample_rate: u32,
    channels: u16,
    buffer_frames: Option<u32>,
    stems: usize,
    requested_seconds: u64,
    setup_millis: u128,
    wall_millis: u128,
    callback_count: Option<u64>,
    rendered_frames: Option<u64>,
    over_budget_callbacks: Option<u64>,
    max_callback_micros: Option<u64>,
    stream_errors: u64,
    limitation: Option<&'static str>,
}

struct MixedSineSource {
    phases: Vec<f32>,
    steps: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    channel: u16,
}

impl MixedSineSource {
    fn new(stems: usize, sample_rate: u32, channels: u16) -> Self {
        let stems = stems.max(1);
        Self {
            phases: vec![0.0; stems],
            steps: (0..stems)
                .map(|index| {
                    std::f32::consts::TAU * (110.0 + index as f32 * 55.0) / sample_rate as f32
                })
                .collect(),
            sample_rate,
            channels,
            channel: 0,
        }
    }
}

impl Iterator for MixedSineSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let gain = 0.5 / self.phases.len() as f32;
        let sample = self.phases.iter().map(|phase| phase.sin() * gain).sum();
        self.channel += 1;
        if self.channel >= self.channels {
            self.channel = 0;
            for (phase, step) in self.phases.iter_mut().zip(&self.steps) {
                *phase += *step;
                if *phase >= std::f32::consts::TAU {
                    *phase -= std::f32::consts::TAU;
                }
            }
        }
        Some(sample)
    }
}

impl Source for MixedSineSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> NonZeroU16 {
        NonZeroU16::new(self.channels).expect("channels")
    }
    fn sample_rate(&self) -> NonZeroU32 {
        NonZeroU32::new(self.sample_rate).expect("sample rate")
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

fn candidate_a(seconds: u64, stems: usize) -> Result<ProbeResult, String> {
    let setup = Instant::now();
    let sink = DeviceSinkBuilder::open_default_sink().map_err(|error| error.to_string())?;
    let config = sink.config();
    let sample_rate = u32::from(config.sample_rate());
    let channels = u16::from(config.channel_count());
    let buffer_frames = match config.buffer_size() {
        cpal::BufferSize::Fixed(frames) => Some(*frames),
        cpal::BufferSize::Default => None,
    };
    let device = cpal::default_host()
        .default_output_device()
        .and_then(|value| {
            value
                .description()
                .ok()
                .map(|description| description.name().to_string())
        })
        .unwrap_or_else(|| "default output".into());
    let player = Player::connect_new(&sink.mixer());
    let source = MixedSineSource::new(stems, sample_rate, channels)
        .take_duration(Duration::from_secs(seconds));
    player.append(source);
    let setup_millis = setup.elapsed().as_millis();
    let started = Instant::now();
    player.play();
    while !player.empty() {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(ProbeResult {
        candidate: "A-rodio",
        device,
        sample_rate,
        channels,
        buffer_frames,
        stems,
        requested_seconds: seconds,
        setup_millis,
        wall_millis: started.elapsed().as_millis(),
        callback_count: None,
        rendered_frames: None,
        over_budget_callbacks: None,
        max_callback_micros: None,
        stream_errors: 0,
        limitation: Some("Rodio does not expose device callback underruns; use listening and wall-clock drift alongside this result."),
    })
}

fn build_direct_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut graph: BlockGraph,
    telemetry: Arc<AudioTelemetry>,
    stream_errors: Arc<AtomicU64>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate;
    device
        .build_output_stream(
            config,
            move |output: &mut [f32], _info| {
                let started = Instant::now();
                let frames = output.len() / channels;
                let budget = Duration::from_secs_f64(frames as f64 / sample_rate as f64);
                graph.process(output, channels);
                telemetry.record_callback(started.elapsed(), budget, frames as u64);
            },
            move |_error| {
                stream_errors.fetch_add(1, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|error| error.to_string())
}

fn candidate_b(seconds: u64, stems: usize) -> Result<ProbeResult, String> {
    let setup = Instant::now();
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("default output device not found")?;
    let description = device.description().map_err(|error| error.to_string())?;
    let supported = device
        .default_output_config()
        .map_err(|error| error.to_string())?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels;
    let sample_rate = config.sample_rate;
    let buffer_frames = match config.buffer_size {
        cpal::BufferSize::Fixed(frames) => Some(frames),
        cpal::BufferSize::Default => None,
    };
    let mut graph = BlockGraph::new();
    for index in 0..stems.max(1) {
        graph.add_stem(SineStem::new(
            110.0 + index as f32 * 55.0,
            0.5 / stems.max(1) as f32,
            sample_rate,
        ));
    }
    graph.add_node(SoftClipNode::new(0.8));
    let telemetry = Arc::new(AudioTelemetry::default());
    let stream_errors = Arc::new(AtomicU64::new(0));
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_direct_stream(
            &device,
            &config,
            graph,
            telemetry.clone(),
            stream_errors.clone(),
        )?,
        _ => {
            return Err(format!(
                "direct probe currently requires an f32 device format, got {sample_format:?}"
            ))
        }
    };
    let setup_millis = setup.elapsed().as_millis();
    let started = Instant::now();
    stream.play().map_err(|error| error.to_string())?;
    std::thread::sleep(Duration::from_secs(seconds));
    stream.pause().map_err(|error| error.to_string())?;
    let snapshot = telemetry.snapshot();
    Ok(ProbeResult {
        candidate: "B-cpal-block",
        device: description.name().to_string(),
        sample_rate,
        channels,
        buffer_frames,
        stems,
        requested_seconds: seconds,
        setup_millis,
        wall_millis: started.elapsed().as_millis(),
        callback_count: Some(snapshot.callback_count),
        rendered_frames: Some(snapshot.rendered_frames),
        over_budget_callbacks: Some(snapshot.over_budget_callbacks),
        max_callback_micros: Some(snapshot.max_callback_micros),
        stream_errors: stream_errors.load(Ordering::Relaxed),
        limitation: Some("Input round-trip, exclusive WASAPI/ASIO, disconnect recovery, and audible dropouts require the manual device matrix."),
    })
}

fn arg_value(name: &str, default: u64) -> u64 {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let seconds = arg_value("--seconds", 5).clamp(1, 7_200);
    let stems = arg_value("--stems", 4).clamp(1, 64) as usize;
    let result = (|| -> Result<Vec<ProbeResult>, String> {
        Ok(vec![
            candidate_a(seconds, stems)?,
            candidate_b(seconds, stems)?,
        ])
    })();
    match result {
        Ok(results) => println!(
            "{}",
            serde_json::to_string_pretty(&results).expect("serialize probe")
        ),
        Err(error) => {
            eprintln!("audio probe failed: {error}");
            std::process::exit(1);
        }
    }
}
