//! MR separation cache file names, format preference, and path resolution.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

pub const VOCAL_MP3: &str = "vocal.mp3";
pub const INST_MP3: &str = "inst.mp3";
pub const VOCAL_WAV: &str = "vocal.wav";
pub const INST_WAV: &str = "inst.wav";
pub const LEAD_VOCAL_MP3: &str = "lead_vocal.mp3";
pub const BACKING_VOCAL_MP3: &str = "backing_vocal.mp3";
pub const LEAD_VOCAL_WAV: &str = "lead_vocal.wav";
pub const BACKING_VOCAL_WAV: &str = "backing_vocal.wav";

const FORMAT_MP3: u8 = 0;
const FORMAT_WAV: u8 = 1;

/// Default: MP3 320 kbps (smaller/faster cache writes).
static MR_CACHE_FORMAT: AtomicU8 = AtomicU8::new(FORMAT_MP3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MrCacheFormat {
    Mp3,
    Wav,
}

impl MrCacheFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => "mp3",
            MrCacheFormat::Wav => "wav",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "mp3" => Some(Self::Mp3),
            "wav" => Some(Self::Wav),
            _ => None,
        }
    }

    pub fn vocal_filename(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => VOCAL_MP3,
            MrCacheFormat::Wav => VOCAL_WAV,
        }
    }

    pub fn inst_filename(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => INST_MP3,
            MrCacheFormat::Wav => INST_WAV,
        }
    }

    pub fn lead_vocal_filename(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => LEAD_VOCAL_MP3,
            MrCacheFormat::Wav => LEAD_VOCAL_WAV,
        }
    }

    pub fn backing_vocal_filename(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => BACKING_VOCAL_MP3,
            MrCacheFormat::Wav => BACKING_VOCAL_WAV,
        }
    }
}

pub fn current_format() -> MrCacheFormat {
    match MR_CACHE_FORMAT.load(Ordering::Relaxed) {
        FORMAT_WAV => MrCacheFormat::Wav,
        _ => MrCacheFormat::Mp3,
    }
}

pub fn set_format(s: &str) -> Result<(), String> {
    let format = MrCacheFormat::from_str(s)
        .ok_or_else(|| "지원하지 않는 MR 캐시 형식입니다 (mp3 또는 wav)".to_string())?;
    let code = match format {
        MrCacheFormat::Mp3 => FORMAT_MP3,
        MrCacheFormat::Wav => FORMAT_WAV,
    };
    MR_CACHE_FORMAT.store(code, Ordering::Relaxed);
    Ok(())
}

pub fn mr_output_paths_for(dir: &Path, format: MrCacheFormat) -> (PathBuf, PathBuf) {
    (
        dir.join(format.vocal_filename()),
        dir.join(format.inst_filename()),
    )
}

pub fn mr_output_paths(dir: &Path) -> (PathBuf, PathBuf) {
    mr_output_paths_for(dir, current_format())
}

pub fn harmony_output_paths_for(dir: &Path, format: MrCacheFormat) -> (PathBuf, PathBuf) {
    (
        dir.join(format.lead_vocal_filename()),
        dir.join(format.backing_vocal_filename()),
    )
}

fn mp3_pair_paths(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join(VOCAL_MP3), dir.join(INST_MP3))
}

fn wav_pair_paths(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join(VOCAL_WAV), dir.join(INST_WAV))
}

pub fn is_inst_stem_name(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), INST_MP3 | INST_WAV)
}

/// Prefer MP3 pair, then legacy WAV.
pub fn resolve_mr_pair(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let (v, i) = mp3_pair_paths(dir);
    if v.is_file() && i.is_file() {
        return Some((v, i));
    }
    let (v, i) = wav_pair_paths(dir);
    if v.is_file() && i.is_file() {
        return Some((v, i));
    }
    None
}

pub fn mr_pair_exists(dir: &Path) -> bool {
    resolve_mr_pair(dir).is_some()
}

pub fn resolve_vocal(dir: &Path) -> Option<PathBuf> {
    let mp3 = dir.join(VOCAL_MP3);
    if mp3.is_file() {
        return Some(mp3);
    }
    let wav = dir.join(VOCAL_WAV);
    if wav.is_file() {
        return Some(wav);
    }
    None
}

pub fn resolve_inst(dir: &Path) -> Option<PathBuf> {
    let mp3 = dir.join(INST_MP3);
    if mp3.is_file() {
        return Some(mp3);
    }
    let wav = dir.join(INST_WAV);
    if wav.is_file() {
        return Some(wav);
    }
    None
}

pub fn resolve_harmony_pair(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let metadata = read_valid_harmony_metadata(dir)?;
    for format in [MrCacheFormat::Mp3, MrCacheFormat::Wav] {
        let (lead, backing) = harmony_output_paths_for(dir, format);
        let lead_name = lead.file_name().and_then(|v| v.to_str());
        let backing_name = backing.file_name().and_then(|v| v.to_str());
        if lead.is_file() && backing.is_file()
            && metadata.0.as_deref() == lead_name
            && metadata.1.as_deref() == backing_name
        {
            return Some((lead, backing));
        }
    }
    None
}

fn read_valid_harmony_metadata(dir: &Path) -> Option<(Option<String>, Option<String>)> {
    let raw = std::fs::read_to_string(dir.join("separation_info.json")).ok()?;
    let info: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if info.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0) < 2 {
        return None;
    }
    let base = info.get("base")?;
    let harmony = info.get("harmony")?;
    if base.get("status").and_then(|v| v.as_str()) != Some("finished")
        || harmony.get("status").and_then(|v| v.as_str()) != Some("finished")
    {
        return None;
    }
    let lead_ratio = harmony.get("leadEnergyRatio").and_then(|v| v.as_f64())?;
    let backing_ratio = harmony.get("backingEnergyRatio").and_then(|v| v.as_f64())?;
    let reconstruction_error = harmony.get("reconstructionError").and_then(|v| v.as_f64())?;
    if !lead_ratio.is_finite() || !backing_ratio.is_finite() || !reconstruction_error.is_finite()
        || reconstruction_error > 0.25
        || (lead_ratio >= 0.90 && backing_ratio >= 0.90 && reconstruction_error > 0.15)
    {
        return None;
    }
    let base_vocal = base.get("vocalFile").and_then(|v| v.as_str())?;
    let resolved_base = resolve_vocal(dir)?;
    if !dir.join(base_vocal).is_file()
        || resolved_base.file_name().and_then(|v| v.to_str()) != Some(base_vocal)
    {
        return None;
    }
    Some((
        harmony.get("leadFile").and_then(|v| v.as_str()).map(str::to_owned),
        harmony.get("backingFile").and_then(|v| v.as_str()).map(str::to_owned),
    ))
}

pub fn has_harmony_artifacts(dir: &Path) -> bool {
    [LEAD_VOCAL_MP3, BACKING_VOCAL_MP3, LEAD_VOCAL_WAV, BACKING_VOCAL_WAV,
        "lead_vocal_dr.mp3", "lead_vocal_dr.wav"]
        .iter()
        .any(|name| dir.join(name).is_file())
}

pub fn delete_harmony_stems(dir: &Path) -> std::io::Result<()> {
    for name in [
        LEAD_VOCAL_MP3, BACKING_VOCAL_MP3, LEAD_VOCAL_WAV, BACKING_VOCAL_WAV,
        "lead_vocal_dr.mp3", "lead_vocal_dr.wav",
    ] {
        let path = dir.join(name);
        if path.is_file() { std::fs::remove_file(path)?; }
    }
    Ok(())
}

pub fn resolve_alignment_vocal(dir: &Path) -> Option<PathBuf> {
    if let Some((lead, _)) = resolve_harmony_pair(dir) {
        for name in ["lead_vocal_dr.wav", "lead_vocal_dr.mp3"] {
            let path = dir.join(name);
            if path.is_file() { return Some(path); }
        }
        return Some(lead);
    }
    resolve_vocal(dir)
}

pub fn delete_mr_stems(dir: &Path) -> std::io::Result<()> {
    delete_harmony_stems(dir)?;
    for name in [VOCAL_MP3, INST_MP3, VOCAL_WAV, INST_WAV] {
        let p = dir.join(name);
        if p.is_file() {
            std::fs::remove_file(p)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harmony_paths_follow_cache_format() {
        let dir = Path::new("C:/cache/song");
        let (lead, backing) = harmony_output_paths_for(dir, MrCacheFormat::Wav);
        assert_eq!(lead.file_name().unwrap(), LEAD_VOCAL_WAV);
        assert_eq!(backing.file_name().unwrap(), BACKING_VOCAL_WAV);
    }

    #[test]
    fn alignment_prefers_lead_over_combined_vocal() {
        let dir = std::env::temp_dir().join(format!("osw-harmony-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(VOCAL_WAV), b"vocal").unwrap();
        std::fs::write(dir.join(LEAD_VOCAL_WAV), b"lead").unwrap();
        std::fs::write(dir.join(BACKING_VOCAL_WAV), b"backing").unwrap();
        std::fs::write(dir.join("separation_info.json"), r#"{
            "schemaVersion":2,
            "base":{"status":"finished","vocalFile":"vocal.wav"},
            "harmony":{"status":"finished","leadFile":"lead_vocal.wav","backingFile":"backing_vocal.wav","leadEnergyRatio":0.92,"backingEnergyRatio":0.24,"reconstructionError":0.07}
        }"#).unwrap();
        assert_eq!(resolve_alignment_vocal(&dir).unwrap().file_name().unwrap(), LEAD_VOCAL_WAV);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_or_legacy_harmony_cache_falls_back_to_combined_vocal() {
        let dir = std::env::temp_dir().join(format!("osw-harmony-invalid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(VOCAL_WAV), b"vocal").unwrap();
        std::fs::write(dir.join(LEAD_VOCAL_WAV), b"lead").unwrap();
        std::fs::write(dir.join(BACKING_VOCAL_WAV), b"backing").unwrap();
        std::fs::write(dir.join("lead_vocal_dr.wav"), b"stale lead dr").unwrap();
        std::fs::write(dir.join("separation_info.json"), r#"{
            "schemaVersion":2,
            "base":{"status":"finished","vocalFile":"vocal.wav"},
            "harmony":{"status":"finished","leadFile":"lead_vocal.wav","backingFile":"backing_vocal.wav","leadEnergyRatio":0.999999,"backingEnergyRatio":0.999893,"reconstructionError":0.596871}
        }"#).unwrap();
        assert!(resolve_harmony_pair(&dir).is_none());
        assert_eq!(resolve_alignment_vocal(&dir).unwrap().file_name().unwrap(), VOCAL_WAV);

        std::fs::write(dir.join("separation_info.json"), r#"{"schemaVersion":1}"#).unwrap();
        assert!(resolve_harmony_pair(&dir).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn incomplete_harmony_pair_is_never_enabled() {
        let dir = std::env::temp_dir().join(format!("osw-harmony-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(VOCAL_WAV), b"vocal").unwrap();
        std::fs::write(dir.join(LEAD_VOCAL_WAV), b"lead").unwrap();
        std::fs::write(dir.join("separation_info.json"), r#"{
            "schemaVersion":2,
            "base":{"status":"finished","vocalFile":"vocal.wav"},
            "harmony":{"status":"finished","leadFile":"lead_vocal.wav","backingFile":"backing_vocal.wav","leadEnergyRatio":0.8,"backingEnergyRatio":0.2,"reconstructionError":0.05}
        }"#).unwrap();
        assert!(resolve_harmony_pair(&dir).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
