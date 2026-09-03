# 서드파티 고지 (Third-Party Notices)

OSW는 MIT 라이선스로 배포됩니다. 이 문서는 OSW가 함께 배포하거나, 실행 중에
사용자 PC로 내려받아 사용하는 외부 구성 요소를 정리한 것입니다.

> **핵심 — OSW 설치 파일은 MIT 라이선스의 ONNX Runtime과 CUDA·TensorRT provider DLL을 포함합니다.**
> ffmpeg·yt-dlp·AI 모델·GPU 가속 팩은 사용자가 기능을 실행한 뒤 각 배포처에서
> 사용자 PC로 내려받습니다. GPL 빌드인 ffmpeg는 별도 프로세스로 호출하며 OSW
> 설치 파일에는 재배포하지 않습니다.

---

## 1. OSW가 기반한 프로젝트

OSW는 아래 프로젝트를 기반으로 출발한 **별개의 앱**이며 현재 독립적으로
유지됩니다. 설치·데이터·업데이트도 모두 분리되어 있습니다.

| 프로젝트 | 라이선스 | 비고 |
| --- | --- | --- |
| [AutumnColor77/Live-MR-Manager](https://github.com/AutumnColor77/Live-MR-Manager) | MIT | OSW가 기반으로 사용한 초기 오디오 엔진·AI 분리·라이브러리·OBS 오버레이의 설계·구현. MIT 조건에 따라 저작권 표시를 `LICENSE`에 함께 싣습니다. |

---

## 2. 설치 파일에 함께 배포되는 것

### 폰트

| 이름 | 라이선스 | 출처 |
| --- | --- | --- |
| SUITE | SIL Open Font License 1.1 | [sun-typeface/SUITE](https://github.com/sun-typeface/SUITE) |
| LINE Seed Sans KR | SIL Open Font License 1.1 | [LINE Seed](https://seed.line.me/) |
| Space Mono | SIL Open Font License 1.1 | [Google Fonts](https://fonts.google.com/specimen/Space+Mono) |

OFL은 폰트 파일 재배포를 허용하며, 라이선스 사본을 함께 싣도록 요구합니다 →
`src/assets/fonts/SUITE-LICENSE.txt`, `LINESeed-OFL.txt`, `SpaceMono-OFL.txt`
(각 원본 그대로).
저작권: `Copyright (c) 2023, SUNN (http://sun.fo/suite), with Reserved Font Name SUITE.`

### AI 실행 런타임

| 이름 | 라이선스 | 용도 |
| --- | --- | --- |
| ONNX Runtime 1.24 | MIT | 설치본의 CPU 분리·가사 정렬 및 CUDA·TensorRT provider |

### 프런트엔드 라이브러리

| 이름 | 라이선스 | 용도 |
| --- | --- | --- |
| Sortable.js | MIT | 라이브러리 곡 순서 드래그 정렬 |

### 빌드 의존성 (바이너리에 링크됨)

| 이름 | 라이선스 |
| --- | --- |
| Tauri v2 | MIT 또는 Apache-2.0 |
| ort (ONNX Runtime Rust 바인딩) | MIT 또는 Apache-2.0 |
| ONNX Runtime | MIT |

전체 목록과 정확한 버전은 `src-tauri/Cargo.lock`에 있습니다.

---

## 3. 실행 중 내려받는 도구 (번들 아님)

| 이름 | 라이선스 | 내려받는 곳 | 용도 |
| --- | --- | --- | --- |
| ffmpeg | GPL-3.0 (아래 빌드 기준) | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | 오디오 디코딩·변환, 유튜브 오디오 추출 |
| yt-dlp | Unlicense (퍼블릭 도메인) | [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | 유튜브 오디오·메타데이터 가져오기 |

두 도구 모두 OSW와 **별도 실행 파일**로 호출됩니다. OSW는 이들을 재배포하지
않으며, 사용자가 원하지 않으면 내려받지 않아도 됩니다(해당 기능만 비활성).

---

## 4. 실행 중 내려받는 AI 모델 (번들 아님)

| 모델 | 원본 | 원본 라이선스 |
| --- | --- | --- |
| 한국어 가사 정렬 (wav2vec2) | [kresnik/wav2vec2-large-xlsr-korean](https://huggingface.co/kresnik/wav2vec2-large-xlsr-korean) | Apache-2.0 |
| 영어 가사 정렬 (wav2vec2) | [facebook/wav2vec2-base-960h](https://huggingface.co/facebook/wav2vec2-base-960h) | Apache-2.0 |
| MR 분리 — Mel-Band RoFormer Vocals **(기본)** | [smank/mel-band-roformer-vocals-onnx](https://huggingface.co/smank/mel-band-roformer-vocals-onnx) | MIT |
| MR 분리 — Kim Vocal 2 / UVR-MDX-NET Inst HQ 3 *(Legacy 커스텀)* | [seanghay/uvr_models](https://huggingface.co/seanghay/uvr_models) (UVR 커뮤니티) | 개별 가중치 조건 미확인 |
| MR 분리 — Mel-Band RoFormer Deux *(Legacy, 신규 배포 중단)* | [becruily/mel-band-roformer-deux](https://huggingface.co/becruily/mel-band-roformer-deux) | **CC-BY-NC-4.0 (비상업)** |
| 디리버브 — Mel-Band RoFormer | [anvuew/dereverb_mel_band_roformer](https://huggingface.co/anvuew/dereverb_mel_band_roformer) | GPL-3.0 표시, 변환물 재배포 조건 검토 필요 |

정렬 모델은 원본을 ONNX로 내보내 OSW 릴리즈에 자산으로 올린 것입니다(가중치
자체는 변경하지 않았습니다). Apache-2.0은 이런 재배포를 허용하며, 저작권·라이선스
표시 유지를 요구합니다.

> ### ⚠️ Mel-Band RoFormer Deux는 비상업 라이선스입니다
>
> **CC-BY-NC-4.0**이라 상업적 이용이 허용되지 않습니다. OSW는 이 모델을 신규
> 카탈로그와 배포 경로에서 내렸습니다. 기존 설치 파일과 프로젝트는 자동 삭제하지
> 않으며 앱에서 Legacy 비상업 경고를 표시합니다.
>
> **기본으로 쓰이는 모델은 이것이 아닙니다.** OSW의 기본값은 MIT 라이선스가 명시된
> `Mel-Band RoFormer Vocals` 하나입니다. Deux는 사용자가 원본 조건을 확인하고 로컬
> 커스텀 모델로 직접 등록해야만 쓸 수 있습니다.
>
> Kim Vocal 2와 Inst HQ 3도 개별 가중치 조건이 확인되기 전에는 상업 이용 가능하다고
> 보장하지 않으며 기본 모델에서 제외했습니다. MIT 기본 모델의 검증 상태는
> 공개 배포에 적용되는 확정 사항은 이 문서를 기준으로 합니다. 후보 조사와 미확정
> 법률 판단은 공개 문서에 포함하지 않습니다.
>
> 이 문서는 법률 자문이 아닙니다. 판단이 어려우면 각 모델의 원 배포 페이지를
> 직접 확인해 주세요.

> 사용자가 직접 넣는 커스텀 모델(`docs/CUSTOM_MODELS.md`)의 라이선스 확인은
> 사용자 책임입니다.

모델을 사용할 수 있다는 것과 입력한 노래·가사·원본 녹음을 방송하거나 배포할 수 있다는
것은 별개입니다. [방송·커버 권리 안내](BROADCAST_AND_COVER_RIGHTS_GUIDE.md)를 함께
확인하세요.

---

## 5. GPU 가속 팩 (선택, 실행 중 내려받음)

NVIDIA CUDA / cuDNN / TensorRT 런타임 라이브러리를 포함합니다. 각 SLA·EULA는
런타임 라이브러리의 재배포를 **저작권 고지를 조건으로** 허용합니다:

- NVIDIA CUDA Toolkit EULA — Attachment A (재배포 가능 목록)
- NVIDIA cuDNN SLA
- NVIDIA TensorRT SLA §8.2

OSW는 팩을 설치할 때 해당 폴더에 고지 파일을 함께 씁니다
(`src-tauri/src/gpu_pack.rs`의 `write_attribution_notice`).

---

## 6. 외부 웹 서비스

OSW는 곡 정보와 가사를 채우기 위해 아래 서비스에 요청을 보냅니다. 모두 **사용자
동작으로만** 발생하며, OSW 서버로 사용자 데이터를 모으지 않습니다.

| 서비스 | 용도 |
| --- | --- |
| [LRCLIB](https://lrclib.net) | 싱크된 가사(LRC) 조회 — 무인증 공개 API |
| YouTube oEmbed | 곡 제목·썸네일 |
| Last.fm (Cloudflare Worker 프록시) | 장르·태그 |
| DuckDuckGo (HTML) | 가사 페이지 검색 (언어권별) |
| Bugs, lyrics.co.kr, 나무위키, Genius 등 | 가사 페이지 링크 |

> **가사 저작권** — 가사는 OSW가 아니라 각 권리자에게 저작권이 있습니다.
> LRCLIB에서 받아오더라도 이 사실은 달라지지 않습니다.
>
> OSW는 받은 가사를 **사용자 PC의 곡 옆에 `.lrc` 파일로만** 저장합니다. OSW
> 서버로 보내지 않고, 모아두지 않으며, 재배포하지 않습니다. 용도는 사용자가
> 가진 그 음원에 싱크를 맞추는 것입니다. 방송 송출처럼 공개적으로 쓰는 경우의
> 권리 처리는 사용자 책임입니다.
>
> 이 문서는 법률 자문이 아닙니다.

---

## 7. 문의

빠진 고지나 잘못된 표기를 발견하면
[이슈](https://github.com/Temmis2077/OSW/issues)로 알려주세요.
