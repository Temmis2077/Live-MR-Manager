use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub callback_count: u64,
    pub rendered_frames: u64,
    pub over_budget_callbacks: u64,
    pub max_callback_micros: u64,
}

#[derive(Default)]
pub struct AudioTelemetry {
    callback_count: AtomicU64,
    rendered_frames: AtomicU64,
    over_budget_callbacks: AtomicU64,
    max_callback_micros: AtomicU64,
}

impl AudioTelemetry {
    pub fn record_callback(&self, elapsed: Duration, budget: Duration, frames: u64) {
        let micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
        self.callback_count.fetch_add(1, Ordering::Relaxed);
        self.rendered_frames.fetch_add(frames, Ordering::Relaxed);
        if elapsed > budget {
            self.over_budget_callbacks.fetch_add(1, Ordering::Relaxed);
        }
        self.max_callback_micros
            .fetch_max(micros, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> TelemetrySnapshot {
        TelemetrySnapshot {
            callback_count: self.callback_count.load(Ordering::Relaxed),
            rendered_frames: self.rendered_frames.load(Ordering::Relaxed),
            over_budget_callbacks: self.over_budget_callbacks.load(Ordering::Relaxed),
            max_callback_micros: self.max_callback_micros.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_callback_budget_overruns() {
        let telemetry = AudioTelemetry::default();
        telemetry.record_callback(Duration::from_millis(3), Duration::from_millis(2), 128);
        let snapshot = telemetry.snapshot();
        assert_eq!(snapshot.callback_count, 1);
        assert_eq!(snapshot.rendered_frames, 128);
        assert_eq!(snapshot.over_budget_callbacks, 1);
        assert_eq!(snapshot.max_callback_micros, 3_000);
    }
}
