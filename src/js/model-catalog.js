/**
 * 커스텀 분리 모델 추천 카탈로그.
 *
 * 여기 실리는 항목은 "원클릭 추가"로 제공되므로, URL이 실제로 열리고 프리셋
 * (아키텍처)이 모델과 정확히 맞는 것만 넣는다. 확신이 없는 모델은 넣지 않고
 * 가이드(docs/CUSTOM_MODELS.md)에서 수동 추가를 안내한다.
 *
 * URL 모델은 등록 시 즉시 받지 않고 "처음 분리할 때" 온디맨드로 내려받는다
 * (기존 add_custom_model URL 경로와 동일).
 */

export const MODEL_CATALOG = [
  {
    id: 'melband-roformer-deux',
    name: 'Mel-Band RoFormer Deux',
    // custom_models.rs PRESETS의 key와 반드시 일치해야 한다.
    preset: 'melband_roformer',
    sizeMB: 943,
    license: 'CC-BY-NC-4.0 (비상업)',
    recommended: true,
    gpuRecommended: true,
    // 이 앱 저장소의 모델 전용 릴리즈. becruily/mel-band-roformer-deux 체크포인트를
    // ONNX(opset 17)로 변환·패리티 검증한 버전(최대 오차 ~1.9e-7).
    url: 'https://github.com/Temmis2077/OSW/releases/download/separation-model-deux-v1/mel_band_roformer_deux.onnx',
    summary: '가장 깨끗한 보컬/반주 분리. 잔향·화음 처리가 기본 모델보다 뛰어납니다.',
    detail: 'becruily/mel-band-roformer-deux를 ONNX로 변환한 버전. 무거워서 GPU 가속 팩을 강하게 권장합니다(CPU 곡당 8~30분 → GPU 약 30초).',
  },
];
