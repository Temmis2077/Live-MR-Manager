import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeCombo, comboFromEvent, register, registerDocsOnly,
  matchShortcut, listShortcuts, clearShortcuts,
  shouldAbortDeferredFocus,
} from '../src/js/shortcuts.js';

/** 실제 KeyboardEvent 없이 판정할 수 있게 최소 형태만 흉내낸다. */
const keyEvent = (code, mods = {}) => ({
  code,
  key: code,
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
  ...mods,
});

describe('normalizeCombo', () => {
  it('대소문자와 수식키 순서가 달라도 같은 키로 본다', () => {
    expect(normalizeCombo('ctrl+f')).toBe('Ctrl+F');
    expect(normalizeCombo('Shift+Ctrl+F')).toBe('Ctrl+Shift+F');
    expect(normalizeCombo('CTRL+SHIFT+f')).toBe('Ctrl+Shift+F');
  });

  it('Cmd와 Ctrl을 같게 취급한다 (맥에서도 같은 표에 걸리게)', () => {
    expect(normalizeCombo('Cmd+Z')).toBe(normalizeCombo('Ctrl+Z'));
  });

  it('이름 있는 키의 표기를 맞춘다', () => {
    expect(normalizeCombo('alt+arrowleft')).toBe('Alt+ArrowLeft');
    expect(normalizeCombo('f11')).toBe('F11');
    expect(normalizeCombo('space')).toBe('Space');
  });

  it('기호 키를 그대로 살린다', () => {
    expect(normalizeCombo('Ctrl+,')).toBe('Ctrl+,');
    expect(normalizeCombo('Shift+/')).toBe('Shift+/');
  });

  it('키 없이 수식키만 있으면 빈 문자열', () => {
    expect(normalizeCombo('Ctrl')).toBe('');
    expect(normalizeCombo('')).toBe('');
  });
});

describe('comboFromEvent', () => {
  it('e.code로 읽어 한글 입력기가 켜져 있어도 흔들리지 않는다', () => {
    // 한글 IME가 켜져 있으면 e.key는 'ㄹ' 같은 값이 되지만 code는 그대로다.
    expect(comboFromEvent({ ...keyEvent('KeyF', { ctrlKey: true }), key: 'ㄹ' })).toBe('Ctrl+F');
  });

  it('숫자·기호·기능키를 읽는다', () => {
    expect(comboFromEvent(keyEvent('Digit2', { ctrlKey: true }))).toBe('Ctrl+2');
    expect(comboFromEvent(keyEvent('Comma', { ctrlKey: true }))).toBe('Ctrl+,');
    expect(comboFromEvent(keyEvent('Slash', { shiftKey: true }))).toBe('Shift+/');
    expect(comboFromEvent(keyEvent('F11'))).toBe('F11');
    expect(comboFromEvent(keyEvent('ArrowLeft', { altKey: true }))).toBe('Alt+ArrowLeft');
  });

  it('수식키 자체를 누른 것은 조합으로 치지 않는다', () => {
    expect(comboFromEvent({ ...keyEvent('ShiftLeft'), code: '', key: 'Shift' })).toBe('');
  });
});

describe('deferred focus guard', () => {
  it('keeps waiting while the shortcut origin still has focus', () => {
    const body = {};
    const origin = {};
    const target = {};
    expect(shouldAbortDeferredFocus(origin, origin, target, body)).toBe(false);
    expect(shouldAbortDeferredFocus({ id: 'screen-button' }, { id: 'screen-button' }, target, body)).toBe(false);
    expect(shouldAbortDeferredFocus(body, origin, target, body)).toBe(false);
    expect(shouldAbortDeferredFocus(target, origin, target, body)).toBe(false);
  });

  it('stops when the user focuses a different element while waiting', () => {
    expect(shouldAbortDeferredFocus({}, {}, {}, {})).toBe(true);
  });
});

describe('matchShortcut', () => {
  beforeEach(() => {
    clearShortcuts();
    register({ combo: 'Ctrl+F', group: 'navigation', label: '검색', handler: () => {} });
    register({ combo: 'Space', scope: 'library', group: 'library', label: '재생', handler: () => {} });
    register({
      combo: 'Shift+/', group: 'app', label: '도움말', allowOverLayer: true, handler: () => {},
    });
  });

  it('전역 단축키는 어느 화면에서나 잡힌다', () => {
    expect(matchShortcut('Ctrl+F', { activeView: 'live' })).toBeTruthy();
    expect(matchShortcut('Ctrl+F', { activeView: 'alignment' })).toBeTruthy();
  });

  it('화면 전용 단축키는 그 화면에서만 잡힌다', () => {
    expect(matchShortcut('Space', { activeView: 'library' })).toBeTruthy();
    expect(matchShortcut('Space', { activeView: 'alignment' })).toBe(null);
  });

  it('입력창에 초점이 있으면 발동하지 않는다', () => {
    expect(matchShortcut('Space', { activeView: 'library', textEditing: true })).toBe(null);
  });

  it('모달이 떠 있으면 물러나되, 허용한 것은 남는다', () => {
    expect(matchShortcut('Ctrl+F', { activeView: 'library', layerOpen: true })).toBe(null);
    expect(matchShortcut('Shift+/', { activeView: 'library', layerOpen: true })).toBeTruthy();
  });

  it('등록 표기와 조회 표기가 달라도 찾는다', () => {
    expect(matchShortcut('ctrl+f', { activeView: 'library' })).toBeTruthy();
  });

  it('같은 조합이면 화면 전용이 전역보다 우선한다', () => {
    register({ combo: 'Ctrl+F', scope: 'library', group: 'library', label: '화면 전용', handler: () => {} });
    expect(matchShortcut('Ctrl+F', { activeView: 'library' }).label).toBe('화면 전용');
    expect(matchShortcut('Ctrl+F', { activeView: 'live' }).label).toBe('검색');
  });

  it('등록되지 않은 키는 null', () => {
    expect(matchShortcut('Ctrl+Q', { activeView: 'library' })).toBe(null);
  });
});

describe('listShortcuts', () => {
  beforeEach(() => {
    clearShortcuts();
    register({ combo: 'Ctrl+F', group: 'navigation', label: '검색', handler: () => {} });
    register({ combo: 'Space', scope: 'library', group: 'library', label: '재생', handler: () => {} });
    registerDocsOnly({ combo: 'Ctrl+Z', group: 'alignment', scope: 'alignment', label: '실행 취소' });
  });

  it('그룹별로 묶고, 비어 있는 그룹은 뺀다', () => {
    const groups = listShortcuts();
    expect(groups.map((g) => g.id)).toEqual(['navigation', 'library', 'alignment']);
    expect(groups[0].items[0].label).toBe('검색');
  });

  it('다른 곳에서 처리하는 키도 목록에는 나온다', () => {
    const alignment = listShortcuts().find((g) => g.id === 'alignment');
    expect(alignment.items[0].combo).toBe('Ctrl+Z');
    // 목록 전용이므로 실제 조회에서는 잡히지 않는다.
    expect(matchShortcut('Ctrl+Z', { activeView: 'alignment' })).toBe(null);
  });
});
