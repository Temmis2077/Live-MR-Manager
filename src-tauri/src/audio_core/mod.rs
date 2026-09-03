//! UI-independent contracts for the incremental OSW audio-engine migration.
//!
//! Production playback still uses `audio_player`. This module establishes the
//! common contract and deterministic block processor used to compare that path
//! with a direct CPAL callback before any default-engine switch.

mod block_graph;
mod contracts;
mod telemetry;

pub use block_graph::{BlockGraph, GainNode, SineStem, SoftClipNode};
pub use contracts::{
    AudioClock, AudioEngine, AudioEngineError, AudioEngineResult, DeviceDescriptor, DeviceManager,
    DspNode, EngineState, InputBus, OutputBus, TrackGraph, Transport,
};
pub use telemetry::{AudioTelemetry, TelemetrySnapshot};
