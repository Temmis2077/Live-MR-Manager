# Windows 로컬 ONNX Runtime 설정

## 목적

Windows에서 `cargo test` 실행 중 `ort-sys`가 ONNX Runtime 바이너리를 자동으로 다운로드하다가 인증서 오류로 실패할 때, 공식 ONNX Runtime DLL을 로컬에서 직접 연결하는 방법을 기록한다.

확인된 오류는 다음과 같다.

```text
보안 패키지에 사용할 수 있는 인증서가 없습니다
(os error -2146893042)
```

이 오류는 애플리케이션이나 정렬 로직의 테스트 실패가 아니라, `ort-sys`의 HTTPS 다운로드 단계에서 Windows 인증서 검증이 실패한 것이다.

## 프로젝트 기준 버전

- Rust crate: `ort 2.0.0-rc.12`
- 활성 API 기능: `api-24`
- 대응 ONNX Runtime: `1.24.x`
- 검증에 사용한 버전: `1.24.1`, Windows x64 CPU

공식 배포 파일:

- 릴리스: <https://github.com/microsoft/onnxruntime/releases/tag/v1.24.1>
- 직접 다운로드: <https://github.com/microsoft/onnxruntime/releases/download/v1.24.1/onnxruntime-win-x64-1.24.1.zip>

## 파일 배치

공식 ZIP을 원하는 개발 도구 폴더에 압축 해제한다. 현재 확인한 패키지는 `lib` 폴더에 링크 라이브러리와 DLL이 함께 들어 있다.

```text
E:\tools\onnxruntime-win-x64-1.24.1\
└─ lib\
   ├─ onnxruntime.lib
   └─ onnxruntime.dll
```

파일 존재 여부를 확인한다.

```powershell
$ortDir = "E:\tools\onnxruntime-win-x64-1.24.1\lib"

Test-Path "$ortDir\onnxruntime.lib"
Test-Path "$ortDir\onnxruntime.dll"
```

두 결과가 모두 `True`여야 한다.

## 현재 PowerShell 세션에서 사용

```powershell
$ortDir = "E:\tools\onnxruntime-win-x64-1.24.1\lib"

$env:ORT_LIB_LOCATION = $ortDir
$env:ORT_PREFER_DYNAMIC_LINK = "1"
$env:PATH = "$ortDir;$env:PATH"

Set-Location E:\ai\Live_Mr\src-tauri
cargo test
```

환경변수의 역할은 다음과 같다.

- `ORT_LIB_LOCATION`: 빌드 시 `onnxruntime.lib`를 찾는 경로
- `ORT_PREFER_DYNAMIC_LINK=1`: 정적 링크 대신 DLL 링크 사용
- `PATH`: 테스트 실행 시 `onnxruntime.dll`을 찾는 경로

위 설정은 현재 PowerShell 프로세스에서만 유지된다.

## 사용자 환경변수로 영구 등록

필요한 경우 다음 두 값을 사용자 환경변수로 등록한다.

```powershell
[Environment]::SetEnvironmentVariable(
    "ORT_LIB_LOCATION",
    "E:\tools\onnxruntime-win-x64-1.24.1\lib",
    "User"
)

[Environment]::SetEnvironmentVariable(
    "ORT_PREFER_DYNAMIC_LINK",
    "1",
    "User"
)
```

사용자 `PATH`에도 다음 경로를 추가한다.

```text
E:\tools\onnxruntime-win-x64-1.24.1\lib
```

환경변수를 영구 등록한 뒤에는 새 PowerShell 창을 열어야 반영된다.

## 검증 결과

2026-08-01에 위 구성으로 확인한 결과:

- `cargo test` 컴파일 성공
- Rust 단위 테스트 88개 통과
- 실패 0개
- 문서 테스트 통과
- `onnxruntime.lib` 확인 성공
- `onnxruntime.dll` 확인 성공

## 주의사항

- `ORT_LIB_LOCATION`은 ONNX Runtime 최상위 폴더가 아니라 `onnxruntime.lib`가 실제로 있는 폴더를 가리켜야 한다.
- `onnxruntime.dll`이 같은 폴더에 있다면 해당 `lib` 폴더를 `PATH`에도 추가한다.
- 다른 ONNX Runtime 버전을 사용할 경우 프로젝트의 `api-*` 기능과 런타임 API 버전 호환성을 확인한다.
- CUDA 또는 TensorRT 실행 공급자를 실제로 테스트하려면 CPU DLL 외에 호환되는 CUDA, cuDNN, TensorRT 및 공급자 DLL 구성이 추가로 필요하다.
- PC별 절대경로이므로 이 경로를 공유 설정 파일에 고정하기보다는 개발자별 환경변수로 관리하는 편이 안전하다.
