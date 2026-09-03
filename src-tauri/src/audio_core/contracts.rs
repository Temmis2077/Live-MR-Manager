use super::TelemetrySnapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineState {
    Stopped,
    Paused,
    Playing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceDescriptor {
    pub id: String,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AudioEngineError {
    #[error("audio device unavailable: {0}")]
    DeviceUnavailable(String),
    #[error("unsupported audio configuration: {0}")]
    UnsupportedConfiguration(String),
    #[error("audio stream failed: {0}")]
    Stream(String),
    #[error("invalid transport operation: {0}")]
    InvalidTransport(String),
}

pub type AudioEngineResult<T> = Result<T, AudioEngineError>;

pub trait AudioClock: Send + Sync {
    fn sample_position(&self) -> u64;
    fn sample_rate(&self) -> u32;
}

pub trait Transport: Send {
    fn state(&self) -> EngineState;
    fn play(&mut self) -> AudioEngineResult<()>;
    fn pause(&mut self) -> AudioEngineResult<()>;
    fn stop(&mut self) -> AudioEngineResult<()>;
    fn seek_samples(&mut self, position: u64) -> AudioEngineResult<()>;
    fn set_loop(&mut self, range: Option<(u64, u64)>) -> AudioEngineResult<()>;
}

pub trait DspNode: Send {
    /// Process an interleaved block. Implementations must not allocate or lock.
    fn process(&mut self, interleaved: &mut [f32], channels: usize);
}

pub trait TrackGraph: Send {
    /// Render exactly `frames * channels` samples into the supplied buffer.
    fn render(&mut self, output: &mut [f32], frames: usize, channels: usize);
}

pub trait InputBus: Send {
    fn push_input(&mut self, interleaved: &[f32], channels: usize);
}

pub trait OutputBus: Send {
    fn render_output(&mut self, output: &mut [f32], channels: usize);
}

pub trait DeviceManager: Send {
    fn output_devices(&self) -> AudioEngineResult<Vec<DeviceDescriptor>>;
    fn input_devices(&self) -> AudioEngineResult<Vec<DeviceDescriptor>>;
    fn select_output(&mut self, id: &str) -> AudioEngineResult<()>;
    fn select_input(&mut self, id: &str) -> AudioEngineResult<()>;
}

pub trait AudioEngine: Send {
    fn transport(&mut self) -> &mut dyn Transport;
    fn telemetry(&self) -> TelemetrySnapshot;
}
