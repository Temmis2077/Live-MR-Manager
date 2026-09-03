//! Custom AI separation models.
//!
//! Users can register additional ONNX separation models on top of the two
//! the built-in commercially usable model. Because the separation engine needs to
//! know the STFT/architecture parameters for a model — and those cannot be
//! reliably inferred for an arbitrary file — each custom model is tied to an
//! **architecture preset**. The preset supplies the concrete parameters the
//! engine uses at inference time (see `crate::vocal_remover::ModelParams`).

use serde::{Deserialize, Serialize};

use crate::vocal_remover::{EngineKind, ModelParams};

/// A selectable architecture preset. The user picks the one that matches the
/// ONNX model they are adding.
#[derive(Debug, Clone, Serialize)]
pub struct ArchPreset {
    /// Stable key stored in the DB, e.g. `"mdx_vocal"`.
    pub key: &'static str,
    /// Human-readable label shown in the UI.
    pub label: &'static str,
    /// Short description / hint for the UI.
    pub description: &'static str,
    /// Inference path: spectrogram (Rust STFT) or raw waveform (embedded STFT).
    pub engine: EngineKind,
    pub is_mdx: bool,
    pub is_roformer: bool,
    pub is_kara: bool,
    pub n_fft: usize,
    pub hop_length: usize,
    pub target_bins: usize,
    /// Whether the model's primary output is the instrumental (MR) stem.
    pub outputs_instrumental: bool,
    /// RawWaveform only: index of the vocal stem on the output `sources` axis.
    pub vocal_source_index: usize,
}

impl ArchPreset {
    pub fn to_params(&self) -> ModelParams {
        ModelParams {
            engine: self.engine,
            is_mdx: self.is_mdx,
            is_roformer: self.is_roformer,
            is_kara: self.is_kara,
            n_fft: self.n_fft,
            hop_length: self.hop_length,
            target_bins: self.target_bins,
            outputs_instrumental: self.outputs_instrumental,
            vocal_source_index: self.vocal_source_index,
        }
    }
}

/// The supported presets. Kept in sync with the built-in heuristics in
/// `vocal_remover::separate`.
pub const PRESETS: &[ArchPreset] = &[
    ArchPreset {
        key: "mdx_vocal",
        label: "MDX-Net (보컬 추출)",
        description: "Kim Vocal 2 계열. 보컬을 추출하는 MDX-Net ONNX 모델.",
        engine: EngineKind::Spectrogram,
        is_mdx: true,
        is_roformer: false,
        is_kara: false,
        n_fft: 7680,
        hop_length: 1024,
        target_bins: 3072,
        outputs_instrumental: false,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "mdx_inst",
        label: "MDX-Net (반주/MR 추출)",
        description: "UVR-MDX-NET-Inst 계열. 반주(MR)를 추출하는 MDX-Net ONNX 모델.",
        engine: EngineKind::Spectrogram,
        is_mdx: true,
        is_roformer: false,
        is_kara: false,
        n_fft: 7680,
        hop_length: 1024,
        target_bins: 3072,
        outputs_instrumental: true,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "mdx_kara",
        label: "MDX-Net KARA (2048 bins)",
        description: "KARA 2 계열. 4096 FFT / 2048 bins 구성의 MDX-Net 모델.",
        engine: EngineKind::Spectrogram,
        is_mdx: true,
        is_roformer: false,
        is_kara: true,
        n_fft: 4096,
        hop_length: 1024,
        target_bins: 2048,
        outputs_instrumental: true,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "roformer_vocal",
        label: "RoFormer (스펙트로그램 입력, 실험적)",
        description: "스펙트로그램을 입력받는 RoFormer 변형 ONNX. 일반적인 Mel-Band RoFormer는 아래 '파형 직접 입출력' 프리셋을 사용하세요.",
        engine: EngineKind::Spectrogram,
        is_mdx: false,
        is_roformer: true,
        is_kara: false,
        n_fft: 2048,
        hop_length: 512,
        target_bins: 1025,
        outputs_instrumental: false,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "melband_roformer",
        label: "Mel-Band RoFormer (파형 직접 입출력, GPU 권장)",
        description: "STFT 내장 ONNX (입력 [1,2,N] 파형 → 출력 [1,2,2,N] 소스, 보컬=source 0). smank/mel-band-roformer-vocals-onnx 등. GPU가 없으면 처리 시간이 매우 길어질 수 있습니다.",
        engine: EngineKind::RawWaveform,
        is_mdx: false,
        is_roformer: true,
        is_kara: false,
        // Spectrogram params are unused on the RawWaveform path; kept as
        // benign defaults.
        n_fft: 2048,
        hop_length: 512,
        target_bins: 1025,
        outputs_instrumental: false,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "melband_roformer_karaoke",
        label: "Mel-Band RoFormer Karaoke (리드/화음, 로컬 모델)",
        description: "통합 보컬을 리드 보컬과 화음/코러스로 나누는 2차 전용 ONNX 모델. 자동 다운로드하지 않으며 [1,2,N] → [1,2,2,N], 리드=source 0 구성이어야 합니다.",
        engine: EngineKind::RawWaveform,
        is_mdx: false,
        is_roformer: true,
        is_kara: true,
        n_fft: 2048,
        hop_length: 512,
        target_bins: 1025,
        outputs_instrumental: false,
        vocal_source_index: 0,
    },
];

pub fn is_harmony_preset(key: &str) -> bool {
    key == "melband_roformer_karaoke"
}

pub fn preset_by_key(key: &str) -> Option<&'static ArchPreset> {
    PRESETS.iter().find(|p| p.key == key)
}

/// A user-registered custom model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModel {
    /// Unique id, e.g. `"custom_1720000000000"`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Filename stored under the app's `models` directory.
    pub filename: String,
    /// Download URL (empty for models added from a local file).
    pub url: String,
    /// Architecture preset key.
    pub preset_key: String,
}

/// Create the CustomModels table if it does not exist. Called during DB init.
pub fn ensure_table(conn: &rusqlite::Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS CustomModels (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            filename TEXT NOT NULL,
            url TEXT NOT NULL DEFAULT '',
            preset_key TEXT NOT NULL
         );",
    )
    .ok();
}

pub fn list() -> Vec<CustomModel> {
    let db = crate::state::DB.lock();
    let mut stmt = match db.prepare("SELECT id, name, filename, url, preset_key FROM CustomModels ORDER BY name") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok(CustomModel {
            id: row.get(0)?,
            name: row.get(1)?,
            filename: row.get(2)?,
            url: row.get(3)?,
            preset_key: row.get(4)?,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn get(id: &str) -> Option<CustomModel> {
    let db = crate::state::DB.lock();
    db.query_row(
        "SELECT id, name, filename, url, preset_key FROM CustomModels WHERE id = ?",
        rusqlite::params![id],
        |row| {
            Ok(CustomModel {
                id: row.get(0)?,
                name: row.get(1)?,
                filename: row.get(2)?,
                url: row.get(3)?,
                preset_key: row.get(4)?,
            })
        },
    )
    .ok()
}

pub fn insert(model: &CustomModel) -> Result<(), String> {
    let db = crate::state::DB.lock();
    db.execute(
        "INSERT OR REPLACE INTO CustomModels (id, name, filename, url, preset_key) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![model.id, model.name, model.filename, model.url, model.preset_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(id: &str) -> Result<(), String> {
    let db = crate::state::DB.lock();
    db.execute("DELETE FROM CustomModels WHERE id = ?", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
