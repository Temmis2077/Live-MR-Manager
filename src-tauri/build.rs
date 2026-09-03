fn main() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let env_path = manifest_dir.join(".env");

    let mut client_id: Option<String> = None;

    if env_path.is_file() {
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    let k = k.trim();
                    let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
                    if k == "MELOMING_CLIENT_ID" && !v.is_empty() {
                        client_id = Some(v);
                    }
                }
            }
        }
    }

    // CI/release: GitHub secret 등이 프로세스 env로 들어오면 우선
    if let Ok(v) = std::env::var("MELOMING_CLIENT_ID") {
        let v = v.trim();
        if !v.is_empty() {
            client_id = Some(v.to_string());
        }
    }

    // Client ID만 바이너리에 임베드. Secret은 절대 임베드하지 않음
    // (배포본은 Secret 없이 Companion /api/oauth/exchange·refresh 사용).
    if let Some(id) = client_id {
        println!("cargo:rustc-env=EMBEDDED_MELOMING_CLIENT_ID={id}");
    }

    println!("cargo:rerun-if-changed=.env");
    println!("cargo:rerun-if-env-changed=MELOMING_CLIENT_ID");
    copy_onnxruntime_next_to_exe();
    tauri_build::build()
}

/// onnxruntime.dll을 실행 파일 폴더로 복사한다.
///
/// 이걸 안 하면 Windows가 `onnxruntime.dll`을 찾을 때 실행 파일 폴더에 없으니
/// **System32의 것**을 집는다. Windows 11은 자체적으로 1.17 계열을 넣어 두는데,
/// 이 프로젝트는 ort `api-24`(= onnxruntime 1.24.x)를 쓴다. 버전이 안 맞으면
/// ort 초기화가 패닉하고, 그 패닉이 ort 전역 락을 오염시켜 그 뒤로는 분리·
/// 디리버브·가사 정렬이 전부 "Mutex poisoned"로 죽는다(프로세스가 끝날 때까지).
///
/// 실제로 관측된 오류:
///   The requested API version [24] is not available, only API versions [1, 17]
///   are supported in this build. Current ORT Version is: 1.17.1
///
/// 경로는 docs/WINDOWS_ONNXRUNTIME_LOCAL_SETUP.md가 안내하는 ORT_LIB_LOCATION을
/// 따른다. 없으면 조용히 넘어간다 — 정적 링크로 빌드하는 환경도 있기 때문이다.
fn copy_onnxruntime_next_to_exe() {
    println!("cargo:rerun-if-env-changed=ORT_LIB_LOCATION");
    if !cfg!(windows) {
        return;
    }
    let Ok(lib_dir) = std::env::var("ORT_LIB_LOCATION") else { return };
    let lib_dir = std::path::Path::new(&lib_dir);
    let src = lib_dir.join("onnxruntime.dll");
    if !src.is_file() {
        println!("cargo:warning=ORT_LIB_LOCATION에 onnxruntime.dll이 없습니다: {}", src.display());
        return;
    }

    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out → 네 단계 위가 실행 파일 폴더.
    let Ok(out_dir) = std::env::var("OUT_DIR") else { return };
    let Some(exe_dir) = std::path::Path::new(&out_dir).ancestors().nth(3) else { return };

    // 본체만 옮기면 안 된다. CUDA·TensorRT는 별도 provider DLL로 분리돼 있어서,
    // 본체만 있고 provider가 없으면 "execution provider is not enabled in this
    // build"로 조용히 CPU로 떨어진다.
    let dll_names = [
        "onnxruntime.dll",
        "onnxruntime_providers_shared.dll",
        "onnxruntime_providers_cuda.dll",
        "onnxruntime_providers_tensorrt.dll",
    ];
    let mut copied = Vec::new();
    for name in dll_names {
        let from = lib_dir.join(name);
        if !from.is_file() {
            continue;
        }
        let to = exe_dir.join(name);
        // 크기가 같으면 건너뛴다(증분 빌드마다 수백 MB 복사 방지).
        let same = std::fs::metadata(&from).ok().zip(std::fs::metadata(&to).ok())
            .map_or(false, |(a, b)| a.len() == b.len() && a.len() > 0);
        if same {
            copied.push(name);
            continue;
        }
        match std::fs::copy(&from, &to) {
            Ok(_) => copied.push(name),
            Err(e) => println!("cargo:warning={} 복사 실패({}): {}", name, to.display(), e),
        }
    }
    println!("cargo:warning=ONNX Runtime DLL 배치: {}", copied.join(", "));

    // CPU 전용 패키지를 잡으면 앱은 뜨지만 분리가 통째로 CPU로 돌아 곡당
    // 20~30분이 된다. 로그를 봐야만 알 수 있어서, 빌드 때 미리 알린다.
    if !lib_dir.join("onnxruntime_providers_cuda.dll").is_file() {
        println!(
            "cargo:warning=ORT_LIB_LOCATION이 CPU 전용 패키지입니다({}). \
GPU 분리를 쓰려면 onnxruntime-win-x64-gpu-1.24.x 패키지를 받아 그쪽을 가리키세요 \
— 지금 상태로는 TensorRT/CUDA가 'not enabled in this build'로 실패하고 CPU로 떨어집니다.",
            lib_dir.display()
        );
    }

    // 0바이트 provider 껍데기가 남아 있으면 로딩만 실패시킨다(다운로드 실패 잔해).
    for name in ["onnxruntime_providers_cuda.dll", "onnxruntime_providers_tensorrt.dll",
                 "onnxruntime_providers_shared.dll", "onnxruntime_providers_nv_tensorrt_rtx.dll"] {
        let p = exe_dir.join(name);
        if std::fs::metadata(&p).map_or(false, |m| m.len() == 0) {
            let _ = std::fs::remove_file(&p);
            println!("cargo:warning=0바이트 {} 제거", name);
        }
    }
}
