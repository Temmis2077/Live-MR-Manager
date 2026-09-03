# 가사 정렬 전용 디리버브 (De-reverb)

리버브·보컬 이펙트가 심한 곡은 AI 가사 정렬 정확도가 크게 떨어집니다(특히 영어처럼
음소 단위로 맞추는 경우). 분리된 보컬에서 **잔향을 걷어낸 드라이 보컬로 정렬**하면
정확도가 올라갑니다.

- **정렬에만 씁니다.** 재생에는 적용되지 않습니다(재생과 정렬은 서로 다른 경로로
  보컬을 읽습니다).
- **정렬할 때만 실행**하고 결과를 `vocal_dr`로 캐시합니다. 분리만 하고 정렬하지 않는
  곡은 비용을 치르지 않고, 재정렬 시에는 캐시를 재사용합니다.
- 모델이 없거나 꺼져 있거나 실패하면 **원본 보컬로 폴백**합니다(정렬이 막히지 않음).

## 필요 조건

| 항목 | 요구 |
| :--- | :--- |
| GPU 가속 팩 | **필수** — 이 모델은 CPU로 돌리면 비현실적으로 느려서, 팩이 없으면 시도 자체를 건너뜁니다 → [GPU_ACCELERATION.md](GPU_ACCELERATION.md) |
| 모델 | Mel-Band RoFormer 디리버브 ONNX (약 940MB) |
| 위치 | `%LOCALAPPDATA%\LiveMRManager\tools\dereverb\dereverb_mel_band_roformer.onnx` (기존 설치 자산을 재사용하는 레거시 호환 공유 캐시) |

앱의 `AI 가사 정렬` 섹션에서 상태를 확인할 수 있습니다:

- **모델 없음 (원본으로 정렬)** — 모델 파일이 없음
- **GPU 가속 팩 필요 (원본으로 정렬)** — 모델은 있으나 GPU 팩이 없어 건너뜀
- **모델 설치됨** — 활성

## 모델 준비

[anvuew/dereverb_mel_band_roformer](https://huggingface.co/anvuew/dereverb_mel_band_roformer)의
체크포인트를 ONNX로 변환해 위 폴더에 둡니다. **Mel-Band RoFormer 아키텍처라 앱의
기존 RawWaveform 엔진(`melband_roformer` 프리셋)이 그대로 돌립니다** — 새 아키텍처
지원이 필요 없습니다.

저장소의 변환 스크립트를 쓰면 됩니다:

```bash
# 작업 폴더에 model.ckpt(체크포인트)와 config.yaml(모델 config)을 두고
python scripts/convert_dereverb_onnx.py     # 변환 + 4단계 패리티 검증
python scripts/verify_dereverb_onnx.py      # 실제 보컬로 stem0=드라이 확인
```

`convert_dereverb_onnx.py`는 STFT/iSTFT를 실수 conv 연산으로 그래프에 내장해
외부 전·후처리 없이 돌아가게 만들고(앱 엔진과 동일한 인터페이스), 각 단계마다
원본 PyTorch와 수치를 대조합니다.

### 인터페이스

```
입력  mix     [1, 2, 352800] float32   (44.1kHz 스테레오 8초 청크)
출력  sources [1, 2, 2, 352800]        stem0 = 드라이(디리버브), stem1 = 잔향 잔차
```

`stem0`이 드라이여야 합니다(앱 프리셋의 `vocal_source_index = 0`). 변환한 모델의
출력 순서가 반대라면 정렬이 오히려 나빠지므로, `verify_dereverb_onnx.py`로 반드시
확인하세요.

## 검증 기록 (참고)

변환·검증 시 실제로 나온 수치입니다:

| 검증 | 결과 |
| :--- | :--- |
| 체크포인트 로드 | missing 0 / unexpected 0 (아키텍처 완전 일치) |
| STFT / iSTFT 패리티 | `2.4e-04` / `1.4e-06` |
| 전체 모델 패리티 (실수 재구현 vs 원본) | `2.2e-11` |
| ONNX Runtime 패리티 | `1.2e-07` |

실제 보컬로 stem0이 드라이임을 확인한 근거:

- stem0 ↔ mix 상관 **+0.99**, stem1 상관 +0.18 (stem0이 본체)
- 잔차/드라이 비율이 **노래 구간 0.12 → 조용한 꼬리 0.23** — 목소리가 멈춘 뒤에도
  남는 성분이 stem1에 몰림(잔향의 전형적 특징)

## 알아둘 점

- 첫 실행은 이 모델의 TensorRT 엔진을 새로 빌드하느라 오래 걸립니다. **300초 제한**이
  걸려 있어, 넘으면 원본 보컬로 정렬을 계속 진행합니다(정렬이 막히지 않게). 엔진이
  한 번 캐시되면 이후는 빨라집니다.
- 라이선스: 원본 Hugging Face 저장소는 `GPL-3.0`으로 표시됩니다. GPL은 비상업 전용
  라이선스가 아니지만, 변환한 ONNX를 재배포할 때의 고지·제공 의무는 별도로 검토해야
  합니다. 공개 배포에 적용되는 현재 판정은 [서드파티 고지](THIRD-PARTY.md)를
  참고하세요.
