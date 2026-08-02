//! gpu_pack — 선택 설치형 GPU 가속 팩 (TensorRT + cuDNN/cuBLAS DLL).
//!
//! 배경: RoFormer(RawWaveform) 분리는 CPU에서 곡당 8~30분이 걸린다. DirectML은
//! 이 모델에서 GPU를 행에 빠뜨리고(887A0006), CUDA EP는 노드 5천여 개짜리
//! 미융합 그래프라 커널 실행 오버헤드에 묶여 CPU보다도 느리다. TensorRT가
//! 그래프를 융합하면 **청크당 14.1초 → 0.83초(약 17배)** 로 떨어진다(실측).
//!
//! 다만 TensorRT+cuDNN DLL은 전부 합쳐 ~3.8GB(압축 ~2.6GB)라 설치본에 넣을 수
//! 없다. 그래서 GitHub 릴리즈에 분할 zip으로 올려두고, 앱 안에서 버튼 하나로
//! 내려받아 레거시 호환 관리 경로인
//! `%LOCALAPPDATA%\LiveMRManager\tools\gpu\`에 풀어 넣는다(`install_gpu_pack`).
//! 팩이 없으면 기존 경로(CPU/DirectML)로 그대로 동작한다.
//!
//! NVIDIA 런타임 재배포 근거: TensorRT SLA §8.2 / cuDNN SLA / CUDA EULA Attachment A가
//! 런타임 .dll 재배포를 허용한다. 조건 중 하나가 고지 문구이므로, 설치 시 팩
//! 폴더에 NOTICE 파일을 함께 쓴다(`write_attribution_notice`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::ffmpeg_tools::tools_cache_dir;

/// 팩 파트(분할 zip)와 검증 정보를 담은 매니페스트의 위치.
///
/// 팩 원본은 ~3.8GB(압축 시 ~2.6GB)라 GitHub 릴리즈 에셋 1개(2GB 한도)에 담기지
/// 않는다. 그래서 1.8GB 미만 zip 여러 파트로 쪼개 올리고, 이 매니페스트가 파트
/// 목록·크기·sha256을 알려준다. 앱 릴리즈와 분리된 고정 태그(gpu-pack-v1)에 두어
/// 앱 재배포 없이 팩만 교체할 수 있게 한다.
const GPU_PACK_MANIFEST_URL: &str =
    "https://github.com/Temmis2077/OSW/releases/download/gpu-pack-v1/manifest.json";

/// 설치가 진행 중인지(동시 설치 방지).
static INSTALLING: AtomicBool = AtomicBool::new(false);
/// 사용자가 설치 취소를 요청했는지.
static INSTALL_CANCEL: AtomicBool = AtomicBool::new(false);

/// GPU 가속 팩 DLL이 놓이는 디렉터리.
pub fn gpu_pack_dir() -> PathBuf {
    tools_cache_dir().join("gpu")
}

/// TensorRT 엔진 캐시 위치. 엔진은 GPU 아키텍처별로 다르고 빌드에 수 분이
/// 걸리므로 재사용해야 한다(캐시 적중 시 세션 로드 150초 → 12초).
pub fn trt_engine_cache_dir() -> PathBuf {
    tools_cache_dir().join("trt_cache")
}

/// 팩 설치 여부 — TensorRT 코어와 cuDNN이 모두 있어야 의미가 있다.
/// (cuDNN이 없으면 onnxruntime_providers_cuda.dll 로딩이 Error 126으로 실패하고
///  ort가 이를 삼켜 조용히 CPU로 떨어진다 — 실제로 겪은 함정.)
pub fn is_installed() -> bool {
    let dir = gpu_pack_dir();
    required_dlls().iter().all(|f| dir.join(f).exists())
}

/// 팩이 갖춰야 하는 최소 DLL 목록.
pub fn required_dlls() -> &'static [&'static str] {
    &[
        "nvinfer_10.dll",
        "nvinfer_plugin_10.dll",
        "nvonnxparser_10.dll",
        "nvinfer_builder_resource_10.dll",
        "cudnn64_9.dll",
        "cublas64_12.dll",
        "cublasLt64_12.dll",
    ]
}

/// 설치돼 있지만 빠진 DLL 목록(진단용).
pub fn missing_dlls() -> Vec<String> {
    let dir = gpu_pack_dir();
    required_dlls()
        .iter()
        .filter(|f| !dir.join(f).exists())
        .map(|f| f.to_string())
        .collect()
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    extern "system" {
        pub fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        pub fn SetDllDirectoryW(path: *const u16) -> i32;
    }
    /// DLL의 의존성을 그 DLL이 있는 폴더에서도 찾게 한다.
    pub const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// GPU 팩 DLL을 이 프로세스에 미리 적재해 ORT가 찾을 수 있게 한다.
///
/// **PATH에 넣는 방식은 통하지 않는다** — ORT는 provider DLL을 LoadLibraryEx의
/// 제한된 검색 플래그로 열기 때문에 PATH가 검색 대상에서 빠지고, 결국
/// `Error 126: cudnn64_9.dll missing`으로 로딩이 실패한다(그리고 ort가 그 실패를
/// 삼켜 조용히 CPU로 떨어진다). 그래서 여기서는 의존 DLL을 **절대경로로 직접
/// 적재**한다. 한 번 로드된 모듈은 같은 이름으로 다시 요청될 때 Windows가
/// 재사용하므로, 이후 ORT의 provider DLL이 의존성을 정상 해결한다.
///
/// **ORT를 처음 쓰기 전에** 호출해야 한다.
pub fn register_dll_search_path() {
    let dir = gpu_pack_dir();
    if !dir.exists() {
        return;
    }

    #[cfg(windows)]
    {
        // 보조 수단: 일반 검색 경로에도 추가.
        let dir_w = win::wide(&dir.to_string_lossy());
        unsafe { win::SetDllDirectoryW(dir_w.as_ptr()) };

        // 의존성이 있는 것부터(cublas/cudnn → nvinfer) 절대경로로 적재.
        let mut loaded = 0usize;
        for name in required_dlls() {
            let path = dir.join(name);
            if !path.exists() {
                continue;
            }
            let path_w = win::wide(&path.to_string_lossy());
            let h = unsafe {
                win::LoadLibraryExW(path_w.as_ptr(), std::ptr::null_mut(), win::LOAD_WITH_ALTERED_SEARCH_PATH)
            };
            if h.is_null() {
                crate::audio_player::sys_log(&format!("[GPU-Pack] 적재 실패: {}", name));
            } else {
                loaded += 1;
            }
        }
        crate::audio_player::sys_log(&format!(
            "[GPU-Pack] DLL {}개 적재됨 ({})",
            loaded,
            dir.display()
        ));
    }
}

/// NVIDIA 재배포 조건(고지)을 충족하기 위한 NOTICE 파일을 팩 폴더에 쓴다.
fn write_attribution_notice(dir: &Path) {
    let notice = "\
This directory contains NVIDIA runtime libraries redistributed with OSW (Open Stem Wave).

This software contains source code provided by NVIDIA Corporation.

The included NVIDIA runtime files (TensorRT, cuDNN, cuBLAS, and CUDA runtime .dll files)
are redistributed under:
  - NVIDIA TensorRT Software License Agreement (SLA), Section 8.2
  - NVIDIA cuDNN Software License Agreement
  - NVIDIA CUDA Toolkit End User License Agreement, Attachment A

These files are provided solely for use by OSW (Open Stem Wave) and may not be
distributed in isolation.
";
    let _ = std::fs::write(dir.join("NVIDIA-NOTICE.txt"), notice);
}

/// 설치 진행 상황(프론트로 emit).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    /// "download" | "extract" | "verify" | "done" | "error" | "cancelled"
    phase: String,
    /// 전체 진행률 0..100 (다운로드 단계 기준).
    percent: f32,
    received_bytes: u64,
    total_bytes: u64,
    part_index: u32,
    part_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(serde::Deserialize)]
struct GpuPackManifest {
    parts: Vec<GpuPackPart>,
    /// 설치 후 존재해야 하는 DLL 목록(검증용). 비면 required_dlls()로 대체.
    #[serde(default)]
    dlls: Vec<String>,
}

#[derive(serde::Deserialize)]
struct GpuPackPart {
    url: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    sha256: Option<String>,
}

fn emit_progress(app: &tauri::AppHandle, p: InstallProgress) {
    use tauri::Emitter;
    let _ = app.emit("gpu-pack-install-progress", p);
}

/// 진행 중인 설치를 취소 요청한다(다음 청크 경계에서 중단).
#[tauri::command]
pub fn cancel_gpu_pack_install() {
    INSTALL_CANCEL.store(true, Ordering::SeqCst);
}

/// GPU 팩을 GitHub 릴리즈에서 내려받아 설치한다.
///
/// 매니페스트를 읽어 각 파트(분할 zip)를 임시 파일로 스트리밍 다운로드하고,
/// sha256을 검증한 뒤 팩 폴더에 풀어 넣는다. 3.8GB를 메모리에 담지 않도록
/// **파트마다 임시 파일에 흘려 쓰고**, 압축해제 후 즉시 지운다.
#[tauri::command]
pub async fn install_gpu_pack(app: tauri::AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("이미 GPU 팩 설치가 진행 중입니다.".to_string());
    }
    INSTALL_CANCEL.store(false, Ordering::SeqCst);

    let result = install_gpu_pack_inner(&app).await;

    INSTALLING.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => emit_progress(
            &app,
            InstallProgress {
                phase: "done".into(),
                percent: 100.0,
                received_bytes: 0,
                total_bytes: 0,
                part_index: 0,
                part_count: 0,
                message: None,
            },
        ),
        Err(e) => {
            let phase = if INSTALL_CANCEL.load(Ordering::SeqCst) { "cancelled" } else { "error" };
            emit_progress(
                &app,
                InstallProgress {
                    phase: phase.into(),
                    percent: 0.0,
                    received_bytes: 0,
                    total_bytes: 0,
                    part_index: 0,
                    part_count: 0,
                    message: Some(e.clone()),
                },
            );
        }
    }
    result
}

async fn install_gpu_pack_inner(app: &tauri::AppHandle) -> Result<(), String> {
    use futures::StreamExt;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let dir = gpu_pack_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    let tmp_dir = dir.join(".download");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("임시 폴더 생성 실패: {e}"))?;

    let client = reqwest::Client::builder()
        .user_agent("OSW")
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {e}"))?;

    // 1) 매니페스트.
    let manifest: GpuPackManifest = client
        .get(GPU_PACK_MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("매니페스트 요청 실패: {e}"))?
        .error_for_status()
        .map_err(|e| format!("매니페스트 응답 오류: {e}"))?
        .json()
        .await
        .map_err(|e| format!("매니페스트 파싱 실패: {e}"))?;

    if manifest.parts.is_empty() {
        return Err("매니페스트에 파트가 없습니다.".to_string());
    }

    let part_count = manifest.parts.len() as u32;
    // 전체 크기: 매니페스트에 size가 있으면 그 합, 없으면 파트별 Content-Length로 대체.
    let mut total_bytes: u64 = manifest.parts.iter().filter_map(|p| p.size).sum();
    let mut done_bytes: u64 = 0;

    for (idx, part) in manifest.parts.iter().enumerate() {
        if INSTALL_CANCEL.load(Ordering::SeqCst) {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err("사용자가 취소했습니다.".to_string());
        }

        let part_path = tmp_dir.join(format!("part_{idx}.zip"));
        let resp = client
            .get(&part.url)
            .send()
            .await
            .map_err(|e| format!("파트 {} 다운로드 실패: {e}", idx + 1))?
            .error_for_status()
            .map_err(|e| format!("파트 {} 응답 오류: {e}", idx + 1))?;

        if total_bytes == 0 {
            // size 미제공 시 Content-Length 합으로 대략 추정.
            total_bytes = resp.content_length().unwrap_or(0) * part_count as u64;
        }

        let mut file =
            std::fs::File::create(&part_path).map_err(|e| format!("임시 파일 생성 실패: {e}"))?;
        let mut hasher = Sha256::new();
        let mut stream = resp.bytes_stream();

        while let Some(item) = stream.next().await {
            if INSTALL_CANCEL.load(Ordering::SeqCst) {
                drop(file);
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err("사용자가 취소했습니다.".to_string());
            }
            let chunk = item.map_err(|e| format!("다운로드 중 오류: {e}"))?;
            file.write_all(&chunk).map_err(|e| format!("쓰기 오류: {e}"))?;
            hasher.update(&chunk);
            done_bytes += chunk.len() as u64;

            let percent = if total_bytes > 0 {
                (done_bytes as f64 / total_bytes as f64 * 100.0).min(100.0) as f32
            } else {
                0.0
            };
            emit_progress(
                app,
                InstallProgress {
                    phase: "download".into(),
                    percent,
                    received_bytes: done_bytes,
                    total_bytes,
                    part_index: idx as u32,
                    part_count,
                    message: None,
                },
            );
        }
        file.flush().map_err(|e| format!("flush 오류: {e}"))?;
        drop(file);

        // 2) sha256 검증(매니페스트에 있을 때만).
        if let Some(expected) = &part.sha256 {
            let got = hex_lower(&hasher.finalize());
            if !got.eq_ignore_ascii_case(expected) {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(format!(
                    "파트 {} 무결성 검증 실패(sha256 불일치). 다시 시도해 주세요.",
                    idx + 1
                ));
            }
        }

        // 3) 압축해제(블로킹 → 별도 스레드).
        emit_progress(
            app,
            InstallProgress {
                phase: "extract".into(),
                percent: if total_bytes > 0 {
                    (done_bytes as f64 / total_bytes as f64 * 100.0).min(100.0) as f32
                } else {
                    0.0
                },
                received_bytes: done_bytes,
                total_bytes,
                part_index: idx as u32,
                part_count,
                message: None,
            },
        );
        let dir_clone = dir.clone();
        let part_path_clone = part_path.clone();
        tokio::task::spawn_blocking(move || extract_zip_into(&part_path_clone, &dir_clone))
            .await
            .map_err(|e| format!("압축해제 작업 실패: {e}"))??;

        let _ = std::fs::remove_file(&part_path);
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);

    // 4) 최종 검증: 필요한 DLL이 모두 있는지.
    emit_progress(
        app,
        InstallProgress {
            phase: "verify".into(),
            percent: 100.0,
            received_bytes: total_bytes,
            total_bytes,
            part_index: part_count,
            part_count,
            message: None,
        },
    );
    let required: Vec<String> = if manifest.dlls.is_empty() {
        required_dlls().iter().map(|s| s.to_string()).collect()
    } else {
        manifest.dlls.clone()
    };
    let missing: Vec<String> = required
        .iter()
        .filter(|f| !dir.join(f).exists())
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(format!("설치 후 누락된 파일: {}", missing.join(", ")));
    }

    write_attribution_notice(&dir);

    // 새로 설치된 DLL을 이번 프로세스에서 바로 쓸 수 있게 적재.
    register_dll_search_path();
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// zip 파일을 대상 폴더에 푼다(경로 탈출 방지). DLL은 평면으로 두므로 파일명만 사용.
fn extract_zip_into(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("zip 열기 실패: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip 파싱 실패: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip 항목 오류: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        // 경로 탈출(zip slip) 방지: 파일명만 취한다.
        let raw = entry.name().replace('\\', "/");
        let base = match raw.rsplit('/').next() {
            Some(b) if !b.is_empty() => b,
            _ => continue,
        };
        let out_path = dest.join(base);
        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("파일 생성 실패: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("압축해제 쓰기 실패: {e}"))?;
    }
    Ok(())
}

/// 팩 상태 요약 (설정 화면 표시용).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuPackStatus {
    pub installed: bool,
    pub dir: String,
    pub missing: Vec<String>,
    /// 설치가 진행 중인지(UI 버튼 상태 복원용).
    pub installing: bool,
}

#[tauri::command]
pub fn get_gpu_pack_status() -> GpuPackStatus {
    GpuPackStatus {
        installed: is_installed(),
        dir: gpu_pack_dir().to_string_lossy().to_string(),
        missing: missing_dlls(),
        installing: INSTALLING.load(Ordering::SeqCst),
    }
}

/// 팩 디렉터리를 파일 탐색기로 연다 (수동 설치 안내용).
#[tauri::command]
pub fn open_gpu_pack_dir() -> Result<(), String> {
    let dir = gpu_pack_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_dir(&dir)
}

fn open_dir(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(dir)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
