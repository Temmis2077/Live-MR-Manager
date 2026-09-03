/**
 * app-bar.js — 앱 상단바 (사이드바 대체)
 *
 * 시안의 셸 구성: 52px 바 하나에 [OSW 마크 | 현재 화면 ▾] … [화면별 컨트롤] [⚙].
 * 사이드바 9개 탭을 늘어놓는 대신 화면 전환은 드롭다운 하나로 모은다.
 *
 * 화면·도구는 APP_ACTIONS에서 직접 실행한다. 화면 전용 컨트롤은 아래 슬롯
 * 레지스트리에 명시된 것만 앱바에 장착하므로, 화면 전환 중 DOM을 옮기지 않는다.
 */
import { state } from '../state.js';
import { pushLayer, popLayer } from './layer-stack.js';

// JavaScript로 만든 마크는 HTML 변환 대상이 아니므로 import.meta.url을 기준으로
// 잡아 Vite가 설치본용 data URL/해시 자산으로 변환하게 한다.
const APPBAR_MARK_URL = new URL('../../assets/images/osw-mark.svg', import.meta.url).href;

/** 앱바의 단일 공개 계약. 숨은 사이드바 DOM을 대신 누르지 않는다. */
export const APP_ACTIONS = [
  { id: 'live', label: '라이브', desc: '공연·방송 중 쓰는 큰 조작 화면', kind: 'screen', action: 'navigate', tools: [] },
  { id: 'library', label: '음원 관리', desc: '곡 목록과 스템 상태 보기', kind: 'screen', action: 'navigate', tools: ['search', 'filters'] },
  { id: 'alignment', label: '가사 싱크', desc: '가사 타이밍을 맞추고 저장', kind: 'screen', action: 'navigate', tools: [] },
  { id: 'recording', label: '녹음', desc: '스템 믹서와 파형 콘솔', kind: 'screen', action: 'navigate', tools: [], soon: true },
  { id: 'tasks', label: 'AI 프로세싱', desc: '분리·정렬 작업 진행 상태', kind: 'tool', action: 'navigate', tools: [] },
  { id: 'lyrics-window', label: '가사 창 띄우기', desc: '별도 창 · 항상 위', kind: 'tool', action: 'open-lyrics-window', tools: [] },
  { id: 'overlay', label: 'OBS 오버레이 설정', desc: '미리보기와 프리셋', kind: 'tool', action: 'open-overlay', tools: [] },
  { id: 'settings', label: '설정', desc: '오디오 장치 · 분리 모델 · 보관 폴더', kind: 'tool', action: 'navigate', tools: [] },
  { id: 'onboarding', label: '시작 가이드', desc: '곡 넣는 법 · 처음 알아두면 좋은 것', kind: 'tool', action: 'open-guide', tools: [] },
  { id: 'shortcut-help', label: '단축키 도움말', desc: '이 앱에서 쓸 수 있는 키 모음 · ?', kind: 'tool', action: 'open-shortcuts', tools: [] },
];

const SCREENS = APP_ACTIONS.filter((item) => item.kind === 'screen');
const MENU_ACTIONS = APP_ACTIONS.filter((item) => item.kind === 'tool');

export const APPBAR_SLOTS = [
  { id: 'library-search', selector: '.library-controls .search-bar', slot: 'center', views: ['library', 'meloming'] },
  { id: 'library-filters', selector: '.library-controls .filter-group', slot: 'center', views: ['library', 'meloming'] },
  { id: 'library-view', selector: '#view-controls', slot: 'right', views: ['library', 'meloming'] },
  { id: 'broadcast-mode', selector: '#broadcast-tasks-control', slot: 'right', views: ['library', 'meloming'] },
];

const $ = (id) => document.getElementById(id);

export async function runAppAction(entryOrId) {
  const entry = typeof entryOrId === 'string'
    ? APP_ACTIONS.find((item) => item.id === entryOrId)
    : entryOrId;
  if (!entry || entry.soon) return;
  if (entry.action === 'navigate') {
    const { switchTab } = await import('../events/navigation.js');
    switchTab(entry.id);
  } else if (entry.action === 'open-lyrics-window') {
    const { invoke } = await import('../tauri-bridge.js');
    await invoke('open_lyrics_window');
  } else if (entry.action === 'open-overlay') {
    const { openOverlayFloat } = await import('./overlay-float.js');
    openOverlayFloat();
  } else if (entry.action === 'open-guide') {
    const { openGuide } = await import('./onboarding-ui.js');
    openGuide();
  } else if (entry.action === 'open-shortcuts') {
    const { openShortcutHelp } = await import('./shortcut-help.js');
    openShortcutHelp();
  }
}

function screenLabel(view) {
  // 멜로밍은 프론트에서 숨긴 상태라 라벨만 음원 관리로 맞춘다.
  if (view === 'meloming') return '음원 관리';
  const hit = SCREENS.find((s) => s.id === view);
  // 오버레이 설정은 화면이 아니라 떠 있는 패널이라 여기 없다.
  return hit ? hit.label : (view === 'settings' ? '설정'
    : view === 'tasks' ? 'AI 프로세싱' : '음원 관리');
}

/** 열려 있는 메뉴의 레이어 핸들 — Esc 처리를 layer-stack에 위임한다. */
const menuLayers = new WeakMap();

function closeAllMenus() {
  document.querySelectorAll('.appbar-menu.open').forEach((m) => {
    m.classList.remove('open');
    const trigger = m.previousElementSibling;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    const handle = menuLayers.get(m);
    if (handle) {
      popLayer(handle);
      menuLayers.delete(m);
    }
  });
}

function toggleMenu(menu, trigger) {
  const willOpen = !menu.classList.contains('open');
  closeAllMenus();
  if (!willOpen) return;

  menu.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.querySelector('.appbar-menu-item:not([aria-disabled="true"])')?.focus();
  // 메뉴는 안에서 Tab을 가두지 않는다 — 목록이 짧고 바깥으로 나가면
  // 어차피 바깥 클릭/포커스 이동으로 닫히는 게 자연스럽다.
  menuLayers.set(menu, pushLayer({
    id: 'appbar-menu',
    el: menu,
    close: closeAllMenus,
    trapFocus: false,
    autoFocus: false,
  }));
}

/**
 * 뒤로/앞으로 — 상용 앱이면 당연히 있는 것인데 이 앱에는 없었다.
 * 화면 전환 드롭다운 왼쪽에 두어 "지금 어디" 옆에 "어디서 왔나"가 붙게 한다.
 */
function buildHistoryNav() {
  const wrap = document.createElement('div');
  wrap.className = 'appbar-history';

  const make = (id, label, path, go) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'appbar-icon-btn appbar-nav-btn';
    btn.id = id;
    btn.disabled = true;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    btn.addEventListener('click', () => {
      import('../events/navigation.js').then((m) => m[go]());
    });
    return btn;
  };

  wrap.append(
    make('appbar-back-btn', '뒤로', '<path d="M15 18l-6-6 6-6"></path>', 'goBackView'),
    make('appbar-forward-btn', '앞으로', '<path d="M9 18l6-6-6-6"></path>', 'goForwardView'),
  );
  return wrap;
}

/** 화면 전환 드롭다운 */
function buildScreenSwitcher() {
  const wrap = document.createElement('div');
  wrap.className = 'appbar-switcher';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'appbar-screen-btn';
  trigger.id = 'appbar-screen-btn';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `<span id="appbar-screen-label">음원 관리</span><span class="appbar-caret" aria-hidden="true"></span>`;

  const menu = document.createElement('div');
  menu.className = 'appbar-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="appbar-menu-label">화면 전환</div>` + SCREENS.map((s) => `
    <button type="button" class="appbar-menu-item" role="menuitem" data-screen="${s.id}"
      ${s.soon ? 'aria-disabled="true" disabled' : ''}>
      <span class="appbar-menu-item-title">${s.label}${s.soon ? '<span class="appbar-soon">준비 중</span>' : ''}</span>
      <span class="appbar-menu-item-desc">${s.desc}</span>
    </button>`).join('');

  menu.querySelectorAll('[data-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.screen;
      closeAllMenus();
      if (id === 'recording') return; // 잠긴 항목 — 도달하지 않지만 방어적으로
      runAppAction(id).catch((err) => console.error('[AppBar] navigation failed:', err));
    });
  });

  trigger.addEventListener('click', () => toggleMenu(menu, trigger));
  wrap.append(trigger, menu);
  return wrap;
}

/** ⚙ 메뉴 */
function buildGearMenu() {
  const wrap = document.createElement('div');
  wrap.className = 'appbar-switcher';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'appbar-icon-btn';
  trigger.id = 'appbar-gear-btn';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', '설정과 도구');
  trigger.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

  const menu = document.createElement('div');
  menu.className = 'appbar-menu align-right';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="appbar-menu-label">도구와 설정</div>` + MENU_ACTIONS.map((a, i) => `
    <button type="button" class="appbar-menu-item" role="menuitem" data-action-index="${i}"
      data-action="${a.id}">
      <span class="appbar-menu-item-title">${a.label}${a.id === 'tasks' ? '<span class="appbar-menu-badge" id="task-badge" data-badge-for="tasks"></span>' : ''}</span>
      <span class="appbar-menu-item-desc">${a.desc}</span>
    </button>`).join('');

  menu.querySelectorAll('[data-action-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeAllMenus();
      // 메뉴 항목은 닫히는 즉시 숨겨지므로, 이어서 열 모달/패널이 복귀할
      // 안정적인 위치를 기억할 수 있게 도구 버튼으로 초점을 돌려놓는다.
      trigger.focus();
      const entry = MENU_ACTIONS[Number(btn.dataset.actionIndex)];
      runAppAction(entry).catch((err) => console.error('[AppBar] tool action failed:', err));
    });
  });

  trigger.addEventListener('click', () => toggleMenu(menu, trigger));
  wrap.append(trigger, menu);
  return wrap;
}

/** 화면별 컨트롤이 들어가는 고정 슬롯. */
function buildSlots(bar) {
  const center = document.createElement('div');
  center.className = 'appbar-center';
  center.id = 'appbar-center';

  const right = document.createElement('div');
  right.className = 'appbar-right';
  right.id = 'appbar-right';

  bar.append(center, right);
  return { center, right };
}

function buildAddSongButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'appbar-add-song';
  button.className = 'appbar-add-song';
  button.dataset.appbarSlot = 'add-song';
  button.dataset.appbarViews = 'library meloming';
  button.setAttribute('aria-label', '노래 추가');
  button.innerHTML = '<span aria-hidden="true">＋</span><span>노래 추가</span>';
  button.addEventListener('click', () => {
    import('./add-song-modal.js').then(({ openAddSongModal }) => openAddSongModal());
  });
  return button;
}

let mounted = false;

export function initAppBar() {
  if (mounted) return;
  const viewMain = document.querySelector('.view-main');
  if (!viewMain) return;

  const bar = document.createElement('header');
  bar.className = 'app-bar';
  bar.id = 'app-bar';

  const brand = document.createElement('div');
  brand.className = 'appbar-brand';
  brand.innerHTML = `
    <img src="${APPBAR_MARK_URL}" alt="OSW" class="appbar-mark">
    <span class="appbar-word">Ο.Σ.Ω</span>
    <span class="appbar-divider" aria-hidden="true"></span>`;

  bar.append(brand, buildHistoryNav(), buildScreenSwitcher());
  const { center, right } = buildSlots(bar);
  right.appendChild(buildGearMenu());

  viewMain.insertBefore(bar, viewMain.firstChild);

  const gear = right.firstChild;
  APPBAR_SLOTS.forEach((entry) => {
    const node = document.querySelector(entry.selector);
    if (!node) return;
    node.dataset.appbarSlot = entry.id;
    node.dataset.appbarViews = entry.views.join(' ');
    if (entry.slot === 'center') center.appendChild(node);
    else right.insertBefore(node, gear);
  });
  right.insertBefore(buildAddSongButton(), gear);

  // 바깥 클릭·ESC로 메뉴 닫기
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.appbar-switcher')) closeAllMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllMenus();
  });

  mounted = true;
  syncAppBar(state.activeView || 'library');
}

/** 탭이 바뀔 때 앱바의 라벨·컨트롤 노출을 맞춘다. */
export function syncAppBar(view) {
  const label = $('appbar-screen-label');
  if (label) label.textContent = screenLabel(view);

  // 뒤로/앞으로 버튼은 갈 곳이 있을 때만 살아 있다.
  import('../nav-history.js').then(({ canGoBack, canGoForward }) => {
    const backBtn = $('appbar-back-btn');
    const fwdBtn = $('appbar-forward-btn');
    if (backBtn) backBtn.disabled = !canGoBack();
    if (fwdBtn) fwdBtn.disabled = !canGoForward();
  }).catch(() => {});

  const bar = $('app-bar');
  if (bar) bar.setAttribute('data-view', view || '');

  document.querySelectorAll('#app-bar [data-appbar-views]').forEach((node) => {
    const allowed = node.dataset.appbarViews.split(/\s+/).filter(Boolean);
    node.hidden = !allowed.includes(view);
  });

  document.querySelectorAll('#app-bar [data-screen]').forEach((btn) => {
    const isCurrent = btn.dataset.screen === view
      || (btn.dataset.screen === 'library' && view === 'meloming');
    btn.classList.toggle('current', isCurrent);
    if (isCurrent) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  });

  // AI 프로세싱 개수를 ⚙ 메뉴에도 알려준다 — 사이드바 배지가 사라졌으므로.
  const dst = document.querySelector('[data-badge-for="tasks"]');
  if (dst) {
    const n = dst.style.display !== 'none' ? (dst.textContent || '').trim() : '';
    dst.textContent = n && n !== '0' ? n : '';
    dst.classList.toggle('on', !!dst.textContent);
  }
}
