import { describe, expect, it, beforeEach } from 'vitest';

// localStorage 스텁 (app-mode.js가 읽고 씀).
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

import {
  getAppMode, setAppMode, isModeChosen, getEffectiveMode, isValidMode, DEFAULT_MODE, APP_MODES,
} from '../src/js/app-mode.js';

describe('app mode', () => {
  beforeEach(() => { for (const k in store) delete store[k]; });

  it('is unchosen by default and effective mode falls back to live', () => {
    expect(getAppMode()).toBeNull();
    expect(isModeChosen()).toBe(false);
    expect(getEffectiveMode()).toBe(DEFAULT_MODE);
    expect(DEFAULT_MODE).toBe('live');
  });

  it('persists a valid choice and reports it chosen', () => {
    expect(setAppMode('recording')).toBe(true);
    expect(getAppMode()).toBe('recording');
    expect(isModeChosen()).toBe(true);
    expect(getEffectiveMode()).toBe('recording');
  });

  it('rejects invalid modes without changing state', () => {
    setAppMode('live');
    expect(setAppMode('pro')).toBe(false);
    expect(setAppMode('')).toBe(false);
    expect(getAppMode()).toBe('live'); // 기존 선택 보존
  });

  it('treats a corrupt stored value as unchosen', () => {
    store.appMode = 'garbage';
    expect(getAppMode()).toBeNull();
    expect(getEffectiveMode()).toBe('live');
  });

  it('exposes both modes with the labels the picker needs', () => {
    expect(isValidMode('live')).toBe(true);
    expect(isValidMode('recording')).toBe(true);
    expect(APP_MODES.live.label).toBe('라이브');
    expect(APP_MODES.recording.label).toBe('녹음');
  });
});
