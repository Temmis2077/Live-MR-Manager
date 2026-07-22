/**
 * js/events/meloming.js - Meloming OAuth (header) + songbook settings
 */
import { invoke, listen } from '../tauri-bridge.js';
import { showNotification } from '../utils.js';
import { switchTab } from './navigation.js';

/**
 * 멜로밍 기능 노출 여부.
 *
 * 현재 멜로밍 인증 키를 받지 못해 로그인·가져오기·보내기가 실제로 동작할 수
 * 없다. 눌러도 실패하는 버튼을 두면 "고장난 앱"으로 보이므로 **UI만** 숨긴다.
 * 백엔드 커맨드와 이 모듈의 로직은 그대로 두므로, 키를 받으면 이 값을 true로
 * 되돌리는 것만으로 복구된다.
 */
const MELOMING_UI_ENABLED = false;

/** 멜로밍 관련 화면 요소를 모두 숨긴다(사이드탭·헤더 계정·설정 카드).
 *
 * .nav-item·.meloming-account 등은 display:flex라 hidden 속성으로는 안 감춰진다
 * (요소/클래스 셀렉터의 display가 UA의 [hidden]{display:none}을 이긴다). 그래서
 * 범용 .meloming-hidden(!important) 클래스로 확실히 숨긴다. 설정 그룹은 하위 탭
 * JS가 hidden을 토글하므로 클래스 고정이 특히 필요하다. */
function hideMelomingUi() {
  const nav = document.getElementById('nav-meloming');
  if (nav) nav.classList.add('meloming-hidden');

  const account = document.getElementById('meloming-account');
  if (account) account.classList.add('meloming-hidden');

  // 설정 탭의 "멜로밍 노래책" 그룹 전체(헤더 포함)를 숨긴다.
  const pull = document.getElementById('btn-meloming-pull');
  const group = pull ? pull.closest('.settings-group') : null;
  if (group) group.classList.add('meloming-hidden');
}

const PLACEHOLDER_AVATAR = './assets/images/app-icon.png';

let pendingOAuthState = null;
let accountMenuOpen = false;

function setStatus(text, isError = false) {
  const el = document.getElementById('meloming-status');
  if (!el) return;
  const firstLine = (text || '').split('\n')[0].trim();
  el.textContent = firstLine;
  el.classList.toggle('is-error', !!isError && !!firstLine);
  el.classList.toggle('is-notice', false);
}

function getAccountElements() {
  return {
    root: document.getElementById('meloming-account'),
    btn: document.getElementById('meloming-account-btn'),
    avatar: document.getElementById('meloming-account-avatar'),
    label: document.getElementById('meloming-account-label'),
    menu: document.getElementById('meloming-account-menu'),
    logout: document.getElementById('meloming-account-logout'),
  };
}

function setAccountMenuOpen(open) {
  const { btn, menu } = getAccountElements();
  accountMenuOpen = open;
  if (menu) menu.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function renderGuestAccount() {
  const { btn, avatar, label, menu } = getAccountElements();
  if (!btn || !label) return;

  btn.classList.remove('is-user');
  btn.classList.add('is-guest');
  label.textContent = '멜로밍 로그인';
  if (avatar) {
    avatar.hidden = true;
    avatar.removeAttribute('src');
    avatar.classList.remove('is-placeholder');
  }
  if (menu) menu.hidden = true;
  accountMenuOpen = false;
}

function renderUserAccount(profile) {
  const { btn, avatar, label, menu } = getAccountElements();
  if (!btn || !label) return;

  btn.classList.remove('is-guest');
  btn.classList.add('is-user');
  label.textContent = profile?.nickname || '멜로밍';

  const imageUrl = profile?.profileImageUrl || profile?.profile_image_url;
  if (avatar) {
    avatar.hidden = false;
    if (imageUrl) {
      avatar.src = imageUrl;
      avatar.classList.remove('is-placeholder');
    } else {
      avatar.src = PLACEHOLDER_AVATAR;
      avatar.classList.add('is-placeholder');
    }
  }
  if (menu && !accountMenuOpen) menu.hidden = true;
}

async function isMelomingLoggedIn() {
  try {
    const profile = await invoke('meloming_get_user_profile');
    return !!(profile?.loggedIn ?? profile?.logged_in);
  } catch {
    return false;
  }
}

async function reloadLibrary(tab = 'library') {
  const { loadLibrary } = await import('../audio.js');
  const { state } = await import('../state.js');
  const { renderLibrary } = await import('../ui/library.js');
  state.songLibrary = (await loadLibrary()) || [];
  renderLibrary();
  switchTab(tab);
}

function setButtonsBusy(pullBtn, pushBtn, busy) {
  if (pullBtn) pullBtn.disabled = busy;
  if (pushBtn) pushBtn.disabled = busy;
}

export async function refreshAccountWidget() {
  try {
    const profile = await invoke('meloming_get_user_profile');
    const loggedIn = profile?.loggedIn ?? profile?.logged_in;
    if (loggedIn) {
      renderUserAccount(profile);
    } else {
      renderGuestAccount();
    }
  } catch (err) {
    console.warn('[Meloming] profile refresh failed:', err);
    renderGuestAccount();
  }
}

async function startMelomingLogin(triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await invoke('meloming_oauth_start');
    pendingOAuthState = res?.state || null;
    if (res?.authorizeUrl) {
      console.info('[Meloming OAuth] authorize URL:', res.authorizeUrl);
    }
    showNotification('브라우저에서 멜로밍 로그인을 완료해 주세요.', 'info');
  } catch (err) {
    showNotification(String(err), 'error');
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

async function logoutMeloming() {
  try {
    await invoke('meloming_oauth_logout');
    pendingOAuthState = null;
    setAccountMenuOpen(false);
    await refreshAccountWidget();
    showNotification('멜로밍 로그아웃했습니다.', 'success');
  } catch (err) {
    showNotification(String(err), 'error');
  }
}

function setupAccountWidget() {
  const { btn, logout } = getAccountElements();
  if (!btn) return;

  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      const profile = await invoke('meloming_get_user_profile');
      const loggedIn = profile?.loggedIn ?? profile?.logged_in;
      if (!loggedIn) {
        await startMelomingLogin(btn);
        return;
      }
      setAccountMenuOpen(!accountMenuOpen);
    } catch (err) {
      showNotification(String(err), 'error');
    }
  });

  if (logout) {
    logout.addEventListener('click', async (event) => {
      event.stopPropagation();
      await logoutMeloming();
    });
  }

  document.addEventListener('click', (event) => {
    const { root } = getAccountElements();
    if (!root || root.contains(event.target)) return;
    setAccountMenuOpen(false);
  });
}

async function runMelomingPull(pullBtn, pushBtn) {
  setButtonsBusy(pullBtn, pushBtn, true);
  setStatus('멜로밍 노래책 가져오는 중…');
  try {
    const res = await invoke('meloming_pull_songs', { channelId: null });
    const summary = `가져오기 완료 — ${res.fetched}곡 조회, 추가 ${res.created}곡, 갱신 ${res.updated}곡`;
    setStatus(summary);
    showNotification(summary, 'success');
    await reloadLibrary('library');
  } catch (err) {
    setStatus(String(err), true);
    showNotification(String(err), 'error');
  } finally {
    setButtonsBusy(pullBtn, pushBtn, false);
  }
}

async function runMelomingPush(pullBtn, pushBtn) {
  if (!(await isMelomingLoggedIn())) {
    showNotification('보내기는 멜로밍 로그인이 필요합니다. 우측 상단에서 로그인해 주세요.', 'warning');
    return;
  }

  setButtonsBusy(pullBtn, pushBtn, true);
  setStatus('멜로밍 노래책에 보내는 중…');
  try {
    const res = await invoke('meloming_push_songs', { channelId: null });
    let summary = `보내기 완료 — ${res.pushed}곡 (신규 ${res.created}, 갱신 ${res.updated})`;
    if (res.skipped > 0) summary += `, 건너뜀 ${res.skipped}곡`;
    setStatus(summary, res.errors?.length > 0);
    showNotification(summary, res.errors?.length > 0 ? 'warning' : 'success');
    if (res.errors?.length) {
      console.warn(`[Meloming push] 건너뜀 ${res.skipped}곡 — 사유:`);
      for (const line of res.errors) {
        console.warn(`  · ${line}`);
      }
    }
    await refreshAccountWidget();
    await reloadLibrary('meloming');
  } catch (err) {
    setStatus(String(err), true);
    showNotification(String(err), 'error');
  } finally {
    setButtonsBusy(pullBtn, pushBtn, false);
  }
}

export async function initMelomingListeners() {
  // 인증 키가 없어 실제로 동작할 수 없는 동안에는 화면에서 감추고 배선하지 않는다.
  // (백엔드 커맨드는 그대로 살아 있어 플래그만 되돌리면 복구된다.)
  if (!MELOMING_UI_ENABLED) {
    hideMelomingUi();
    return;
  }

  setupAccountWidget();
  await refreshAccountWidget();

  listen('meloming-oauth-complete', async (event) => {
    const payload = event?.payload || {};
    if (payload.ok) {
      pendingOAuthState = null;
      setAccountMenuOpen(false);
      await refreshAccountWidget();
      showNotification('멜로밍 로그인이 완료되었습니다.', 'success');
    } else {
      const raw = payload.error || '로그인에 실패했습니다.';
      const msg = raw.includes('INTERNAL_ERROR') || raw.includes('서버 내부 오류')
        ? '멜로밍 서버 오류(500)입니다. 잠시 후 다시 로그인해 주세요.'
        : raw;
      showNotification(msg, 'error');
    }
  }).catch(() => {});

  const btnPull = document.getElementById('btn-meloming-pull');
  const btnPush = document.getElementById('btn-meloming-push');

  if (btnPull) {
    btnPull.onclick = () => runMelomingPull(btnPull, btnPush);
  }
  if (btnPush) {
    btnPush.onclick = () => runMelomingPush(btnPull, btnPush);
  }
}
