/**
 * layer-stack.js — 떠 있는 것(모달·메뉴·패널)을 한 줄로 세우는 스택
 *
 * 문제: Escape를 처리하는 keydown 리스너가 6개 파일에 흩어져 있었고 서로를
 * 몰랐다. 그래서 Esc 한 번에 여러 개가 같이 닫히거나(확인 모달 뒤의 편집
 * 모달까지), 반대로 정해진 닫기 함수를 우회해 상태가 새기도 했다.
 * 대표적으로 controls/library.js가 `.modal-overlay.active`를 통째로 지워서
 * 정보 수정 모달의 closeEditModal()이 실행되지 않았다.
 *
 * 해결: Escape 리스너는 이 파일에 딱 하나. 최상단 레이어의 close()만 부른다.
 * 포커스 기억·복귀와 Tab 순환도 여기서 한 번에 처리한다.
 *
 * 쌓고 빼고 고르는 **규칙**은 layer-stack-core.js에 따로 있다(DOM이 없어야
 * 테스트할 수 있어서). 여기는 DOM을 만지는 일과, "이 레이어가 화면에 아직
 * 있는가"를 실제로 판정하는 일만 한다.
 */
import { pruneStack, topOf, hasLive, removeHandle, wasTop } from './layer-stack-core.js';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** @type {{id:string, el:Element|null, close:Function, trapFocus:boolean, restoreFocus:Element|null}[]} */
let stack = [];
let listening = false;

function focusables(el) {
  if (!el) return [];
  return Array.from(el.querySelectorAll(FOCUSABLE))
    .filter((node) => node.offsetParent !== null || node === document.activeElement);
}

/**
 * 이 레이어가 아직 실제로 화면에 있는가.
 *
 * `getClientRects()`는 `display:none`(모달의 .active가 빠졌거나 hidden 속성이
 * 걸린 상태)이면 빈 목록을 준다. position:fixed 요소도 보이는 동안은 사각형이
 * 있으므로 모달·패널 모두에 쓸 수 있다.
 */
function isAlive(handle) {
  const el = handle.el;
  // 요소를 안 준 레이어는 판단할 근거가 없으니 살아 있다고 본다.
  if (!el) return true;
  if (!el.isConnected) return false;
  return el.getClientRects().length > 0;
}

/**
 * 화면에서 이미 사라졌는데 스택에 남은 레이어를 걷어낸다.
 * 누수는 여전히 버그이므로 조용히 넘어가지 않고 경고를 남긴다.
 */
function pruneStale() {
  if (!stack.length) return;
  const { stack: next, dropped } = pruneStack(stack, isAlive);
  if (dropped.length) {
    console.warn('[LayerStack] 닫혔는데 스택에 남아 있던 레이어를 정리했습니다:',
      dropped.map((h) => h.id));
    stack = next;
  }
}

function onKeyDown(e) {
  pruneStale();
  const top = topOf(stack, isAlive);
  if (!top) return;

  if (e.key === 'Escape') {
    // 최상단 하나만 닫는다 — 겹쳐 있는 나머지는 그대로 둔다.
    e.preventDefault();
    e.stopPropagation();
    try {
      top.close();
    } catch (err) {
      console.error('[LayerStack] close failed:', err);
      popLayer(top);
    }
    return;
  }

  if (e.key === 'Tab' && top.trapFocus && top.el) {
    const items = focusables(top.el);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && (active === first || !top.el.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !top.el.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }
}

function ensureListening() {
  if (listening) return;
  // 캡처 단계 — 화면별 keydown 핸들러보다 먼저 Esc를 가져간다.
  document.addEventListener('keydown', onKeyDown, true);
  listening = true;
}

/**
 * 레이어를 올린다.
 * @param {object} opts
 * @param {Element} [opts.el] 레이어의 루트. 포커스 이동·Tab 순환의 범위.
 * @param {Function} opts.close 닫는 함수. Esc를 받으면 이것만 호출된다.
 *   (실제로 스택에서 빼는 것은 그 함수가 popLayer를 부를 때다 — 닫기 경로가
 *    버튼 클릭이든 Esc든 하나로 모이게 하기 위해서다.)
 * @param {boolean} [opts.trapFocus=true]
 * @param {boolean} [opts.autoFocus=true]
 * @param {string} [opts.id] 디버깅용 이름.
 * @returns {object} popLayer에 넘길 핸들
 */
export function pushLayer({ el = null, close, trapFocus = true, autoFocus = true, id = 'layer' }) {
  if (typeof close !== 'function') throw new Error('pushLayer: close() is required');
  ensureListening();

  const active = document.activeElement;
  const handle = {
    id,
    el,
    close,
    trapFocus,
    restoreFocus: active instanceof HTMLElement ? active : null,
  };
  stack.push(handle);

  if (autoFocus && el) {
    // 보이게 된 직후 바로 잡는다 — rAF로 미루면 그 사이 초점이 body로 빠진다.
    const target = el.querySelector('[data-autofocus]') || focusables(el)[0];
    if (target) {
      try { target.focus(); } catch (err) { /* 포커스 불가 요소는 무시 */ }
    }
  }

  return handle;
}

/** 레이어를 내린다. 스택 중간에 있어도 안전하다. */
export function popLayer(handle) {
  if (!handle) return;
  const { stack: next, removedIndex } = removeHandle(stack, handle);
  if (removedIndex === -1) return;
  stack = next;

  // 포커스 복귀는 최상단이었을 때만 — 아래쪽이 닫히면서 위 레이어의 포커스를
  // 빼앗아 가면 안 된다.
  if (wasTop(removedIndex, stack.length)
      && handle.restoreFocus && document.contains(handle.restoreFocus)) {
    try { handle.restoreFocus.focus(); } catch (err) { /* 사라진 요소는 무시 */ }
  }
}

/**
 * 지금 떠 있는 것이 있는지. 화면별 단축키가 스스로 물러날 때 쓴다.
 * 화면에서 사라진 레이어는 세지 않는다(pruneStale 주석 참고).
 */
export function hasOpenLayer() {
  pruneStale();
  return hasLive(stack, isAlive);
}

export function topLayer() {
  pruneStale();
  return topOf(stack, isAlive);
}

/** 테스트·비상용. */
export function clearLayers() {
  stack = [];
}
