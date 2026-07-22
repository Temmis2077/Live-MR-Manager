/**
 * app-mode-ui.js — 앱 모드 첫 실행 선택 모달 + 설정 전환 UI
 * 로직은 app-mode.js, 여기서는 화면·배선만 담당한다.
 */
import {
  APP_MODES, getEffectiveMode, isModeChosen, setAppMode, applyAppModeToBody,
} from '../app-mode.js';

/** 모드 전환 후 화면을 다시 그린다(모드에 따라 보이는 게 달라질 수 있음). */
function refreshAfterModeChange() {
  renderModeSetting();
  // 라이브러리·설정을 다시 그려 모드 게이팅을 반영. 실패해도 body 속성은 이미 적용됨.
  import('../ui/library.js').then((m) => m.renderLibrary && m.renderLibrary()).catch(() => {});
}

/** 첫 실행 모드 선택 모달. 두 모드 카드 중 하나를 고르면 저장하고 닫는다. */
export function showAppModePicker() {
  if (document.getElementById('app-mode-picker')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'app-mode-picker';

  const card = (m) => `
    <button type="button" class="mode-card" data-mode="${m.id}">
      <div class="mode-card-emoji">${m.emoji}</div>
      <div class="mode-card-label">${m.label}</div>
      <div class="mode-card-tagline">${m.tagline}</div>
      <div class="mode-card-desc">${m.desc}</div>
      <div class="mode-card-supports">지원: ${m.supports}</div>
    </button>`;

  overlay.innerHTML = `
    <div class="modal-content mode-picker-modal">
      <div class="mode-picker-header">
        <h3>어떤 용도로 쓰실 건가요?</h3>
        <p class="mode-picker-sub">라이브 방송인가요, 녹음(커버 제작)인가요? 나중에 설정에서 언제든 바꿀 수 있어요.</p>
      </div>
      <div class="mode-card-grid">
        ${card(APP_MODES.live)}
        ${card(APP_MODES.recording)}
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.mode-card').forEach((btn) => {
    btn.onclick = () => {
      setAppMode(btn.dataset.mode);
      overlay.remove();
      refreshAfterModeChange();
    };
  });
}

/** 설정 → 일반의 "앱 모드" 카드(세그먼트 버튼) 상태를 현재 모드에 맞춘다. */
function renderModeSetting() {
  const wrap = document.getElementById('app-mode-seg');
  if (!wrap) return;
  const cur = getEffectiveMode();
  wrap.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === cur);
  });
  const desc = document.getElementById('app-mode-desc');
  if (desc) desc.textContent = APP_MODES[cur] ? APP_MODES[cur].desc : '';
}

export function initAppModeControls() {
  applyAppModeToBody();

  // 설정의 세그먼트 버튼 배선.
  const wrap = document.getElementById('app-mode-seg');
  if (wrap) {
    wrap.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (setAppMode(btn.dataset.mode)) refreshAfterModeChange();
      });
    });
    renderModeSetting();
  }

  // 첫 실행이면 선택 모달.
  if (!isModeChosen()) showAppModePicker();
}
