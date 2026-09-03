/**
 * shortcut-help.js — 단축키 도움말 (치트시트)
 *
 * 단축키가 있어도 알 방법이 없으면 없는 것과 같다. 이 화면은 shortcuts.js에
 * 등록된 내용을 그대로 읽어서 그린다 — 목록을 따로 관리하지 않으므로 키를
 * 추가하면 여기에도 자동으로 나온다.
 */
import { listShortcuts } from '../shortcuts.js';
import { openOverlayModal, closeOverlayModal } from './modals.js';

const MODAL_ID = 'shortcut-help-modal';

/** 조합 문자열을 화면에 보일 <kbd> 조각으로 바꾼다. */
function renderCombo(combo) {
  const pretty = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Space: 'Space', Enter: 'Enter', Escape: 'Esc',
  };
  return String(combo).split('+')
    .map((part) => `<kbd>${pretty[part] || part}</kbd>`)
    .join('<span class="kbd-plus">+</span>');
}

function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
      <header class="modal-header">
        <h3 id="shortcut-help-title">단축키</h3>
        <button type="button" class="close-btn" id="shortcut-help-close" aria-label="닫기">&times;</button>
      </header>
      <div class="modal-body" id="shortcut-help-body"></div>
      <footer class="shortcut-help-foot">글자를 입력하는 칸에 초점이 있을 때는 단축키가 동작하지 않습니다.</footer>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById('shortcut-help-close')
    ?.addEventListener('click', closeShortcutHelp);
  return modal;
}

function render() {
  const body = document.getElementById('shortcut-help-body');
  if (!body) return;

  const groups = listShortcuts();
  if (!groups.length) {
    body.innerHTML = '<div class="shortcut-empty">등록된 단축키가 없습니다.</div>';
    return;
  }

  body.innerHTML = groups.map((group) => `
    <section class="shortcut-group">
      <h4>${group.label}</h4>
      <dl>
        ${group.items.map((item) => `
          <div class="shortcut-row">
            <dt>${renderCombo(item.combo)}</dt>
            <dd>${item.label}</dd>
          </div>`).join('')}
      </dl>
    </section>`).join('');
}

export function openShortcutHelp() {
  const modal = ensureModal();
  if (modal.classList.contains('active')) return;
  render();
  openOverlayModal(modal, { closeIconId: 'shortcut-help-close' });
}

export function closeShortcutHelp() {
  const modal = document.getElementById(MODAL_ID);
  if (modal) closeOverlayModal(modal);
}

export function toggleShortcutHelp() {
  const modal = document.getElementById(MODAL_ID);
  if (modal && modal.classList.contains('active')) closeShortcutHelp();
  else openShortcutHelp();
}
