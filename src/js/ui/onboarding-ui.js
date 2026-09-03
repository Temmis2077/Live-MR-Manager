/**
 * onboarding-ui.js — 시작 가이드를 화면에 그리는 곳
 *
 * 내용은 전부 js/onboarding.js에서 온다. 여기는 세 자리에 같은 내용을 다른
 * 모양으로 놓는 일만 한다:
 *   1) 빈 라이브러리 — 새 사용자가 반드시 지나가는 지점
 *   2) ⚙ 메뉴 「시작 가이드」 — 지나간 뒤에도 다시 찾을 수 있게
 *   3) 첫 실행 환영 — 한 화면, 건너뛸 수 있게
 */
import { ADD_PATHS, BASICS, markGuideSeen } from '../onboarding.js';

const MODAL_ID = 'onboarding-modal';

/**
 * 카드의 action 이름을 실제 동작으로 잇는다.
 *
 * 내용(onboarding.js)이 동작을 직접 들고 있지 않게 하려고 한 겹 뒀다 —
 * 그래야 내용 쪽이 DOM·Tauri 없이 테스트된다.
 */
const ACTIONS = {
  /** 파일 선택창을 바로 연다. 드래그드롭과 같은 경로로 이어진다. */
  'pick-files': async () => {
    const { invoke } = await import('../tauri-bridge.js');
    const { openAddSongModal } = await import('./add-song-modal.js');
    let paths = null;
    try {
      paths = await invoke('pick_audio_files');
    } catch (err) {
      console.error('[Onboarding] pick_audio_files failed:', err);
    }
    // 고르지 않고 닫았어도 추가 모달은 열어 준다 — 여기서 아무 일도 안 일어나면
    // 사용자는 버튼이 고장난 줄 안다.
    openAddSongModal(paths && paths.length ? paths : null);
  },

  'open-add-song': async () => {
    const { openAddSongModal } = await import('./add-song-modal.js');
    await openAddSongModal();
  },

  'csv-template': async () => {
    const { exportLibrarySpreadsheet } = await import('../settings-api.js');
    const { showNotification } = await import('../utils.js');
    try {
      await exportLibrarySpreadsheet(true);
      showNotification('양식을 저장했습니다. 표를 채운 뒤 「가져오기」를 누르세요.', 'success');
    } catch (err) {
      if (err !== 'CANCELLED') showNotification('양식을 저장하지 못했습니다: ' + err, 'error');
    }
  },

  'csv-import': async () => {
    const { importLibrarySpreadsheet } = await import('../settings-api.js');
    const { showNotification } = await import('../utils.js');
    try {
      const result = await importLibrarySpreadsheet();
      // 가져오기 뒤 목록 갱신은 설정 화면과 같은 경로를 쓴다.
      const { reloadLibraryAfterSpreadsheetImport } = await import('../events/controls/settings.js');
      await reloadLibraryAfterSpreadsheetImport(result);
    } catch (err) {
      if (err !== 'CANCELLED') showNotification('가져오기에 실패했습니다: ' + err, 'error');
    }
  },
};

async function runAction(name) {
  const fn = ACTIONS[name];
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.error(`[Onboarding] action "${name}" failed:`, err);
  }
}

/** 곡 추가 3경로 카드 묶음의 HTML. */
function pathCardsHtml() {
  return `<div class="ob-paths">${ADD_PATHS.map((p) => `
    <div class="ob-path">
      <div class="ob-path-icon" aria-hidden="true">${p.icon}</div>
      <div class="ob-path-title">${p.title}</div>
      <div class="ob-path-desc">${p.desc}</div>
      <div class="ob-path-actions">
        <button type="button" class="ob-btn primary" data-ob-action="${p.action}">${p.cta}</button>
        ${p.secondaryAction ? `<button type="button" class="ob-btn" data-ob-action="${p.secondaryAction}">${p.secondaryCta}</button>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function basicsHtml() {
  return `<div class="ob-basics">${BASICS.map((b) => `
    <div class="ob-basic">
      <div class="ob-basic-icon" aria-hidden="true">${b.icon}</div>
      <div>
        <div class="ob-basic-title">${b.title}</div>
        <div class="ob-basic-body">${b.body}</div>
      </div>
    </div>`).join('')}</div>`;
}

/** 카드 안의 버튼들을 실제 동작에 잇는다. */
function bindActions(root, { onDone } = {}) {
  root.querySelectorAll('[data-ob-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      onDone?.();
      await runAction(btn.dataset.obAction);
    });
  });
}

/**
 * 빈 라이브러리 화면에 그릴 시작 가이드.
 * ui/library.js가 곡이 하나도 없을 때 이걸 쓴다.
 */
export function renderLibraryStartGuide(container) {
  container.innerHTML = `
    <div class="ob-start">
      <div class="ob-start-head">
        <strong>아직 추가된 곡이 없습니다</strong>
        <span>지금 갖고 계신 것에 맞는 방법을 고르세요.</span>
      </div>
      ${pathCardsHtml()}
      <button type="button" class="ob-more" data-ob-open-guide>처음이신가요? 알아두면 좋은 것 보기</button>
    </div>`;

  bindActions(container);
  container.querySelector('[data-ob-open-guide]')
    ?.addEventListener('click', () => openGuide());
}

/** 가이드 모달(⚙ 메뉴 · 빈 화면의 '알아두면 좋은 것'). */
export async function openGuide({ welcome = false } = {}) {
  const { openOverlayModal, closeOverlayModal } = await import('./modals.js');

  let modal = document.getElementById(MODAL_ID);
  if (modal && modal.classList.contains('active')) return;
  if (!modal) {
    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }

  const close = () => closeOverlayModal(modal);

  modal.innerHTML = `
    <div class="modal-content ob-modal" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <header class="modal-header">
        <h3 id="ob-title">${welcome ? 'OSW에 오신 걸 환영합니다' : '시작 가이드'}</h3>
        <button type="button" class="close-btn" id="ob-close" aria-label="닫기">&times;</button>
      </header>
      <div class="modal-body">
        <p class="ob-lead">
          OSW는 노래를 <strong>보컬과 MR로 나눠</strong> 주고, 가사 타이밍을 맞춰
          방송 화면까지 얹어 주는 앱입니다. 분리와 가사 싱크는 모두 이 컴퓨터에서 처리합니다.
        </p>

        <h4 class="ob-section-title">곡을 넣는 세 가지 방법</h4>
        ${pathCardsHtml()}

        <h4 class="ob-section-title">알아두면 좋은 것</h4>
        ${basicsHtml()}
      </div>
      <footer class="ob-foot">
        <span class="ob-foot-hint">
          이 가이드는 설정 메뉴의 시작 가이드에서 다시 볼 수 있습니다.
          더 자세한 질문은 <button type="button" class="ob-link" id="ob-faq">도움말(FAQ)</button>에 있습니다.
        </span>
        <button type="button" class="ob-btn primary" id="ob-done">${welcome ? '시작하기' : '닫기'}</button>
      </footer>
    </div>`;

  bindActions(modal, { onDone: close });
  modal.querySelector('#ob-done')?.addEventListener('click', close);

  // FAQ는 웹에 있다(앱 재배포 없이 고칠 수 있게). 기본 브라우저로 연다.
  modal.querySelector('#ob-faq')?.addEventListener('click', async () => {
    const { openAppPage } = await import('../settings-api.js');
    const { FAQ_URL } = await import('../companion-links.js');
    openAppPage(FAQ_URL).catch((err) => console.error('[Onboarding] FAQ 열기 실패:', err));
  });

  openOverlayModal(modal, {
    closeIconId: 'ob-close',
    // 환영 화면은 한 번 떴으면 다시 뜨지 않게 기록한다. 건너뛰기(닫기·Esc·
    // 배경 클릭) 어느 쪽으로 나가든 같아야 하므로 닫힐 때 처리한다.
    onClose: welcome ? () => markGuideSeen() : undefined,
  });
}
