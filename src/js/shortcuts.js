/**
 * shortcuts.js — 단축키 한 곳에 모으기
 *
 * 지금까지 단축키는 controls/library.js·live-screen.js·alignment-viewer.js의
 * keydown 블록에 하드코딩돼 있었다. 그래서 (1) 어떤 키가 있는지 알려면 코드를
 * 읽어야 했고 (2) 새 키를 넣을 때 충돌을 눈으로 확인할 수밖에 없었으며
 * (3) 사용자에게 보여줄 목록을 만들 방법이 없었다.
 *
 * 여기서 등록하면 동작과 도움말이 같은 곳에서 나온다. 판정 로직(텍스트 입력
 * 중인가 / 위에 모달이 떠 있는가)도 한 곳에 모아 화면마다 다르게 새지 않는다.
 *
 * 이관 범위에 대해 — 가사 싱크 편집기와 라이브 화면은 캡처 단계 처리와 Space
 * 선점 등 타이밍에 민감해서 리스너를 그대로 두고 registerDocsOnly()로 목록에만
 * 올린다. 기본기 정리가 편집기 동작을 흔들 이유는 없다.
 */
import { isTextEntryDescriptor } from './alignment-input-policy.js';

/** 표시 순서를 정하는 그룹 목록. 치트시트가 이 순서로 그린다. */
export const GROUPS = [
  { id: 'navigation', label: '이동' },
  { id: 'app', label: '앱' },
  { id: 'library', label: '음원 관리' },
  { id: 'alignment', label: '가사 싱크' },
  { id: 'live', label: '라이브' },
];

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'];

/** e.code → 조합키 표기. IME(한글 입력기)가 켜져 있어도 흔들리지 않게 code를 쓴다. */
function keyFromCode(code) {
  if (!code) return '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  const named = {
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';',
    Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    Space: 'Space', Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'Delete',
  };
  return named[code] || code;
}

/**
 * "ctrl+f", "Shift+Ctrl+F", "F11" 같은 표기를 하나의 정규형으로 만든다.
 * 수식키 순서·대소문자가 달라도 같은 키로 취급된다.
 */
export function normalizeCombo(combo) {
  if (!combo) return '';
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  // "Ctrl++" 처럼 키 자체가 +인 경우를 살린다.
  if (!parts.length) return String(combo).trim();

  const mods = new Set();
  let key = '';
  parts.forEach((raw) => {
    const lower = raw.toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'meta') mods.add('Ctrl');
    else if (lower === 'alt' || lower === 'option') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else key = raw;
  });

  if (!key) return '';
  // 한 글자 알파벳은 대문자로, 이름 있는 키(ArrowLeft 등)는 표기를 맞춘다.
  if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  else if (/^f\d{1,2}$/i.test(key)) key = key.toUpperCase();
  else {
    const canonical = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space',
      'Enter', 'Escape', 'Backspace', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Delete']
      .find((k) => k.toLowerCase() === key.toLowerCase());
    if (canonical) key = canonical;
  }

  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** 키 이벤트에서 정규형 조합 문자열을 뽑는다. */
export function comboFromEvent(e) {
  const key = keyFromCode(e.code) || (e.key === ' ' ? 'Space' : e.key);
  if (!key || ['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

/** 텍스트를 입력 중인 곳에서 발생한 이벤트인가. */
export function isTextEditingTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('[contenteditable="true"]')) return true;
  const type = (target.getAttribute?.('type') || 'text').toLowerCase();
  return isTextEntryDescriptor(target.tagName, type, false);
}

/**
 * 화면 전환 뒤 나타나는 검색창처럼 몇 프레임 기다렸다 포커스하는 경우,
 * 단축키를 누르기 전부터 잡혀 있던 버튼 포커스는 "사용자 개입"이 아니다.
 * 기다리는 동안 다른 요소로 포커스가 바뀐 경우에만 포커스 탈취를 멈춘다.
 */
export function shouldAbortDeferredFocus(active, initialActive, target, body) {
  const sameLogicalOrigin = active === initialActive
    || (!!active?.id && active.id === initialActive?.id);
  return !!active && active !== body && active !== target && !sameLogicalOrigin;
}

/** @type {Map<string, object[]>} 정규형 조합 → 등록 항목들 */
const bindings = new Map();
/** 동작 없이 도움말에만 올리는 항목 */
const docsOnly = [];

/**
 * 단축키를 등록한다.
 * @param {object} entry
 * @param {string} entry.combo "Ctrl+F", "Alt+ArrowLeft"
 * @param {'global'|'library'|'alignment'|'live'|'settings'|'tasks'} [entry.scope='global']
 * @param {string} entry.group GROUPS의 id
 * @param {string} entry.label 도움말에 보일 설명
 * @param {Function} entry.handler (event) => void
 * @param {boolean} [entry.allowInEditing=false] 입력창 안에서도 발동할지
 * @param {boolean} [entry.allowOverLayer=false] 모달이 떠 있어도 발동할지
 */
export function register(entry) {
  const combo = normalizeCombo(entry.combo);
  if (!combo) {
    console.warn('[Shortcuts] invalid combo:', entry.combo);
    return;
  }
  const item = {
    scope: 'global',
    allowInEditing: false,
    allowOverLayer: false,
    ...entry,
    combo,
  };
  const list = bindings.get(combo) || [];
  list.push(item);
  bindings.set(combo, list);
}

/** 리스너는 다른 곳에 있고 목록에만 올리고 싶을 때. */
export function registerDocsOnly({ combo, group, label, scope = 'global' }) {
  docsOnly.push({ combo: normalizeCombo(combo) || combo, group, label, scope, docsOnly: true });
}

/**
 * 조건에 맞는 등록 항목을 찾는다. DOM 없이 테스트할 수 있게 상태를 인자로 받는다.
 * 같은 조합에 여러 개가 걸려 있으면 화면 전용이 전역보다 우선한다.
 */
export function matchShortcut(combo, { activeView, textEditing = false, layerOpen = false } = {}) {
  const list = bindings.get(normalizeCombo(combo));
  if (!list || !list.length) return null;

  const usable = list.filter((item) => {
    if (item.scope !== 'global' && item.scope !== activeView) return false;
    if (textEditing && !item.allowInEditing) return false;
    if (layerOpen && !item.allowOverLayer) return false;
    return true;
  });
  if (!usable.length) return null;
  return usable.find((item) => item.scope !== 'global') || usable[0];
}

/** 치트시트용 — 그룹 순서대로 묶어 반환한다. */
export function listShortcuts() {
  const all = [];
  bindings.forEach((list) => list.forEach((item) => all.push(item)));
  docsOnly.forEach((item) => all.push(item));

  return GROUPS.map((group) => ({
    ...group,
    items: all.filter((item) => item.group === group.id),
  })).filter((group) => group.items.length > 0);
}

/** 테스트용. */
export function clearShortcuts() {
  bindings.clear();
  docsOnly.length = 0;
}

let started = false;

/**
 * 실제 키보드에 연결한다. state와 layer-stack은 여기서만 참조해서
 * 위 로직이 DOM·전역 상태 없이 테스트 가능하게 남는다.
 */
export function initShortcuts({ getActiveView, isLayerOpen }) {
  if (started) return;
  started = true;

  window.addEventListener('keydown', (e) => {
    const combo = comboFromEvent(e);
    if (!combo) return;

    const hit = matchShortcut(combo, {
      activeView: getActiveView(),
      textEditing: isTextEditingTarget(e.target),
      layerOpen: isLayerOpen(),
    });
    if (!hit || typeof hit.handler !== 'function') return;

    // 길게 눌러 반복 입력되는 것은 목록 이동처럼 명시한 키만 허용한다.
    // (Space로 재생/정지가 연타되는 사고를 막는다.)
    if (e.repeat && !hit.repeatable) return;

    if (hit.preventDefault !== false) e.preventDefault();
    try {
      hit.handler(e);
    } catch (err) {
      console.error(`[Shortcuts] "${hit.combo}" handler failed:`, err);
    }
  });
}
