use ndarray::Array2;
use ort::session::Session;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// ONNX 런타임이 이 프로세스에서 더는 못 쓰게 됐는가.
///
/// ort는 내부에 전역 std Mutex를 두고 `.lock().unwrap()`으로 쓴다. 세션을 만드는
/// 도중 어딘가에서 패닉이 나면(예: GPU 프로바이더 등록 중 드라이버 문제) 그 락이
/// **poisoned**로 표시되고, 그 뒤로는 `Session::builder()`를 부르기만 해도
/// "Mutex poisoned"로 패닉한다 — 분리·디리버브·가사 정렬이 한꺼번에, 프로세스가
/// 살아 있는 내내 죽는다.
///
/// 되살릴 방법이 없으므로(락 소유자는 ort 내부다) 한 번 감지하면 래치를 걸고,
/// 이후 요청은 즉시 "재시작이 필요하다"고 알린다. 예전에는 이 상태에서 폴백
/// 모델을 하나씩 계속 시도하며 같은 패닉을 반복했고, 사용자에게는 의미를 알 수
/// 없는 "Mutex poisoned"만 보였다.
static ORT_RUNTIME_BROKEN: AtomicBool = AtomicBool::new(false);

pub const ORT_BROKEN_MSG: &str =
    "AI 엔진을 초기화하지 못했습니다. OSW에 포함된 ONNX Runtime 1.24를 불러오지 못했습니다. \
앱을 다시 시작해도 같으면 설치본을 다시 설치한 뒤 로그와 함께 알려 주세요.";

/// 설치본에 함께 들어 있는 정확한 ONNX Runtime을 다른 ORT API보다 먼저 고정한다.
/// Windows 검색 경로에 맡기면 System32의 구버전 DLL을 집을 수 있으므로 반드시
/// 실행 파일 옆의 DLL을 전체 경로로 연다.
pub fn initialize_bundled_runtime() -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("실행 파일 위치 확인 실패: {e}"))?;
        let runtime = exe
            .parent()
            .ok_or_else(|| "실행 파일 폴더를 확인할 수 없습니다.".to_string())?
            .join("onnxruntime.dll");

        if !runtime.is_file() {
            mark_ort_runtime_broken();
            return Err(format!("번들 런타임 누락: {}", runtime.display()));
        }

        let builder = ort::init_from(&runtime).map_err(|e| {
            mark_ort_runtime_broken();
            format!("번들 런타임 로드 실패({}): {e}", runtime.display())
        })?;
        if !builder.commit() {
            mark_ort_runtime_broken();
            return Err(format!("번들 런타임 초기화 거부: {}", runtime.display()));
        }
        crate::audio_player::sys_log(&format!(
            "[ONNX Runtime] bundled runtime selected: {}",
            runtime.display()
        ));
    }

    Ok(())
}

pub fn ort_runtime_broken() -> bool {
    ORT_RUNTIME_BROKEN.load(Ordering::SeqCst)
}

pub fn mark_ort_runtime_broken() {
    ORT_RUNTIME_BROKEN.store(true, Ordering::SeqCst);
}

/// 패닉 메시지가 "이 프로세스에서 ONNX 런타임은 끝났다"를 가리키면 래치를 건다.
///
/// 두 가지가 같은 사슬의 앞뒤다:
///  - "Failed to initialize ORT API" — 최초 원인. DLL 버전이 안 맞아 ort 초기화가
///    실패하며 패닉한다. 이 패닉이 ort의 전역 락을 오염시킨다.
///  - "Mutex poisoned" — 그 뒤로 `Session::builder()`를 부르기만 해도 나는 증상.
///
/// 증상만 잡으면 사용자에게 원인이 안 보이므로 최초 원인도 함께 본다.
pub fn note_possible_ort_poisoning(message: &str) -> bool {
    let fatal = message.contains("poisoned")
        || message.contains("Failed to initialize ORT API")
        || message.contains("is not available, only API versions");
    if fatal {
        mark_ort_runtime_broken();
        return true;
    }
    false
}

/// 패닉 페이로드에서 사람이 읽을 메시지를 꺼낸다.
fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "알 수 없는 오류".to_string()
}

pub struct OnnxEngine {
    session: Session,
}

impl OnnxEngine {
    pub fn new<P: AsRef<Path>>(model_path: P) -> Result<Self, String> {
        if ort_runtime_broken() {
            return Err(ORT_BROKEN_MSG.to_string());
        }
        let model_path = model_path.as_ref();
        // 세션 생성은 ort 내부에서 패닉할 수 있다(오염된 전역 락, 프로바이더 등록
        // 실패 등). 그대로 두면 호출한 태스크가 통째로 죽어 "스레드가 중단됐습니다"
        // 같은 알맹이 없는 오류만 남는다. 여기서 받아 원인을 판정한다.
        let built = catch_unwind(AssertUnwindSafe(|| {
            Session::builder()
                .map_err(|e| format!("세션 빌더 생성 실패: {}", e))?
                .commit_from_file(model_path)
                .map_err(|e| format!("모델 로드 실패: {}", e))
        }));

        let session = match built {
            Ok(res) => res?,
            Err(payload) => {
                let msg = panic_message(&payload);
                if note_possible_ort_poisoning(&msg) {
                    return Err(ORT_BROKEN_MSG.to_string());
                }
                return Err(format!("모델 로드 중 오류: {}", msg));
            }
        };

        Ok(Self { session })
    }

    pub fn run_inference<F>(&mut self, audio_data: &[f32], is_whisper: bool, mut progress_callback: F) -> Result<Array2<f32>, String> 
    where F: FnMut(f32) {
        let total_samples = audio_data.len();
        
        if is_whisper {
            // Whisper 전용 로직: 단일 30초 덩어리 혹은 멜-데이터 처리
            println!("🚀 [Engine B] Whisper Encoder 추론 시작");
            
            // audio_data가 이미 멜-스펙트로그램으로 변환되었다고 가정
            // shape: [1, 80, 3000]
            let n_mels = 80;
            let n_frames = 3000;
            let mut mel_vec = audio_data.to_vec();
            mel_vec.resize(n_mels * n_frames, 0.0);
            
            let input_value =
                ort::value::Value::from_array(([1usize, n_mels, n_frames], mel_vec))
                    .map_err(|e| format!("Whisper 입력 값 생성 실패: {}", e))?;

            let outputs = self.session.run(ort::inputs![input_value])
                .map_err(|e| format!("Whisper 추론 실패: {}", e))?;

            let tensor = outputs[0].try_extract_tensor::<f32>()
                .map_err(|e| format!("Whisper 출력 추출 실패: {}", e))?;

            let shape = tensor.0;
            let frames = shape[1];
            let hidden_dim = shape[2];
            let data = tensor.1;
            
            progress_callback(90.0);
            
            Ok(Array2::from_shape_vec(
                (frames as usize, hidden_dim as usize), 
                data[..frames as usize * hidden_dim as usize].to_vec()
            ).map_err(|e| format!("Whisper 결과 변환 실패: {}", e))?)
        } else {
            // 기존 Wav2Vec2/CTC 로직 (Engine A)
            let chunk_size = 16000 * 30;
            let mut all_logits = Vec::new();
            let total_chunks = (total_samples as f32 / chunk_size as f32).ceil() as usize;

            for (i, start) in (0..total_samples).step_by(chunk_size).enumerate() {
                // Forced-alignment inference is chunked into 30s windows and can
                // take a long time on a full song; check for a user cancellation
                // between chunks instead of only after the whole loop finishes,
                // otherwise "cancel" only takes effect once inference is already
                // complete (i.e. it does nothing useful).
                if crate::alignment::CANCEL_ALIGNMENT.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("작업이 사용자에 의해 취소되었습니다.".to_string());
                }

                let end = (start + chunk_size).min(total_samples);
                let chunk = &audio_data[start..end];
                let seq_len = chunk.len();
                let chunk_vec = chunk.to_vec();

                let input_value =
                    ort::value::Value::from_array(([1usize, seq_len], chunk_vec))
                        .map_err(|e| format!("청크 #{} 입력 값 생성 실패: {}", i + 1, e))?;

                let outputs = self.session.run(ort::inputs![input_value])
                    .map_err(|e| format!("추론 실행 실패: {}", e))?;

                let tensor = outputs[0].try_extract_tensor::<f32>()
                    .map_err(|e| format!("출력 텐서 추출 실패: {}", e))?;

                let shape = tensor.0;
                if shape.len() == 3 {
                    let frames = shape[1] as usize;
                    let vocab = shape[2] as usize;
                    let data: &[f32] = tensor.1;
                    
                    let mut array = Array2::from_shape_vec(
                        (frames, vocab),
                        data[..frames * vocab].to_vec(),
                    )
                    .map_err(|e| format!("출력 변환 실패: {}", e))?;

                    // Log-Softmax 적용
                    for mut row in array.axis_iter_mut(ndarray::Axis(0)) {
                        let max_val = row.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
                        let sum_exp = row.iter().map(|&x| (x - max_val).exp()).sum::<f32>();
                        let log_sum_exp = max_val + sum_exp.ln();
                        for x in row.iter_mut() {
                            *x = *x - log_sum_exp;
                        }
                    }
                    all_logits.push(array);
                }

                let progress = ((i + 1) as f32 / total_chunks as f32) * 90.0;
                progress_callback(progress);
            }

            let views: Vec<_> = all_logits.iter().map(|a| a.view()).collect();
            ndarray::concatenate(ndarray::Axis(0), &views)
                .map_err(|e| format!("결과 병합 실패: {}", e))
        }
    }
}
