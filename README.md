#  OSW — Open Stem Wave

> 노래 방송과 연습을 위한 로컬 AI 스템 분리·가사 싱크·OBS 연동 Windows 앱

[![Tauri 2.0](https://img.shields.io/badge/Tauri_2.0-FFC131?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

OSW(Open Stem Wave)는 유튜브·로컬 곡을 보컬과 MR로 분리하고, 가사를 자동으로
맞춘 뒤 재생과 OBS 오버레이까지 이어 주는 데스크톱 앱입니다. 노래 방송에서
곡마다 음원·가사·출력을 따로 준비하는 흐름을 한곳에 모으는 것이 첫 목표예요.

## 현재 상태

OSW는 **독립 베타를 준비 중인 개발 버전**입니다. 저장소의 코드는 OSW 이름과
별도 앱 식별자·업데이트 경로를 사용하지만, 아직 OSW 이름의 독립 설치본은
GitHub Releases에 공개되지 않았습니다.

현재 Releases의 `v0.6.0-beta.*` 설치본은 독립 전환 이전의 **Legacy 빌드**입니다.
새 설치를 권장할 수 있는 OSW 빌드가 올라오면 이 안내와 다운로드 링크를 함께
갱신합니다.

- 개발 대상: Windows 10/11
- 코드 버전: `1.0.0-beta.1`
- 공개 배포 상태: OSW 독립 설치본 준비 중
- 이슈·기능 제안: [GitHub Issues](https://github.com/Temmis2077/OSW/issues)

## 지금 구현된 기능

### 곡 준비와 라이브러리

- 유튜브·가사 사이트 통합 검색과 로컬 파일 추가
- 보컬/MR 분리, 곡 정보·장르·카테고리 관리
- 분리·가사 정렬 대기열 저장 및 앱 재시작 후 복원
- CSV 가져오기·내보내기와 JSON 백업·복원

### AI 가사 싱크

- 한국어·영어 CTC 강제정렬과 한/영 혼합곡 병합
- 사용자가 맞춘 줄을 보존하는 앵커 기반 구간 정렬
- 낮은 신뢰도 줄 표시와 길이 타당성 검사
- 원문·차음·번역 3줄 가사, 보컬 시작·간주 마커
- 정렬 전용 디리버브: 모델이나 GPU 팩이 없으면 원본 보컬로 계속 진행

### 재생과 방송

- 재생 중 출력 장치 전환, 보컬/MR 페이더, 음소거·솔로
- 모니터/MR 이중 출력과 소스별 라우팅
- 메트로놈, 버스별 지연 보정, 출력 리미터
- 인앱 가사창과 OBS 가사 오버레이

## 실험적이거나 제한적인 기능

- **TensorRT GPU 가속 팩**은 선택 기능이며 NVIDIA GPU에서만 동작합니다. RTX 2070
  8GB와 특정 RoFormer 모델·3분 30초 곡으로 측정했을 때 약 30초였고, GPU·모델·곡
  길이에 따라 결과가 달라집니다. 구조와 전체 측정값은
  [GPU 가속 문서](docs/GPU_ACCELERATION.md)에 있습니다.
- **멜로밍 노래책 연동**은 외부 서비스 계약과 OAuth 설정의 영향을 받습니다.
  릴리스 전 실제 배포 환경에서 다시 확인해야 합니다.
- **믹서·라우팅 백엔드**는 구현돼 있지만 전용 믹서 화면은 아직 공개하지 않았습니다.

## 다운로드와 실행

### 공개 설치본

[GitHub Releases](https://github.com/Temmis2077/OSW/releases)에는 현재 Legacy 빌드와
모델 자산만 있습니다. OSW 독립 설치본이 게시되기 전까지는 개발 실행을 기준으로
기능을 확인해 주세요.

### 개발 환경

필요한 도구:

- Windows 10/11
- [Node.js LTS](https://nodejs.org/) 18 이상
- [Rust stable](https://www.rust-lang.org/tools/install)
- [LLVM](https://releases.llvm.org/)과 libclang
- Visual Studio C++ Build Tools의 **C++를 사용한 데스크톱 개발** 워크로드

```bash
npm install
npm run tauri dev
```

검사:

```bash
npm test
cd src-tauri
cargo test --lib
```

Windows PowerShell에서 `npm` 실행이 막히면 `npm.cmd`를 사용하세요.

## 다음 방향

OSW는 현재의 보컬/MR 도구를 작은 스템 기반 작업 공간으로 확장하고 있습니다.

- 악기별 스템 분리
- 전용 믹서 UI와 레벨 미터
- A-B 구간 반복과 첫 가사 카운트인
- 싱크 데이터 내보내기·가져오기
- 내부 채널 이펙트, 마이크 입력, VST 호스트의 장기 검토

완료 여부와 기술 제약은 [ToDo.md](ToDo.md)에서 관리합니다. 체크되지 않은 항목은
제안 또는 예정 작업이며 현재 기능으로 보지 않습니다.

## 데이터와 Legacy 호환

- OSW 데이터: `%LOCALAPPDATA%\com.osw.desktop\`
- 관리형 도구 공유 캐시: `%LOCALAPPDATA%\LiveMRManager\tools\`

관리형 도구 경로는 기존 GPU 팩·모델을 다시 내려받지 않도록 의도적으로 유지합니다.
이전 데이터 마이그레이션과 딥링크 호환 범위는
[Legacy 호환 정책](docs/LEGACY_COMPATIBILITY.md)을 참고하세요.

## 라이선스와 출처

OSW는 [MIT 라이선스](LICENSE)로 배포합니다. 이 프로젝트는
[AutumnColor77/Live-MR-Manager](https://github.com/AutumnColor77/Live-MR-Manager)를
기반으로 출발했으며, 원 개발자의 저작권 표시는 MIT 조건에 따라 유지합니다.
OSW는 별도 제품·저장소·릴리스 체계로 개발됩니다.

ffmpeg·yt-dlp·AI 모델·GPU 가속 팩은 각 배포 조건을 따릅니다. 기본 분리 모델
Mel-Band RoFormer Deux는 CC-BY-NC-4.0이므로 상업적 사용 전 라이선스를 확인해야
합니다. 자세한 목록은 [서드파티 고지](docs/THIRD-PARTY.md)에 있습니다.

## 참여와 지원

- [기여 안내](CONTRIBUTING.md)
- [보안 정책](SECURITY.md)
- [FAQ](https://companion-six-kappa.vercel.app/faq)
- [문의 안내](https://companion-six-kappa.vercel.app/qa)
- [릴리스 절차](docs/RELEASE_CHECKLIST.md)
