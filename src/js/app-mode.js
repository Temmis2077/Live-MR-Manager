/**
 * app-mode.js — 앱 모드(기본 / 스튜디오)
 *
 * OSW는 두 갈래로 쓰인다:
 *  - **기본(basic)**: 지금의 음악 플레이어형. 곡을 보컬/MR로 분리하고 재생·가사
 *    싱크·오버레이. 노래 방송·연습에 바로.
 *  - **스튜디오(studio)**: 고급. 보컬은 물론 **악기별 스템 분리**와 믹싱까지
 *    다루는 미니 DAW 방향(악기 분리·전용 레이아웃은 준비 중).
 *
 * 첫 실행 때 한 번 고르고(showAppModePicker), 설정에서 언제든 바꿀 수 있다.
 * 선택은 localStorage에 저장하고, body[data-app-mode]로 노출해 UI가 게이팅한다.
 */

const KEY = 'appMode';

export const APP_MODES = {
  basic: {
    id: 'basic',
    label: '기본',
    tagline: '노래 방송·연습',
    desc: '곡을 보컬/MR로 분리하고 재생·가사 싱크·OBS 오버레이. 지금 바로 쓰기 좋은 형태입니다.',
    supports: '보컬 · MR',
    emoji: '🎤',
  },
  studio: {
    id: 'studio',
    label: '스튜디오',
    tagline: '고급 · 미니 DAW',
    desc: '보컬은 물론 악기별 스템 분리와 믹싱까지. 곡을 완전히 열어 다룹니다. (악기 분리·전용 화면은 준비 중)',
    supports: '보컬 · MR · 악기 스템',
    emoji: '🎛️',
  },
};

export const DEFAULT_MODE = 'basic';

export function isValidMode(mode) {
  return mode === 'basic' || mode === 'studio';
}

/** 저장된 모드('basic'|'studio') 또는 아직 안 골랐으면 null. */
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
