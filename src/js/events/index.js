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
  // 앱바는 사이드바·옛 제목 줄의 요소를 자기 안으로 옮긴다. 그 요소들에 붙는
  // 핸들러가 먼저 걸려 있어야 하므로 컨트롤 초기화보다 뒤에서 부른다.
  initControlListeners();
  (await import('../ui/app-bar.js')).initAppBar();
  initModalListeners();
  await initMelomingListeners();
  await setupBackendListeners();
}
