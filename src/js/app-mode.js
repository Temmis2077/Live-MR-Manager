/**
 * app-mode.js — 앱 모드(라이브 / 녹음)
 *
 * OSW는 "무엇을 하는가"로 두 갈래로 나뉜다(실력 사다리가 아니라 용도 축):
 *  - **라이브(live)**: 방송·공연. 실시간으로 MR에 맞춰 노래한다. 모니터/MR 채널
 *    분리, 실시간 출력 장치 전환, OBS 오버레이. 보컬·MR 중심.
 *  - **녹음(recording)**: 커버 제작. 곡을 스템으로 열어 **악기까지 분리**하고
 *    믹싱·이펙트로 트랙을 만든다. 미니 DAW 방향(악기 분리·전용 화면은 준비 중).
 *
 * 첫 실행 때 한 번 고르고(showAppModePicker), 설정에서 언제든 바꿀 수 있다.
 * 선택은 localStorage에 저장하고, body[data-app-mode]로 노출해 UI가 게이팅한다.
 */

const KEY = 'appMode';

export const APP_MODES = {
  live: {
    id: 'live',
    label: '라이브',
    tagline: '방송 · 공연',
    desc: '실시간으로 MR에 맞춰 노래합니다. 모니터/MR 채널 분리, 실시간 출력 장치 전환, OBS 오버레이. 노래 방송에 바로 쓰기 좋은 형태입니다.',
    supports: '보컬 · MR · 실시간 출력',
    emoji: '📡',
  },
  recording: {
    id: 'recording',
    label: '녹음',
    tagline: '커버 제작 · 미니 DAW',
    desc: '곡을 스템으로 열어 악기까지 분리하고 믹싱·이펙트로 트랙을 만듭니다. 커버 제작·연습에. (악기 분리·전용 화면은 준비 중)',
    supports: '보컬 · MR · 악기 스템 · 믹싱',
    emoji: '🎛️',
  },
};

export const DEFAULT_MODE = 'live';

export function isValidMode(mode) {
  return mode === 'live' || mode === 'recording';
}

/** 저장된 모드('live'|'recording') 또는 아직 안 골랐으면 null. */
export function getAppMode() {
  const v = localStorage.getItem(KEY);
  return isValidMode(v) ? v : null;
}

/** 첫 실행(모드 미선택) 여부. */
export function isModeChosen() {
  return getAppMode() !== null;
}

/** UI가 실제로 따라야 하는 모드 — 미선택이면 기본값. */
export function getEffectiveMode() {
  return getAppMode() || DEFAULT_MODE;
}

/** body[data-app-mode]에 현재 모드를 노출해 CSS/JS가 게이팅하게 한다. */
export function applyAppModeToBody(doc = (typeof document !== 'undefined' ? document : null)) {
  if (doc && doc.body) doc.body.dataset.appMode = getEffectiveMode();
}

/** 모드를 저장하고 body에 반영. 유효하지 않으면 무시하고 false. */
export function setAppMode(mode) {
  if (!isValidMode(mode)) return false;
  localStorage.setItem(KEY, mode);
  applyAppModeToBody();
  return true;
}
