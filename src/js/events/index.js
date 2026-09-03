/**
 * js/events/index.js - Unified Event Initialization
 */
import { initNavigation, switchTab } from './navigation.js';
import { initControlListeners } from './controls/index.js';
import { initModalListeners } from './modals.js';
import { initMelomingListeners } from './meloming.js';
import { setupBackendListeners } from './backend.js';

export { switchTab };

export async function initAllEvents() {
  initNavigation();
  // 앱바는 단일 액션 레지스트리로 화면과 도구를 직접 실행한다. 라이브러리의
  // 기존 검색·필터 컨트롤만 이벤트를 보존하기 위해 공용 슬롯으로 옮긴다.
  initControlListeners();
  (await import('../ui/app-bar.js')).initAppBar();
  initModalListeners();
  await initMelomingListeners();
  await setupBackendListeners();
}
