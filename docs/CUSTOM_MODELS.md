# 커스텀 분리 모델 가이드

OSW의 기본 분리 모델은 **Mel-Band RoFormer Vocals (MIT)** 하나입니다. 설치 파일에
953MB 가중치를 넣는 대신 첫 분리 때 고정된 원본 주소에서 내려받고 SHA-256을 검사합니다.
다른 품질이나 특수한 용도가 필요할 때만 **직접 받은 ONNX 모델**을 추가할 수 있습니다.

## 언제 커스텀 모델이 필요한가

- **최고 품질의 보컬/MR 분리** — Mel-Band RoFormer 계열은 기본 MDX 모델보다 잔향·화음을
  훨씬 깨끗하게 처리합니다. 대신 무겁습니다(아래 *GPU* 참고).
- **특정 스템만 뽑기** — 백보컬만 제거(듀엣·커버용), 반주만 강조 등.
- **커뮤니티 최신 모델** — UVR 생태계에서 새 모델이 계속 나옵니다.

기본 모델로 충분히 만족한다면 커스텀 모델은 필요 없습니다.

## 기본 모델

`Mel-Band RoFormer Vocals (MIT)`는 별도 등록 없이 모델 선택 화면에 기본으로 표시됩니다.
첫 사용 때 약 953MB를 내려받으므로 네트워크와 저장 공간이 필요합니다.

> **기본: Mel-Band RoFormer Vocals (MIT)** — 가중치와 ONNX 변환물이 MIT로 공개됐고,
> OSW 입력 형식·파일 해시·CPU 스모크 추론을 확인했습니다. 실제 곡별 품질과 GPU 성능은
> 계속 검증하지만 라이선스가 확인된 기본 모델로 사용합니다.
>
> 기존 **Mel-Band RoFormer Deux**는 CC-BY-NC-4.0이라 신규 카탈로그에서 내렸습니다.
> 이미 설치한 파일은 삭제되지 않지만 수익 방송·유료 제작에는 사용하지 마세요.

## 직접 모델을 추가할 때 — 프리셋 고르는 법

임의의 ONNX 파일은 내부 STFT/아키텍처 값을 신뢰성 있게 추론할 수 없어서, **모델에 맞는
프리셋**을 직접 골라야 합니다. 프리셋이 틀리면 분리 결과가 깨집니다.

| 프리셋 | 어떤 모델인가 | 입력 형식 | 대표 예시 |
| :--- | :--- | :--- | :--- |
| **MDX-Net (보컬 추출)** | 보컬을 뽑는 MDX-Net. FFT 7680 / 3072 bins | 스펙트로그램(rank 4) | Kim Vocal 1/2, Voc FT |
| **MDX-Net (반주/MR 추출)** | 반주를 뽑는 MDX-Net Inst 계열 | 스펙트로그램(rank 4) | UVR-MDX-NET-Inst_HQ 1~3 |
| **MDX-Net KARA (2048 bins)** | 백보컬 제거용 KARA 계열. FFT 4096 / 2048 bins | 스펙트로그램(rank 4) | UVR_MDXNET_KARA_2 |
| **RoFormer (스펙트로그램, 실험적)** | 스펙트로그램을 입력받는 RoFormer 변형 | 스펙트로그램(rank 4) | 드묾 |
| **Mel-Band RoFormer (파형 직접 입출력)** | STFT가 그래프에 내장된 RoFormer. 입력 `[1,2,N]` 파형 → 출력 `[1,2,2,N]`, 보컬=source 0 | 파형(rank 3) | Mel-Band RoFormer Deux/Vocals |
| **Mel-Band RoFormer Karaoke (리드/화음)** | 통합 보컬을 다시 처리하는 2차 전용 모델. 입력 `[1,2,N]` → 출력 `[1,2,2,N]`, 리드=source 0, 화음=source 1 | 파형(rank 3), 로컬 파일 전용 | becruily Karaoke 계열을 직접 변환·검증한 ONNX |

**고르는 순서:**
1. 모델 페이지 설명에서 아키텍처(MDX-Net / Mel-Band RoFormer / KARA)를 확인합니다.
2. **Mel-Band RoFormer**면 → *파형 직접 입출력* 프리셋. 입력이 `[1, 2, N]` 3차원이면 이쪽입니다.
3. **MDX-Net**이면 → 보컬을 뽑는지 반주를 뽑는지에 따라 *보컬 추출* / *반주 추출*.
4. **KARA**(백보컬 제거)면 → *MDX-Net KARA*.

로컬 파일로 추가하면 앱이 **입력 형식(rank)을 프리셋과 대조**해서, 안 맞으면 추가를
거부하고 이유를 알려줍니다. URL로 추가하면 이 검사는 처음 분리할 때로 미뤄집니다.

리드/화음 Karaoke 프리셋은 모델 가중치의 재배포·자동 다운로드를 제공하지 않습니다.
사용자가 라이선스와 출력 source 순서를 확인한 ONNX 파일을 직접 등록해야 하며,
앱은 분리 후 `lead + backing ≈ vocal`, 채널·길이·에너지 조건을 통과한 결과만 게시합니다.

## 어디서 모델을 받나

- **smank/mel-band-roformer-vocals-onnx** — Mel-Band RoFormer 보컬 ONNX
- **becruily/mel-band-roformer-deux** — Legacy 비상업 모델. 신규 추천·배포하지 않음
- **seanghay/uvr_models**, **Politrees/UVR_resources** — MDX-Net 계열 ONNX 모음

⚠️ **ONNX 파일만** 됩니다. `.pth`·`.ckpt`(PyTorch 체크포인트)는 바로 쓸 수 없고 ONNX로
변환해야 합니다. 변환된 모델은 입력이 반드시 위 표의 형식이어야 합니다.

## GPU 가속 (RoFormer는 사실상 필수)

Mel-Band RoFormer는 매우 무거워서 CPU로는 곡당 8~30분이 걸립니다. **GPU 가속 팩**을
설치하면 같은 곡이 **약 30초**로 떨어집니다(RTX 2070 실측). NVIDIA GPU가 있다면
`설정 → AI → GPU 가속 팩`에서 설치하세요. 자세한 내용: [GPU_ACCELERATION.md](GPU_ACCELERATION.md).

MDX-Net 계열은 비교적 가볍지만 각 가중치의 라이선스를 확인한 뒤 커스텀 모델로 등록해야 합니다.

## 라이선스 주의

커뮤니티 모델 상당수는 **CC-BY-NC(비상업)** 라이선스입니다. 수익이 발생하는 방송·콘텐츠에
쓸 계획이면 사용하지 마세요. 비상업 모델이 필요한 사용자는 각 모델의 원본 페이지에서
직접 받은 뒤 로컬 ONNX로 등록해야 합니다. OSW는 해당 모델을 자동 다운로드하지 않습니다.
모델 라이선스와 원곡·가사·
원본 음원의 저작권은 별개입니다. 자세한 내용은
[방송·커버 권리 안내](BROADCAST_AND_COVER_RIGHTS_GUIDE.md)를 참고하세요.
