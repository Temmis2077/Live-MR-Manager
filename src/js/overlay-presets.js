/**
 * 오버레이 기본 스타일 — 모양(크기·폰트·색·투명도·둥글기·방향·효과)과
 * 표시 항목(카드·커버·라벨·가수·키/BPM·다음 줄)을 한 번에 세팅한다.
 *
 * 새 CSS 변수는 만들지 않고 이미 있는 커스터마이징 축만 조합해서 서로 다른
 * 룩을 만든다. 표시 항목까지 프리셋에 넣은 이유는, 실제로 "박스 없이 가사만"
 * 같은 룩은 색·투명도만으로는 안 되고 커버·라벨을 함께 꺼야 완성되기 때문이다.
 *
 * 적용 후에도 아래 세부 컨트롤로 얼마든지 더 다듬을 수 있다.
 *
 * 슬라이더 step(scale·투명도는 0.1 단위)에 정확히 맞춘 값만 쓴다 — 안 맞는
 * 값(예: 0.85, 1.15)은 브라우저가 프로그램적 할당에도 가까운 스텝으로
 * 조용히 스냅해, 프리셋이 실제로 뭘 저장할지 브라우저 구현에 기대게 된다.
 */
const ALL_ON = { card: true, cover: true, label: true, artist: true, keyBpm: false, nextLine: true };

const OVERLAY_PRESETS = {
  glass: {
    label: '글래스', desc: '투명 유리 카드 · 방송 기본형',
    scale: 1.0, font: 'Pretendard', color: '8b5cf6', textColor: 'ffffff',
    bgOpacity: 0.6, rounding: 20, bgColor: '0f0f14', animationDirection: 'left', fontSize: 22,
    effectFloat: true, effectGlow: false,
    // 카드가 있으니 외곽선은 필요 없다. 그림자로 배경에서 살짝 띄운다.
    design: { outlineWidth: 0, outlineColor: '000000', shadow: 0.5, gradient: true, gradientColor: '1a1a2e' },
    visibility: { ...ALL_ON },
  },
  minimal: {
    label: '미니멀', desc: '박스 없이 텍스트만 · 담백하게',
    scale: 1.0, font: 'Inter', color: 'a78bfa', textColor: 'ffffff',
    bgOpacity: 0.0, rounding: 10, bgColor: '000000', animationDirection: 'top', fontSize: 24,
    effectFloat: false, effectGlow: false,
    // 카드를 없앤 만큼 얇은 외곽선으로 최소한의 가독성을 확보한다.
    design: { outlineWidth: 1.5, outlineColor: '000000', shadow: 0.3, gradient: false, gradientColor: '000000' },
    visibility: { ...ALL_ON, card: false, label: false },
  },
  stage: {
    label: '스테이지', desc: '굵은 외곽선 · 노래방 캡션',
    scale: 1.2, font: 'SUITE', color: 'ec4899', textColor: 'ffffff',
    bgOpacity: 0.0, rounding: 30, bgColor: '1a0b2e', animationDirection: 'bottom', fontSize: 28,
    effectFloat: false, effectGlow: false,
    // 노래방 자막의 핵심은 두꺼운 검은 외곽선이다. 배경 없이 이것만으로 읽힌다.
    design: { outlineWidth: 4, outlineColor: '000000', shadow: 0.6, gradient: false, gradientColor: '000000' },
    visibility: { ...ALL_ON, card: false },
  },
  lyricsOnly: {
    label: '가사 집중', desc: '가사만 큼직하게 · 곡 정보는 최소',
    scale: 1.1, font: 'SUITE', color: 'ffffff', textColor: 'ffffff',
    bgOpacity: 0.0, rounding: 10, bgColor: '000000', animationDirection: 'top', fontSize: 32,
    effectFloat: false, effectGlow: false,
    design: { outlineWidth: 3, outlineColor: '000000', shadow: 0.5, gradient: false, gradientColor: '000000' },
    visibility: { card: false, cover: false, label: false, artist: false, keyBpm: false, nextLine: false, progress: false },
  },
  titleOnly: {
    label: '제목만', desc: '커버·라벨 없이 곡 제목 한 줄',
    scale: 1.0, font: 'Pretendard', color: '8b5cf6', textColor: 'ffffff',
    bgOpacity: 0.5, rounding: 14, bgColor: '0f0f14', animationDirection: 'left', fontSize: 22,
    effectFloat: false, effectGlow: false,
    design: { outlineWidth: 0, outlineColor: '000000', shadow: 0.3, gradient: false, gradientColor: '000000' },
    visibility: { card: true, cover: false, label: false, artist: false, keyBpm: false, nextLine: true, progress: true },
  },
  practice: {
    label: '연습용', desc: '키·빠르기·진행바를 함께 표시',
    scale: 1.0, font: 'Inter', color: '22c55e', textColor: 'ffffff',
    bgOpacity: 0.7, rounding: 12, bgColor: '0b1410', animationDirection: 'left', fontSize: 22,
    effectFloat: false, effectGlow: false,
    // 연습 중에는 어디쯤인지가 중요해 진행바를 켠다.
    design: { outlineWidth: 0, outlineColor: '000000', shadow: 0.4, gradient: true, gradientColor: '052e16' },
    visibility: { ...ALL_ON, keyBpm: true, progress: true },
  },
  neon: {
    label: '네온', desc: '빛나는 글자 · 어두운 화면에',
    scale: 1.1, font: 'SUITE', color: '38bdf8', textColor: 'ffffff',
    bgOpacity: 0.55, rounding: 24, bgColor: '020617', animationDirection: 'bottom', fontSize: 26,
    effectFloat: true, effectGlow: true,
    // 글로우와 외곽선을 함께 — 외곽선이 빛 번짐의 심을 만들어 준다.
    design: { outlineWidth: 2, outlineColor: '020617', shadow: 0.7, gradient: true, gradientColor: '1e1b4b' },
    visibility: { ...ALL_ON, progress: true },
  },
  paper: {
    label: '페이퍼', desc: '밝은 카드에 검은 글자 · 밝은 화면에',
    scale: 1.0, font: 'Pretendard', color: '9a6b3f', textColor: '1a1a1a',
    bgOpacity: 0.92, rounding: 16, bgColor: 'f6f1e9', animationDirection: 'right', fontSize: 23,
    effectFloat: false, effectGlow: false,
    // 밝은 카드에는 흰 외곽선이 오히려 지저분하다 — 외곽선 없이 옅은 그림자만.
    design: { outlineWidth: 0, outlineColor: 'ffffff', shadow: 0.2, gradient: true, gradientColor: 'e7dccb' },
    visibility: { ...ALL_ON },
  },
  outline: {
    label: '아웃라인', desc: '배경 없이 굵은 테두리 글자만',
    scale: 1.05, font: 'SUITE', color: 'fbbf24', textColor: 'ffffff',
    bgOpacity: 0.0, rounding: 8, bgColor: '000000', animationDirection: 'top', fontSize: 30,
    effectFloat: false, effectGlow: false,
    // 어떤 배경 위에도 얹을 수 있는 가장 안전한 조합.
    design: { outlineWidth: 5, outlineColor: '111111', shadow: 0.6, gradient: false, gradientColor: '000000' },
    visibility: { ...ALL_ON, card: false, label: false },
  },
};

export { ALL_ON, OVERLAY_PRESETS };
