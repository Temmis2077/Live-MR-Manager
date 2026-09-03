use serde::Serialize;
use specta::Type;
use std::collections::BTreeMap;

/// Stable error contract crossing the Rust -> frontend boundary.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
    pub details: Option<BTreeMap<String, String>>,
}

impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable,
            details: None,
        }
    }

    pub fn recoverable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, true)
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details
            .get_or_insert_with(BTreeMap::new)
            .insert(key.into(), value.into());
        self
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_stable_frontend_shape() {
        let value = serde_json::to_value(
            ApiError::recoverable("audio.device.enumeration", "장치를 읽지 못했습니다")
                .with_detail("host", "wasapi"),
        )
        .unwrap();
        assert_eq!(value["code"], "audio.device.enumeration");
        assert_eq!(value["recoverable"], true);
        assert_eq!(value["details"]["host"], "wasapi");
    }
}
