//! bench_ep — 분리 모델의 실행 provider별 추론 속도 실측.
//!
//! 배경: RoFormer(RawWaveform) 분리가 곡당 20~30분 걸리는데, 로그에는
//! "GPU (CUDA)"로 찍힌다. 그런데 ort 피처에 `cuda`가 없어 CUDA EP 등록이
//! 조용히 실패하고 CPU로 떨어지는 것으로 의심된다(ort는 EP 등록 실패를
//! 경고만 남기고 계속 진행). 같은 런타임에서 MDX/DirectML은 곡당 18.5초다.
//!
//! 이 벤치는 EP를 명시적으로 하나만 등록해 실제 추론 시간을 잰다.
//!
//! 실행:
//!   cargo run --example bench_ep -- <model.onnx> <directml|cpu|cuda> [iters]

use std::time::Instant;

use ort::ep::ExecutionProvider; // is_available()
use ort::execution_providers::{
    CPUExecutionProvider, CUDAExecutionProvider, DirectMLExecutionProvider,
    TensorRTExecutionProvider,
};
use ort::session::Session;
use ort::value::{Tensor, ValueType};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: bench_ep <model.onnx> <directml|cpu|cuda> [iters]");
        std::process::exit(2);
    }
    let model_path = &args[1];
    let ep_name = args[2].to_lowercase();
    let iters: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3);

    println!("model = {}", model_path);
    println!("ep    = {}", ep_name);

    // 앱의 gpu_pack::register_dll_search_path()와 동일한 로직을 인라인 재현.
    // (앱 lib 전체를 링크하면 Tauri/WebView2 DLL까지 끌어와 벤치가 뜨지 않는다)
    // PATH 방식은 통하지 않는다 — 의존 DLL을 절대경로로 직접 적재해야 한다.
    #[cfg(windows)]
    {
        extern "system" {
            fn LoadLibraryExW(name: *const u16, file: *mut std::ffi::c_void, flags: u32) -> *mut std::ffi::c_void;
            fn SetDllDirectoryW(path: *const u16) -> i32;
        }
        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }
        let base = std::env::var("LOCALAPPDATA").unwrap_or_default();
        // 앱과 동일한 레거시 호환 공유 캐시. 기존 수 GB GPU 팩을 재사용한다.
        let dir = std::path::Path::new(&base).join("LiveMRManager").join("tools").join("gpu");
        if dir.exists() {
            unsafe { SetDllDirectoryW(wide(&dir.to_string_lossy()).as_ptr()) };
            let mut n = 0;
            for name in [
                "cublas64_12.dll", "cublasLt64_12.dll", "cudnn64_9.dll",
                "nvinfer_10.dll", "nvinfer_plugin_10.dll", "nvonnxparser_10.dll",
                "nvinfer_builder_resource_10.dll",
            ] {
                let p = dir.join(name);
                if !p.exists() { continue; }
                let h = unsafe { LoadLibraryExW(wide(&p.to_string_lossy()).as_ptr(), std::ptr::null_mut(), 0x8) };
                if !h.is_null() { n += 1; }
            }
            println!("gpu pack: {} DLL 선적재 ({})", n, dir.display());
        } else {
            println!("gpu pack 없음: {}", dir.display());
        }
    }

    let mut builder = Session::builder()?;

    // EP를 하나만 등록한다. ort는 등록 실패를 치명적으로 보지 않으므로
    // (그게 바로 이 앱이 CPU로 조용히 떨어진 이유) 아래에서 is_available()로
    // 실제 가용 여부를 먼저 찍어 거짓말을 걸러낸다.
    match ep_name.as_str() {
        "directml" => {
            println!(
                "DirectML available = {}",
                DirectMLExecutionProvider::default().is_available().unwrap_or(false)
            );
            builder = builder.with_execution_providers([DirectMLExecutionProvider::default().build()])?;
        }
        "cuda" => {
            println!(
                "CUDA available = {}",
                CUDAExecutionProvider::default().is_available().unwrap_or(false)
            );
            // error_on_failure(): ort의 기본 동작은 EP 등록 실패 시 경고만 남기고
            // CPU로 계속 진행하는 것이라, 실패가 눈에 안 보인다. 여기서는 실패를
            // 오류로 올려 진짜 원인을 드러낸다.
            builder = builder.with_execution_providers([CUDAExecutionProvider::default()
                .with_device_id(0)
                .build()
                .error_on_failure()])?;
        }
        "tensorrt" => {
            // TensorRT는 그래프를 공격적으로 융합한다 — 이 모델의 병목인
            // "노드 5118개 커널 실행 오버헤드"를 정면으로 겨냥한다.
            // 엔진 빌드는 첫 실행에 수 분 걸리므로 캐시를 켠다.
            println!(
                "TensorRT available = {}",
                TensorRTExecutionProvider::default().is_available().unwrap_or(false)
            );
            let cache_dir = std::env::temp_dir().join("trt_cache");
            std::fs::create_dir_all(&cache_dir).ok();
            println!("TRT engine cache: {:?}", cache_dir);
            builder = builder.with_execution_providers([TensorRTExecutionProvider::default()
                .with_device_id(0)
                .with_engine_cache(true)
                .with_engine_cache_path(cache_dir.to_string_lossy().as_ref())
                .with_fp16(std::env::var("TRT_FP16").is_ok())
                .build()
                .error_on_failure()])?;
        }
        _ => {
            builder = builder.with_execution_providers([CPUExecutionProvider::default().build()])?;
        }
    }

    // 프로파일링: 노드가 실제로 어느 EP에 배치됐는지 알아내려면 이것뿐이다.
    // (EP 등록 성공 ≠ 연산이 GPU에서 돎 — 지원 안 되는 op는 노드별로 CPU 폴백)
    if std::env::var("BENCH_PROFILE").is_ok() {
        builder = builder.with_profiling("bench_profile")?;
    }

    let load_started = Instant::now();
    let mut session = builder.commit_from_file(model_path)?;
    println!("session load: {:?}", load_started.elapsed());

    // 입력 shape를 모델에서 그대로 읽는다 (이 모델은 [1, 2, 352800] 정적).
    let shape: Vec<i64> = match session.inputs()[0].dtype() {
        ValueType::Tensor { shape, .. } => shape.iter().map(|d| if *d > 0 { *d } else { 1 }).collect(),
        _ => return Err("unexpected input type".into()),
    };
    let input_name = session.inputs()[0].name().to_string();
    println!("input {} shape = {:?}", input_name, shape);

    let numel: usize = shape.iter().map(|d| *d as usize).product();
    // 무음이 아닌 신호로 채운다 — 0만 넣으면 일부 커널이 빨리 끝날 수 있다.
    let data: Vec<f32> = (0..numel)
        .map(|i| ((i as f32) * 0.001).sin() * 0.3)
        .collect();

    // 정확도 검증용: 출력 통계를 파일로 남겨 EP 간 비교(품질 저하 감지).
    if let Ok(dump) = std::env::var("BENCH_DUMP") {
        let t = Tensor::from_array((shape.clone(), data.clone()))?;
        let outs = session.run(ort::inputs![input_name.as_str() => t])?;
        let (_, out) = outs[0].try_extract_tensor::<f32>()?;
        let sum: f64 = out.iter().map(|v| *v as f64).sum();
        let sumsq: f64 = out.iter().map(|v| (*v as f64) * (*v as f64)).sum();
        let n = out.len();
        let mean = sum / n as f64;
        let rms = (sumsq / n as f64).sqrt();
        // 앞부분 샘플을 그대로 저장해 EP 간 정밀 비교에 쓴다.
        let head: Vec<String> = out.iter().take(2000).map(|v| format!("{:.6}", v)).collect();
        std::fs::write(&dump, format!("n={}\nmean={:.8}\nrms={:.8}\n{}", n, mean, rms, head.join(",")))?;
        println!("dumped stats → {} (n={}, mean={:.6}, rms={:.6})", dump, n, mean, rms);
        return Ok(());
    }

    println!("--- warmup ---");
    {
        let t = Tensor::from_array((shape.clone(), data.clone()))?;
        let started = Instant::now();
        let _ = session.run(ort::inputs![input_name.as_str() => t])?;
        println!("warmup (첫 실행은 커널 컴파일 포함): {:?}", started.elapsed());
    }

    println!("--- {} iters ---", iters);
    let mut total = std::time::Duration::ZERO;
    for i in 0..iters {
        let t = Tensor::from_array((shape.clone(), data.clone()))?;
        let started = Instant::now();
        let _ = session.run(ort::inputs![input_name.as_str() => t])?;
        let el = started.elapsed();
        total += el;
        println!("  iter {}: {:?}", i + 1, el);
    }

    let avg = total / iters as u32;
    println!();
    println!("평균: {:?} / chunk (8초 오디오)", avg);
    // 8초 청크, 25% 오버랩 → 6초 스텝. 3분30초 곡 ≈ 35 chunks.
    println!("→ 3분30초 곡 예상(35 chunks): {:?}", avg * 35);
    Ok(())
}
