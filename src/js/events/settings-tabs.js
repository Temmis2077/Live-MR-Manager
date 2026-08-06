/**
 * settings-tabs.js — 설정 화면 하위 카테고리 탭
 *
 * 설정 항목이 많아 한 화면에 다 몰려 있으면 찾기 어렵다. 섹션(.settings-group)을
 * 카테고리로 나눠, 상단 탭으로 한 번에 한 카테고리만 보여준다.
 *
 * ── 카테고리는 마크업이 선언한다 (중요) ─────────────────────────────
 * 각 섹션은 index.html에서 `data-scat="general|media|ai|library|about"`을 직접
 * 달고 있다. 이 모듈은 그 값을 읽기만 한다.
 *
 * 예전에는 카테고리를 "그 섹션 안에 있는 대표 버튼의 id"로 추론했다
 * (SCAT_ANCHORS = { library: ['btn-open-manager'] } 같은 식). 그래서 그 버튼을
 * 다른 화면으로 옮기거나 지우면 — 설정과 아무 상관 없는 작업이어도 — 섹션이
 * 카테고리를 잃고 전부 '일반'으로 흘러들어, 설정 화면이 다시 긴 리스트처럼
 * 보였다. 오류도 안 나서 알아채기 어려웠다. 실제로 두 번 재발했다:
 *   - btn-open-manager 를 라이브러리 툴바로 옮겼을 때 (커밋 fd8780b)
 *   - 곡 정보 관리자 모달을 통째로 없앴을 때
 * 앵커 추론을 없애고 섹션이 스스로 카테고리를 들게 해서 이 고리를 끊었다.
 *
 * 새 설정 섹션을 추가할 때는 `data-scat`을 반드시 같이 적는다.
 * 빠뜨리면 콘솔에 경고가 뜨고 tests/settings-tabs.test.js가 실패한다.
 */

const CATEGORIES = ['general', 'media', 'ai', 'library', 'about'];
const DEFAULT_SCAT = 'general';

/** 릴리즈에서 감춘 섹션인가. 탭 전환은 이런 섹션을 절대 되살리지 않는다. */
function isReleaseHidden(sec) {
  return sec.dataset.releaseHidden === '1' || sec.classList.contains('meloming-hidden');
}

function sections() {
  return [...document.querySelectorAll('#settings-page .settings-group')];
}

/**
 * data-scat이 없거나 모르는 값인 섹션을 찾아 경고한다.
 *
 * 조용히 '일반'으로 몰아넣으면 예전처럼 리스트로 되돌아간 걸 아무도 모른다.
 * 눈에 띄게 알리고, 그 섹션에는 표시를 남겨 개발 중에 바로 보이게 한다.
 */
export function findUntaggedSections() {
  return sections().filter((sec) => {
    const v = sec.dataset.scat;
    return !v || !CATEGORIES.includes(v);
  });
}

/** 주어진 카테고리 섹션만 표시하고 나머지는 숨긴다. */
function showCategory(scat) {
  sections().forEach((sec) => {
    // 릴리즈 게이팅(app-mode-ui.js 등)과 이 탭 필터가 같은 hidden 속성을
    // 나눠 쓰다 보니, 탭을 한 번 왕복하면 감춰 둔 '앱 모드' 섹션이 다시
    // 나타났다 — 아직 동작 차이가 없어 일부러 뺀 UI였다.
    if (isReleaseHidden(sec)) { sec.hidden = true; return; }
    const cat = CATEGORIES.includes(sec.dataset.scat) ? sec.dataset.scat : DEFAULT_SCAT;
    sec.hidden = cat !== scat;
  });
  document.querySelectorAll('#settings-subtabs .settings-subtab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scat === scat);
  });
  lastScat = scat;
}

/** 보일 섹션이 하나도 없는 탭의 버튼은 감춘다 — 눌러도 빈 화면인 탭은 없어야 한다. */
function hideEmptyTabs() {
  const secs = sections();
  document.querySelectorAll('#settings-subtabs .settings-subtab-btn').forEach((btn) => {
    const has = secs.some((sec) => {
      if (isReleaseHidden(sec)) return false;
      const cat = CATEGORIES.includes(sec.dataset.scat) ? sec.dataset.scat : DEFAULT_SCAT;
      return cat === btn.dataset.scat;
    });
    btn.hidden = !has;
  });
}

let initialized = false;
let lastScat = DEFAULT_SCAT;

export function initSettingsTabs() {
  const bar = document.getElementById('settings-subtabs');
  if (!bar || initialized) return;
  initialized = true;

  const untagged = findUntaggedSections();
  if (untagged.length > 0) {
    // 조용히 넘어가지 않는다 — 이게 "설정이 또 리스트가 됐다"의 원인이었다.
    console.error(
      `[Settings] data-scat이 없는 설정 섹션 ${untagged.length}개 — 전부 '일반' 탭으로 갑니다.`,
      untagged,
    );
    untagged.forEach((sec) => sec.setAttribute('data-scat-missing', '1'));
  }

  hideEmptyTabs();
  bar.querySelectorAll('.settings-subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => showCategory(btn.dataset.scat));
  });
  showCategory(DEFAULT_SCAT);
}

/**
 * 설정 화면에 들어올 때마다 현재 탭을 다시 적용한다.
 *
 * 탭 상태를 앱 시작 때 한 번만 칠하면, 그 뒤에 다른 코드가 섹션의 hidden을
 * 건드렸을 때(릴리즈 게이팅·모달 등) 되돌릴 기회가 없어 그대로 리스트가 된다.
 * navigation.js의 switchTab('settings')에서 부른다.
 */
export function refreshSettingsTabs() {
  if (!document.getElementById('settings-subtabs')) return;
  if (!initialized) { initSettingsTabs(); return; }
  hideEmptyTabs();
  showCategory(lastScat);
}
