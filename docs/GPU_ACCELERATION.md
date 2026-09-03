# GPU 가속 팩 (TensorRT)

MR 분리 속도를 **곡당 20~30분 → 약 30초**로 줄이는 선택 설치형 구성요소다.
NVIDIA GPU 전용이며, 없어도 앱은 기존대로 동작한다.

## 왜 필요했나 — 실측으로 드러난 원인

증상: RoFormer(RawWaveform) 모델로 58곡 분리에 12시간 이상. 그런데 로그에는
`Using: GPU (CUDA)`로 찍혔다. 같은 ONNX 런타임에서 MDX/Kim_Vocal_2 + DirectML은
곡당 18.5초였다 — 즉 "ONNX라서 느리다"는 전제부터 틀렸다.

원인은 세 겹이었다:

1. `ort` 크레이트 피처에 `cuda`가 없어 CUDA EP 등록이 실패했다.
2. **ort는 EP 등록 실패를 경고만 남기고 CPU로 계속 진행한다.** 그래서 실제로는
   CPU로 돌면서 로그는 계속 "GPU (CUDA)"라고 말했다. 이게 문제를 오래 숨겼다.
3. `cuda` 피처를 켜서 CUDA가 실제로 붙어도 **CPU보다 느렸다.** 이 모델 그래프는
   노드가 5118개인데 거의 융합되지 않아, 연산 자체가 아니라 커널 실행 오버헤드에
   묶여 있었다(GPU 사용률 7%, 41W/175W. 노드 실행 시간 합 5.0초 vs 실제 19.3초).

→ 런타임이 아니라 **그래프 융합**이 병목이었다. 그래서 TensorRT다.

## 실측 (RTX 2070 8GB, 모델 909MB, 입력 `[1, 2, 352800]` 정적)

| 경로 | 청크당 | 3분30초 곡 | 58곡 |
| :--- | ---: | ---: | ---: |
| 기존 앱 (CPU + Level1) | ~39,000ms | 20~30분 | **12시간+** |
| CPU (Level3) | 14,113ms | 8.2분 | ~8시간 |
| CUDA (cuDNN 있음) | 18,200ms | 10.6분 | 더 느림 |
| DirectML | 크래시 `887A0006` | — | — |
| **TensorRT** | **853ms** | **30초** | **~29분** |

정확도: CPU와 TensorRT의 출력 통계가 소수점 8자리까지 일치했다
(샘플 141만 개, mean=0.00027784 / rms=0.15003123).

## 구조

DLL이 전부 합쳐 약 3.8GB(압축 ~2.6GB)라 설치본에 넣을 수 없다. GitHub 릴리즈에
분할 zip으로 올려두고, 앱 설정 화면의 **다운로드** 버튼으로 받아 아래 위치에 푼다:

이 경로는 구버전에서 받은 수 GB 규모 런타임을 다시 내려받지 않도록 OSW에서도
의도적으로 유지하는 레거시 호환 공유 캐시다. 앱 데이터 루트와는 별개다.

```
%LOCALAPPDATA%\LiveMRManager\tools\gpu\      ← DLL
%LOCALAPPDATA%\LiveMRManager\tools\trt_cache\ ← 빌드된 엔진 캐시
```

`gpu_pack::install_gpu_pack()`이 매니페스트(파트 목록·sha256)를 읽어 각 파트를
스트리밍 다운로드→검증→압축해제한다. `gpu_pack::is_installed()`가 필수 DLL을
확인하고, 있을 때만 프로바이더 체인 맨 앞에 TensorRT를 넣는다. 없으면 기존
경로(DirectML/CUDA/CPU)로 그대로 간다.

### 팩 만들기·업로드 (관리자용)

`gpu-pack-v1` 릴리즈는 이미 올라가 있다(2026-08-05, 3파트 · 압축 합계 약 2.4GB).
아래는 팩 내용을 **바꿔서 다시 만들 때**의 절차다.

설치된 팩을 릴리즈용 파트로 묶는다:

```
python scripts/pack_gpu_pack.py \
  --src "%LOCALAPPDATA%/LiveMRManager/tools/gpu" \
  --out dist/gpu-pack \
  --base-url https://github.com/Temmis2077/OSW/releases/download/gpu-pack-v1
```

생성된 `gpu-pack-v1.part*.zip`과 `manifest.json`을 그 태그에 올린다:

```
gh release upload gpu-pack-v1 dist/gpu-pack/* --repo Temmis2077/OSW --clobber
```

주의할 점:

- **매니페스트 URL은 `gpu_pack.rs`의 `GPU_PACK_MANIFEST_URL`과 일치해야 한다.**
  팩 내용을 바꾸면 태그를 `gpu-pack-v2`로 올리고 코드의 상수도 함께 고친다.
- **릴리즈는 공개 상태여야 한다.** 초안(draft)이면 자산 다운로드 URL이 404다.
- 파트 이름은 `--base-url`의 태그를 따른다. 이름이 달라진 채 일부만 덮어쓰면
  매니페스트가 없는 파일을 가리키게 된다.
- 매니페스트에 **BOM이 붙으면 안 된다.** `serde_json`이 파싱에 실패해 앱에는
  "매니페스트 파싱 실패"만 뜬다(스크립트는 BOM 없이 쓴다).

올린 뒤 앱이 쓰는 경로 그대로 확인한다:

```
curl -sL <GPU_PACK_MANIFEST_URL> | python -m json.tool
```

### 필수 DLL

`nvinfer_10.dll`, `nvinfer_plugin_10.dll`, `nvonnxparser_10.dll`,
`nvinfer_builder_resource_10.dll`(1326MB), `cudnn64_9.dll`, `cublas64_12.dll`,
`cublasLt64_12.dll` — 및 이들의 의존 DLL(cudnn_* 하위 모듈, `cudart64_12.dll` 등).

## 함정: PATH로는 안 된다

ORT는 provider DLL을 `LoadLibraryEx`의 **제한된 검색 플래그**로 연다. 그래서
PATH에 팩 폴더를 넣어도 검색 대상에서 빠지고 `Error 126: cudnn64_9.dll missing`으로
실패한다. 그리고 ort가 그 실패를 삼켜 조용히 CPU로 떨어진다.

해결: `gpu_pack::register_dll_search_path()`가 앱 시작 시(**ORT를 처음 쓰기 전**)
Win32 `LoadLibraryExW`로 각 DLL을 **절대경로로 직접 선적재**한다
(`LOAD_WITH_ALTERED_SEARCH_PATH = 0x8`). 한 번 적재된 모듈은 같은 이름으로 다시
요청될 때 Windows가 재사용하므로, 이후 ORT의 provider DLL이 의존성을 정상 해결한다.

## 엔진 캐시

TensorRT 엔진은 **GPU 아키텍처별로 다르다**(RTX 2070 = `sm75`, 969MB). 첫 빌드에
약 150초 걸리고, 캐시가 맞으면 세션 로드가 12~17초로 줄어든다. 사용자가 GPU를
바꾸면 자동으로 다시 빌드된다.

## NVIDIA 런타임 재배포 근거

NVIDIA 표준 SLA/EULA가 런타임 `.dll` 재배포를 **허용**한다:

- **TensorRT SLA §8.2** — 런타임 `.so`/`.dll`은 배포 가능(단독 배포는 금지, 앱에 부속).
- **cuDNN SLA** — 동일한 런타임 배포 조항.
- **CUDA EULA Attachment A** — `cudart`, `cublas`, `cublasLt`, `cufft` 등을 재배포 목록에 명시.

조건: (1) 앱이 실질적 부가 기능을 제공할 것, (2) 배포 부분은 앱만 접근할 것,
(3) 고지 문구 포함, (4) 단독 배포 금지. 이 앱은 (1)(2)(4)를 이미 충족하며, (3)은
설치 시 팩 폴더에 `NVIDIA-NOTICE.txt`를 함께 쓰는 것으로 충족한다
(`gpu_pack::write_attribution_notice`).

> 참고: 더 가벼운 대안으로 **TensorRT-RTX**(런타임 199MB, cuDNN/cuBLAS 불필요)가 있다.
> 다만 pyke가 배포하는 prebuilt ORT의 `nv_tensorrt_rtx` 프로바이더가 풀 TensorRT
> (`nvinfer_10.dll`)에 링크돼 있어, 이를 쓰려면 ORT를 `--use_nv_tensorrt_rtx`로
> 커스텀 빌드해야 한다(별도 트랙, ToDo 참조).
