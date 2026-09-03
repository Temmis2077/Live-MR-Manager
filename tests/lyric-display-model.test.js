import { beforeEach, describe, expect, it } from 'vitest';
import { getDisplayLineModel } from '../src/js/lrc-parser.js';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  clear: () => values.clear(),
};

const triplet = {
  triplet: true,
  original: '原文',
  pronunciation: '차음',
  translation: '번역',
};

describe('lyric display model', () => {
  beforeEach(() => localStorage.clear());

  it('marks only pronunciation as the triplet progress target', () => {
    localStorage.setItem('lyricsLineVisibility_app', JSON.stringify({
      original: true, pronunciation: true, translation: true,
    }));
    const model = getDisplayLineModel(triplet, 'app');
    expect(model.map((line) => [line.role, line.progressTarget])).toEqual([
      ['original', false], ['pronunciation', true], ['translation', false],
    ]);
  });

  it('does not fall back to original progress when pronunciation is hidden', () => {
    localStorage.setItem('lyricsLineVisibility_overlay', JSON.stringify({
      original: true, pronunciation: false, translation: true,
    }));
    const model = getDisplayLineModel(triplet, 'overlay');
    expect(model.map((line) => line.text)).toEqual(['原文', '번역']);
    expect(model.some((line) => line.progressTarget)).toBe(false);
  });

  it('keeps plain lyrics as the progress target', () => {
    expect(getDisplayLineModel({ text: 'plain line' })).toEqual([
      { text: 'plain line', role: 'text', progressTarget: true },
    ]);
  });
});
