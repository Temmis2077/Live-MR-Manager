# 🌊 OSW — Open Stem Wave

> 노래 방송과 연습을 위해 MR 분리, 가사 싱크, 라이브 재생, OBS 오버레이를 한 흐름으로 묶는 Windows 앱

[![Tauri 2.0](https://img.shields.io/badge/Tauri_2.0-FFC131?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

노래 방송을 준비하다 보면 음원 분리, 가사 찾기, 싱크 수정, 출력 장치와 OBS 설정이
각각 따로 움직입니다. OSW(Open Stem Wave)는 이 과정을 곡 추가부터 실제 라이브 화면까지
한곳에서 이어 주는 로컬 데스크톱 도구입니다.

## 현재 상태

OSW는 소수 외부 테스터를 위한 **독립 베타**입니다.

- 소스 버전: `1.0.0-beta.1`
- 지원 대상: Windows 10/11
- Windows 설치본: [GitHub Releases](https://github.com/Temmis2077/OSW/releases/tag/v1.0.0-beta.1)
- 자동 검증: 현재 스냅샷 결과는 [변경 기록](RELEASE_NOTES.md#현재-자동-검증에서-확인한-것)에 고정해 기록
- 확인이 더 필요한 것: 여러 오디오 장치 전환, OBS 환경별 연결, 다른 GPU 조합, 외부 OAuth 연동

기존 `v0.6.0-beta.1~6` 공개 설치본은 내려갔습니다. 당시 변경 내용과 태그 보존 정책은
[0.6 Legacy 기록](docs/RELEASE_HISTORY_0.6.md)에 정리했습니다.

## 현재 개발된 흐름

### 1. 곡을 찾고 준비하기

- 유튜브와 가사 출처를 함께 검색하고 곡 정보 자동 채우기
- LRCLIB 싱크 가사 가져오기와 언어권별 검색 우선순위
- 로컬 파일·다중 곡 추가, 장르·카테고리·가사 상태 관리
- MR 캐시 위치와 WAV/MP3 저장 형식 선택
- JSON 백업·복원과 CSV 가져오기·내보내기

### 2. 보컬과 MR 분리하기

- MIT 라이선스가 명시된 Mel-Band RoFormer Vocals 기본 분리
- 비상업·출처 미확인 모델은 사용자가 직접 등록하는 커스텀 모델로 분리
- 선택 설치형 NVIDIA TensorRT GPU 가속 팩
- 커스텀 ONNX 모델 카탈로그와 로컬 모델 등록
- 리드 보컬과 백킹 보컬을 나누는 실험적 karaoke 분리 경로
- 중단·실패 시 기존 결과를 보존하는 캐시와 임시 파일 처리

GPU 성능은 환경에 따라 크게 달라집니다. RTX 2070 8GB와 특정 RoFormer 모델로 측정한
기록은 [GPU 가속 문서](docs/GPU_ACCELERATION.md)에 있으며, 모든 GPU에서 같은 속도를
보장하는 수치는 아닙니다.

### 3. 가사를 자동으로 맞추고 직접 고치기

- 한국어·영어 CTC 강제정렬과 한/영 혼합 가사 처리
- 사용자가 고친 줄을 지키는 앵커 기반 재정렬
- 보컬 활동 구간 저장, 파형 음영 표시, 경계 스냅
- 붙어 있는 가사 블럭의 좌우 경계 편집과 키보드 재배치
- 정렬 결과의 신뢰도·출처 메타데이터·검토 필요 상태 저장
- 정렬 전용 디리버브와 실패 시 원본 보컬 폴백

AI 정렬은 완성본이 아니라 편집 가능한 초안을 만드는 기능입니다. 모델·음원·창법에 따라
오차가 남으며, 낮은 신뢰도 줄은 직접 확인해야 합니다.

### 4. 라이브에서 부르고 보여 주기

- 라이브 화면의 현재/다음 가사와 줄 내부 진행도 표시
- 재생 시계와 오버레이 시계를 공유하는 프레임 단위 가사 전환
- OBS 가사·곡 정보 오버레이의 표시 항목, 색, 외곽선, 그림자, 진행바, 프리셋
- 오버레이 타이밍 보정과 인앱 미리보기
- 보컬/MR 페이더, 음소거·솔로, 모니터/MR 출력 라우팅
- 메트로놈, 출력 지연 보정, 소프트 리미터

### 5. 앱을 실제로 다루기

- 첫 실행 온보딩과 라이브/녹음 모드 선택
- 전역 단축키 도움말과 화면 이동 기록
- 설정 하위 탭과 겹치는 모달·패널의 레이어 관리
- 앱 데이터와 설정을 포함한 백업 복원
- OSW 전용 데이터 경로와 독립적인 백업·복원

## 아직 배포 완료로 보지 않는 것

- `1.0.0-beta.1` Windows 설치본과 자동 업데이트 흐름
- 여러 실제 오디오 장치·가상 케이블에서의 장시간 라이브 안정성
- GPU별 TensorRT 설치·엔진 생성·폴백 실기기 검증
- 멜로밍 OAuth와 Companion 배포 환경의 실제 계약 검증
- karaoke 보컬 분리 모델의 품질·라이선스·배포 방식 확정
- 악기별 스템, 전용 믹서 화면, A-B 루프, 마이크 입력, VST 호스트

공개 예정 항목은 [로드맵](ToDo.md), 사용자·기여자 문서 전체는
[문서 안내](docs/README.md)를 참고하세요. 내부 운영·감사·실험 기록은 공개 저장소에
포함하지 않습니다.

## 처음 확인할 곳

- 설치 상태와 알려진 제한: 이 문서의 [현재 상태](#현재-상태)와 [변경 기록](RELEASE_NOTES.md)
- 개발 환경과 기여 절차: [기여 안내](CONTRIBUTING.md)
- 모델·GPU·권리·문제 해결: [문서 안내](docs/README.md)
- 로그: 앱의 `설정 → 정보 → 로그 폴더 열기`에서 실제 `app.log` 위치 열기
- 버그 제보: [GitHub Issues](https://github.com/Temmis2077/OSW/issues)

## 개발 실행

필요한 도구:

- Node.js LTS 18 이상
- Rust stable
- LLVM/libclang
- Visual Studio C++ Build Tools의 **C++를 사용한 데스크톱 개발** 워크로드

```powershell
npm.cmd install
npm.cmd run tauri dev
```

검사:

```powershell
npm.cmd test
cd src-tauri
cargo test --lib
```

배포 설치본에는 ONNX Runtime과 CUDA·TensorRT provider가 포함됩니다. NVIDIA
GPU 가속에는 설정에서 받는 별도 GPU 팩이 추가로 필요합니다. 소스 빌드 개발자는
[Windows ONNX Runtime 설정](docs/WINDOWS_ONNXRUNTIME_LOCAL_SETUP.md)을 참고하세요.

## 데이터와 호환성

- OSW 데이터: `%LOCALAPPDATA%\com.osw.desktop\`
- 관리형 도구 공유 캐시: `%LOCALAPPDATA%\LiveMRManager\tools\`

공유 캐시 경로는 기존 대용량 모델·GPU 런타임을 다시 받지 않기 위해 유지합니다. 이전 앱
데이터와 딥링크·OAuth 호환 범위는 [Legacy 호환 정책](docs/LEGACY_COMPATIBILITY.md)에
정리돼 있습니다.

## 라이선스와 출처

OSW는 [MIT 라이선스](LICENSE)로 배포합니다. 이 프로젝트는
[AutumnColor77/Live-MR-Manager](https://github.com/AutumnColor77/Live-MR-Manager)를
기반으로 출발했으며, 원 개발자의 저작권 표시는 MIT 조건에 따라 유지합니다.

AI 모델과 외부 도구는 각각의 라이선스를 따릅니다. 특히 일부 RoFormer 모델은
CC-BY-NC 계열이라 상업적 사용 전에 확인이 필요합니다. 전체 목록은
[서드파티 고지](docs/THIRD-PARTY.md)를 참고하세요.

모델 라이선스와 노래·가사·원본 음원의 권리는 서로 다릅니다. 확정된 배포 구성은
[서드파티 고지](docs/THIRD-PARTY.md), 방송·커버를 준비할 때의 확인표는
[방송·커버 권리 안내](docs/BROADCAST_AND_COVER_RIGHTS_GUIDE.md)를 참고하세요. 조사 중인
후보나 미확정 법률 판단은 공개 문서에 확정 사실처럼 싣지 않습니다.

## 참여와 지원

- [기여 안내](CONTRIBUTING.md)
- [보안 정책](SECURITY.md)
- [GitHub Issues](https://github.com/Temmis2077/OSW/issues)
- [FAQ](https://companion-six-kappa.vercel.app/faq)
- [문의 안내](https://companion-six-kappa.vercel.app/qa)
