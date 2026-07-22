/**
 * settings-tabs.js — 설정 화면 하위 카테고리 탭
 *
 * 설정 항목이 많아 한 화면에 다 몰려 있으면 찾기 어렵다. 섹션(.settings-group)을
 * 카테고리로 나눠, 상단 탭으로 한 번에 한 카테고리만 보여준다.
 *
 * DOM을 옮기지 않고, 각 섹션 안의 대표 요소로 카테고리를 태깅한 뒤(data-scat)
 * 탭 전환 시 매칭되는 섹션만 표시한다. 멜로밍 섹션은 .meloming-hidden(!important)
 * 으로 별도 고정 숨김이라 탭 전환의 영향을 받지 않는다.
 */

// 카테고리 → 그 카테고리에 속하는 섹션을 특정할 대표 자식 요소 id들.
const SCAT_ANCHORS = {
  general: ['btn-check-app-update', 'theme-mode-select', 'toggle-intro-skip'],
  media: ['btn-meloming-pull', 'output-device-select'],
  ai: ['btn-install-gpu-pack'],
  library: ['btn-import-spreadsheet'],
  about: ['btn-open-faq', 'btn-open-privacy-policy'],
};

const DEFAULT_SCAT = 'general';

/** 대표 자식 요소로 각 .settings-group에 data-scat을 부여한다. */
function tagSections() {
  for (const [cat, ids] of Object.entries(SCAT_ANCHORS)) {
    for (const id of ids) {
      const el = document.getElementById(id);
      const sec = el && el.closest('.settings-group');
      if (sec && !sec.dataset.scat) sec.dataset.scat = cat;
    }
  }
}

/** 주어진 카테고리 섹션만 표시하고 나머지는 숨긴다(멜로밍 고정 숨김은 CSS가 유지). */
function showCategory(scat) {
  document.querySelectorAll('#settings-page .settings-group').forEach((sec) => {
    // 태깅 안 된 섹션(예상 밖)은 일반 탭에 남겨 사라지지 않게 한다.
    const cat = sec.dataset.scat || DEFAULT_SCAT;
    sec.hidden = cat !== scat;
  });
  document.querySelectorAll('#settings-subtabs .settings-subtab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scat === scat);
  });
}

let initialized = false;

export function initSettingsTabs() {
  const bar = document.getElementById('settings-subtabs');
  if (!bar || initialized) return;
  initialized = true;

  tagSections();
  bar.querySelectorAll('.settings-subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => showCategory(btn.dataset.scat));
  });
  showCategory(DEFAULT_SCAT);
}
