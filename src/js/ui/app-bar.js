/**
 * app-bar.js — 앱 상단바 (사이드바 대체)
 *
 * 시안의 셸 구성: 52px 바 하나에 [OSW 마크 | 현재 화면 ▾] … [화면별 컨트롤] [⚙].
 * 사이드바 9개 탭을 늘어놓는 대신 화면 전환은 드롭다운 하나로 모은다.
 *
 * 설계상 중요한 점 — 기존 사이드바 DOM은 지우지 않고 숨긴다. nav-item에는 이미
 * 탭 전환·모달 열기·별도 창 열기 핸들러가 붙어 있어서, 새 메뉴는 그 항목을
 * click()해 재사용한다. 라이브러리 검색·필터·뷰 버튼도 새로 만들지 않고
 * appendChild로 앱바 안으로 옮긴다(이동은 이벤트 핸들러를 유지한다).
 */
import { state } from '../state.js';

/** 드롭다운에 노출할 화면. 녹음은 아직 콘솔이 개발용이라 잠가 둔다. */
const SCREENS = [
  { id: 'live', label: '라이브', desc: '공연·방송 중 쓰는 큰 조작 화면' },
  { id: 'library', label: '음원 관리', desc: '곡 목록과 스템 상태 보기' },
  { id: 'alignment', label: '가사 싱크', desc: '가사 타이밍을 맞추고 저장' },
  { id: 'recording', label: '녹음', desc: '스템 믹서와 파형 콘솔', soon: true },
];

/** ⚙ 메뉴 — 화면이 아니라 '한 번 실행하는 것'들. 기존 nav-item을 대신 누른다. */
const MENU_ACTIONS = [
  { navId: 'nav-tasks', label: 'AI 프로세싱', desc: '분리·정렬 작업 진행 상태' },
  { navId: 'nav-lyrics-window', label: '가사 창 띄우기', desc: '별도 창 · 항상 위' },
  { navId: 'nav-overlay', label: 'OBS 오버레이 설정', desc: '미리보기와 프리셋' },
  { navId: 'nav-settings', label: '설정', desc: '오디오 장치 · 분리 모델 · 보관 폴더' },
];

const $ = (id) => document.getElementById(id);

/** 사이드바의 해당 항목을 눌러 준다 — 핸들러를 새로 붙이지 않기 위해. */
function clickNav(navId) {
  const el = $(navId);
  if (el) el.click();
}

function screenLabel(view) {
  // 멜로밍은 프론트에서 숨긴 상태라 라벨만 음원 관리로 맞춘다.
  if (view === 'meloming') return '음원 관리';
  const hit = SCREENS.find((s) => s.id === view);
  // 오버레이 설정은 화면이 아니라 떠 있는 패널이라 여기 없다.
  return hit ? hit.label : (view === 'settings' ? '설정'
    : view === 'tasks' ? 'AI 프로세싱' : '음원 관리');
}

function closeAllMenus() {
  document.querySelectorAll('.appbar-menu.open').forEach((m) => {
    m.classList.remove('open');
    const trigger = m.previousElementSibling;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function toggleMenu(menu, trigger) {
  const willOpen = !menu.classList.contains('open');
  closeAllMenus();
  menu.classList.toggle('open', willOpen);
  trigger.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) menu.querySelector('.appbar-menu-item:not([aria-disabled="true"])')?.focus();
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
      // 사이드바 항목이 있으면 그 핸들러를 쓰고, 없으면 탭만 바꾼다.
      if ($(`nav-${id}`)) clickNav(`nav-${id}`);
      else import('../events/navigation.js').then((m) => m.switchTab(id));
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
  menu.innerHTML = `<div class="appbar-menu-label">도구와 설정</div>` + MENU_ACTIONS.map((a) => `
    <button type="button" class="appbar-menu-item" role="menuitem" data-nav="${a.navId}">
      <span class="appbar-menu-item-title">${a.label}<span class="appbar-menu-badge" data-badge-for="${a.navId}"></span></span>
      <span class="appbar-menu-item-desc">${a.desc}</span>
    </button>`).join('');

  menu.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeAllMenus();
      clickNav(btn.dataset.nav);
    });
  });

  trigger.addEventListener('click', () => toggleMenu(menu, trigger));
  wrap.append(trigger, menu);
  return wrap;
}

/** 화면별 컨트롤이 들어가는 자리 — 기존 요소를 여기로 옮긴다. */
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
    <img src="./assets/images/osw-mark.svg" alt="OSW" class="appbar-mark">
    <span class="appbar-word">Ο.Σ.Ω</span>
    <span class="appbar-beta">BETA</span>
    <span class="appbar-divider" aria-hidden="true"></span>`;

  bar.append(brand, buildScreenSwitcher());
  const { center, right } = buildSlots(bar);
  right.appendChild(buildGearMenu());

  viewMain.insertBefore(bar, viewMain.firstChild);

  // 라이브러리 컨트롤(검색·필터·뷰 버튼)과 '노래 추가'를 앱바로 옮긴다.
  // 새로 만들지 않고 옮기는 이유는 이미 붙어 있는 핸들러를 살리기 위해서다.
  const search = document.querySelector('.library-controls .search-bar');
  const filters = document.querySelector('.library-controls .filter-group');
  const viewControls = $('view-controls');
  const addSong = $('nav-add-song');

  if (search) center.appendChild(search);
  if (filters) center.appendChild(filters);
  // 순서: [뷰 모드][방송 토글][＋ 노래 추가][⚙] — 시안처럼 주 버튼이 ⚙ 바로 앞.
  const gear = right.firstChild;
  const broadcast = $('broadcast-tasks-control'); // 옛 제목 줄 안에 있어 같이 옮긴다
  if (viewControls) right.insertBefore(viewControls, gear);
  if (broadcast) right.insertBefore(broadcast, gear);
  if (addSong) {
    addSong.classList.add('appbar-add-song');
    right.insertBefore(addSong, gear);
  }

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

  const bar = $('app-bar');
  if (bar) bar.setAttribute('data-view', view || '');

  document.querySelectorAll('#app-bar [data-screen]').forEach((btn) => {
    const isCurrent = btn.dataset.screen === view
      || (btn.dataset.screen === 'library' && view === 'meloming');
    btn.classList.toggle('current', isCurrent);
    if (isCurrent) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  });

  // AI 프로세싱 개수를 ⚙ 메뉴에도 알려준다 — 사이드바 배지가 사라졌으므로.
  const src = $('task-badge');
  const dst = document.querySelector('[data-badge-for="nav-tasks"]');
  if (dst) {
    const n = src && src.style.display !== 'none' ? (src.textContent || '').trim() : '';
    dst.textContent = n && n !== '0' ? n : '';
    dst.classList.toggle('on', !!dst.textContent);
  }
}
