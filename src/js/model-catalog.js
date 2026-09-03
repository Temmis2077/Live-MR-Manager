/**
 * 커스텀 분리 모델 카탈로그.
 *
 * 신규 항목은 가중치·변환물의 라이선스와 고정 리비전/해시가 확인되고,
 * OSW 입출력 검증을 통과한 뒤에만 recommended=true로 올린다.
 */

// MIT 모델은 이제 기본 내장 모델이므로 커스텀 카탈로그에 중복 노출하지 않는다.
// 비상업 모델은 OSW가 원클릭 배포하지 않고 사용자가 원본 조건을 확인한 뒤
// 로컬 파일로만 등록하도록 안내한다.
export const MODEL_CATALOG = [];

// 카탈로그에서 내린 모델도 기존 사용자의 DB나 파일을 지우지 않는다.
export const LEGACY_MODEL_POLICIES = [
  {
    id: 'melband-roformer-deux',
    name: 'Mel-Band RoFormer Deux',
    matchUrls: [
      'https://github.com/Temmis2077/OSW/releases/download/separation-model-deux-v1/mel_band_roformer_deux.onnx',
    ],
    licenseSpdx: 'CC-BY-NC-4.0',
    commercialUse: 'restricted',
    message: 'Legacy 비상업 모델 · 수익 방송이나 유료 제작에는 사용하지 마세요.',
  },
];

export function findLegacyModelPolicy(model) {
  return LEGACY_MODEL_POLICIES.find((policy) =>
    policy.matchUrls.includes(model?.url) ||
    model?.name?.toLowerCase().includes('roformer deux'));
}
