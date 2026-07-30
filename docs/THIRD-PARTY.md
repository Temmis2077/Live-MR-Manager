# 서드파티 고지 (Third-Party Notices)

OSW는 MIT 라이선스로 배포됩니다. 이 문서는 OSW가 함께 배포하거나, 실행 중에
사용자 PC로 내려받아 사용하는 외부 구성 요소를 정리한 것입니다.

> **핵심 — OSW 설치 파일은 서드파티 바이너리를 포함하지 않습니다.**
> `tauri.conf.json`의 `bundle.resources`가 비어 있고, ffmpeg·yt-dlp·AI 모델·GPU
> 가속 팩은 전부 사용자가 실행한 뒤 각 배포처에서 사용자 PC로 내려받습니다.
> 따라서 GPL 빌드인 ffmpeg를 쓰더라도 OSW 자체의 라이선스에는 영향이 없습니다
> (별도 프로세스로 호출하며, 재배포하지 않습니다).

---

## 1. OSW가 기반한 프로젝트

| 프로젝트 | 라이선스 | 비고 |
| --- | --- | --- |
| [AutumnColor77/Live-MR-Manager](https://github.com/AutumnColor77/Live-MR-Manager) | MIT | 초기 오디오 엔진·AI 분리·라이브러리·OBS 오버레이의 설계·구현. MIT 조건에 따라 저작권 표시를 `LICENSE`에 함께 싣습니다. |

---

## 2. 설치 파일에 함께 배포되는 것

### 폰트

| 이름 | 라이선스 | 출처 |
| --- | --- | --- |
| SUITE | SIL Open Font License 1.1 | [sun-typeface/SUITE](https://github.com/sun-typeface/SUITE) |

OFL은 폰트 파일 재배포를 허용하며, 라이선스 사본을 함께 싣도록 요구합니다 →
`src/assets/fonts/SUITE-LICENSE.txt` (원본 그대로).
저작권: `Copyright (c) 2023, SUNN (http://sun.fo/suite), with Reserved Font Name SUITE.`

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
| MR 분리 — Kim Vocal 2 / UVR-MDX-NET | [seanghay/uvr_models](https://huggingface.co/seanghay/uvr_models) (UVR 커뮤니티) | 각 모델의 원 배포 조건 |
| MR 분리 — Mel-Band RoFormer Deux | [becruily/mel-band-roformer-deux](https://huggingface.co/becruily/mel-band-roformer-deux) | **CC-BY-NC-4.0 (비상업)** |
| 디리버브 — Mel-Band RoFormer | [anvuew/dereverb_mel_band_roformer](https://huggingface.co/anvuew/dereverb_mel_band_roformer) | 원 배포 조건 |

정렬 모델은 원본을 ONNX로 내보내 OSW 릴리즈에 자산으로 올린 것입니다(가중치
자체는 변경하지 않았습니다). Apache-2.0은 이런 재배포를 허용하며, 저작권·라이선스
표시 유지를 요구합니다.

> ### ⚠️ Mel-Band RoFormer Deux는 비상업 라이선스입니다
>
> 분리 품질이 가장 좋은 기본 모델이지만 **CC-BY-NC-4.0**, 즉 상업적 이용이
> 허용되지 않습니다. OSW 자체는 MIT이고 이 모델을 번들하지 않지만, 사용자가
> 내려받아 쓰는 순간 모델의 조건이 적용됩니다.
>
> 수익을 내는 방송·상업적 커버 제작에 쓸 계획이라면 이 모델 대신 조건이
> 허용되는 모델을 고르시거나, 권리자에게 별도 허락을 받으셔야 합니다.
> 다른 모델은 설정에서 바꿀 수 있습니다(`docs/CUSTOM_MODELS.md`).
>
> 이 문서는 법률 자문이 아닙니다. 판단이 어려우면 각 모델의 원 배포 페이지를
> 직접 확인해 주세요.

> 사용자가 직접 넣는 커스텀 모델(`docs/CUSTOM_MODELS.md`)의 라이선스 확인은
> 사용자 책임입니다.

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
| YouTube oEmbed | 곡 제목·썸네일 |
| Last.fm (Cloudflare Worker 프록시) | 아티스트·앨범 메타데이터 |
| DuckDuckGo (HTML) | 가사 검색 |
| Bugs, lyrics.co.kr | 가사 본문 |

> **가사 저작권** — 가사는 OSW가 아니라 각 권리자에게 저작권이 있습니다. OSW는
> 가사를 서버에 저장하거나 재배포하지 않고, 사용자 PC에만 저장해 사용자 본인의
> 곡에 싱크를 맞추는 용도로 씁니다. 방송 송출 등 공개 이용의 권리 처리는 사용자
> 책임입니다.

---

## 7. 문의

빠진 고지나 잘못된 표기를 발견하면
[이슈](https://github.com/Temmis2077/Live-MR-Manager-Mod/issues)로 알려주세요.
