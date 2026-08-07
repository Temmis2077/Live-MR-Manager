/**
 * global-shortcuts.js — 화면과 무관하게 어디서나 듣는 단축키
 *
 * 상용 앱이면 당연히 있는데 이 앱에 없던 것들: 검색(Ctrl+F), 설정(Ctrl+,),
 * 화면 전환(Ctrl+1~3), 전체화면(F11), 뒤로/앞으로(Alt+←/→), 도움말(?).
 *
 * 창을 닫는 Ctrl+W·Ctrl+Q는 일부러 넣지 않았다 — 종료 전에 저장 여부를 묻는
 * 장치가 아직 없어서, 실수로 닫을 수 있는 길만 늘리는 셈이 된다.
 */
import { register, registerDocsOnly, initShortcuts } from '../shortcuts.js';
import { hasOpenLayer } from '../ui/layer-stack.js';
import { state } from '../state.js';
import { appWindow } from '../tauri-bridge.js';

function goToScreen(view) {
  import('./navigation.js').then((m) => m.switchTab(view));
}

/**
 * 검색창에 초점을 준다.
 *
 * 다른 화면에서 눌렀을 때가 까다롭다 — switchTab이 화면별 컨트롤 노출을
 * 동적 import(syncAppBar)로 미루기 때문에, 한 프레임만 기다리면 검색창이
 * 아직 숨겨져 있어서 focus()가 조용히 실패한다. 보일 때까지 몇 프레임
 * 지켜보다가 잡고, 그래도 안 나타나면 포기한다.
 */
function focusSearchInput(triesLeft = 30) {
  const input = document.getElementById('lib-search-input');
  if (input && input.offsetParent) {
    input.focus();
    input.select();
    return;
  }
  if (triesLeft <= 0) return;
  // 기다리는 사이 사용자가 다른 곳을 눌렀으면 초점을 빼앗지 않는다.
  const active = document.activeElement;
  if (active && active !== document.body && active !== input) return;
  requestAnimationFrame(() => focusSearchInput(triesLeft - 1));
}

export function initGlobalShortcuts() {
  register({
    combo: 'Alt+ArrowLeft', group: 'navigation', label: '뒤로',
    handler: () => import('./navigation.js').then((m) => m.goBackView()),
  });
  register({
    combo: 'Alt+ArrowRight', group: 'navigation', label: '앞으로',
    handler: () => import('./navigation.js').then((m) => m.goForwardView()),
  });

  register({
    combo: 'Ctrl+1', group: 'navigation', label: '라이브 화면',
    handler: () => goToScreen('live'),
  });
  register({
    combo: 'Ctrl+2', group: 'navigation', label: '음원 관리 화면',
    handler: () => goToScreen('library'),
  });
  register({
    combo: 'Ctrl+3', group: 'navigation', label: '가사 싱크 화면',
    handler: () => goToScreen('alignment'),
  });
  register({
    combo: 'Ctrl+,', group: 'navigation', label: '설정',
    handler: () => goToScreen('settings'),
  });

  register({
    combo: 'Ctrl+F', group: 'navigation', label: '곡 검색',
    // 검색창은 음원 관리 화면에 있다 — 다른 화면에서 눌렀으면 먼저 그리로 간다.
    handler: () => {
      const onLibrary = state.activeView === 'library' || state.activeView === 'meloming';
      if (!onLibrary) goToScreen('library');
      focusSearchInput();
    },
  });

  register({
    combo: 'F11', group: 'app', label: '전체 화면 켜기/끄기',
    handler: async () => {
      try {
        const isFull = await appWindow.isFullscreen();
        await appWindow.setFullscreen(!isFull);
      } catch (err) {
        console.error('[Shortcuts] fullscreen toggle failed:', err);
      }
    },
  });

  register({
    combo: 'Shift+/', group: 'app', label: '단축키 도움말',
    // 도움말은 자기 자신이 떠 있어도 다시 눌러 닫을 수 있어야 한다.
    allowOverLayer: true,
    handler: () => import('../ui/shortcut-help.js').then((m) => m.toggleShortcutHelp()),
  });

  registerViewShortcutDocs();

  initShortcuts({
    getActiveView: () => state.activeView,
    isLayerOpen: hasOpenLayer,
  });
}

/**
 * 가사 싱크 편집기와 라이브 화면의 키는 각자의 keydown 리스너가 그대로
 * 처리한다 — 캡처 단계 처리와 Space 선점 등 타이밍이 민감해서 옮기지 않았다.
 * 대신 도움말에는 보이도록 목록에만 올린다. 두 화면은 늦게 로드되므로
 * 등록도 여기서 미리 해 둔다(그 화면에 가본 적이 없어도 도움말에 나오게).
 *
 * 동작을 바꿀 때는 아래 설명도 같이 고쳐야 한다.
 * (구현: js/alignment-viewer.js, js/live-screen.js)
 */
function registerViewShortcutDocs() {
  const alignment = [
    ['Space', '재생 / 정지'],
    ['Enter', '지금 재생 위치를 이 줄의 가사 시작으로'],
    ['Shift+Enter', '방금 시작을 찍은 줄의 가사 끝으로'],
    ['Ctrl+Z', '실행 취소'],
    ['Ctrl+Shift+Z', '다시 실행'],
    ['ArrowLeft', '선택한 경계 10ms 앞으로 (Shift: 100ms)'],
    ['ArrowRight', '선택한 경계 10ms 뒤로 (Shift: 100ms)'],
    ['V', '현재 위치를 보컬 시작으로'],
    ['M', '현재 위치에 간주 마커 추가'],
    ['Escape', '경계 선택 해제'],
  ];
  const live = [
    ['Space', '재생 / 정지'],
    ['ArrowLeft', '5초 뒤로'],
    ['ArrowRight', '5초 앞으로'],
    ['N', '대기열의 다음 곡'],
    ['C', '조작 패널 펼치기/접기'],
    ['Alt+ArrowUp', '대기열에서 위로'],
    ['Alt+ArrowDown', '대기열에서 아래로'],
  ];

  alignment.forEach(([combo, label]) => registerDocsOnly({ combo, label, group: 'alignment', scope: 'alignment' }));
  live.forEach(([combo, label]) => registerDocsOnly({ combo, label, group: 'live', scope: 'live' }));
}

/**
 * 마우스 4/5번(뒤로/앞으로) 버튼. 키보드 단축키와 달리 브라우저 기본 동작이
 * 걸려 있어 mousedown에서 먼저 막아 둔다.
 */
export function initMouseNavigation() {
  window.addEventListener('mousedown', (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    import('./navigation.js').then((m) => (e.button === 3 ? m.goBackView() : m.goForwardView()));
  });
}
