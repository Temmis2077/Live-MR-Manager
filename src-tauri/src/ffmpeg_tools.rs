//! ffmpeg discovery: managed cache, bundled tools, system PATH (where.exe on Windows).

use std::io::Cursor;
use std::path::{Path, PathBuf};

pub fn tools_cache_dir() -> PathBuf {
    if let Ok(base) = std::env::var("LOCALAPPDATA").or_else(|_| std::env::var("APPDATA")) {
        return Path::new(&base).join("LiveMRManager").join("tools");
    }
    std::env::temp_dir().join("live-mr-manager-tools")
}

pub fn managed_ffmpeg_path() -> PathBuf {
    tools_cache_dir().join("ffmpeg.exe")
}

fn ffmpeg_search_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![tools_cache_dir()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.join("resources").join("tools"));
            dirs.push(exe_dir.join("tools"));
        }
    }
    dirs
}

pub fn find_bundled_ffmpeg() -> Option<PathBuf> {
    for dir in ffmpeg_search_dirs() {
        let p = dir.join("ffmpeg.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[cfg(windows)]
pub fn find_system_ffmpeg() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("where.exe")
        .arg("ffmpeg")
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if output.status.success() {
        let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !p.is_empty() {
            return Some(PathBuf::from(p.lines().next().unwrap_or(&p)));
        }
    }
    None
}

#[cfg(not(windows))]
pub fn find_system_ffmpeg() -> Option<PathBuf> {
    let output = std::process::Command::new("which")
        .arg("ffmpeg")
        .output()
        .ok()?;
    if output.status.success() {
        let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// Sync lookup: managed cache → bundled → system PATH.
pub fn find_ffmpeg_executable() -> Option<PathBuf> {
    let managed = managed_ffmpeg_path();
    if managed.is_file() {
        return Some(managed);
    }
    if let Some(p) = find_bundled_ffmpeg() {
        return Some(p);
    }
    find_system_ffmpeg()
}

/// ffmpeg 정적 빌드 zip 소스(순서대로 시도). 단일 호스트 장애에 대비해
/// GitHub 호스팅인 BtbN 빌드를 폴백으로 둬, gyan.dev가 죽어도 설치가 되게 한다.
/// 두 빌드 모두 zip 안에 `.../bin/ffmpeg.exe` 구조라 추출 로직이 공용이다.
const FFMPEG_ZIP_URLS: &[&str] = &[
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
];

pub async fn ensure_managed_ffmpeg() -> Option<PathBuf> {
    let target = managed_ffmpeg_path();
    if target.is_file() {
        return Some(target);
    }
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    for url in FFMPEG_ZIP_URLS {
        if let Some(p) = try_extract_ffmpeg_from_zip(url, &target).await {
            return Some(p);
        }
    }
    None
}

/// 주어진 URL의 zip에서 ffmpeg 실행 파일만 추출해 `target`에 쓴다(성공 시 경로).
/// 다운로드·압축해제 어느 단계에서 실패해도 None을 돌려 다음 소스로 넘어간다.
async fn try_extract_ffmpeg_from_zip(url: &str, target: &Path) -> Option<PathBuf> {
    let response = reqwest::get(url).await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().replace('\\', "/").to_lowercase();
        if name.ends_with("/ffmpeg.exe") || name.ends_with("/ffmpeg") {
            let mut content = Vec::new();
            if std::io::Read::read_to_end(&mut entry, &mut content).is_err() {
                continue;
            }
            if std::fs::write(target, &content).is_err() {
                continue;
            }
            if target.is_file() {
                crate::audio_player::sys_log(&format!("[Tools] ffmpeg 설치 완료 (소스: {})", url));
                return Some(target.to_path_buf());
            }
        }
    }
    None
}

/// Directory for yt-dlp `--ffmpeg-location`.
pub async fn resolve_ffmpeg_dir() -> Option<PathBuf> {
    if let Some(p) = ensure_managed_ffmpeg().await {
        return p.parent().map(|d| d.to_path_buf());
    }
    if let Some(p) = find_bundled_ffmpeg() {
        return p.parent().map(|d| d.to_path_buf());
    }
    find_system_ffmpeg().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// Sync lookup with blocking managed download on a separate thread (safe inside Tokio workers).
pub fn find_ffmpeg_executable_or_download() -> Option<PathBuf> {
    if let Some(p) = find_ffmpeg_executable() {
        return Some(p);
    }
    std::thread::spawn(|| {
        tokio::runtime::Runtime::new()
            .ok()?
            .block_on(ensure_managed_ffmpeg())
    })
    .join()
    .ok()
    .flatten()
}
