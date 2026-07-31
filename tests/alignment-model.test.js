import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALIGNMENT_LANGUAGES,
  findModelForLanguage,
  getAlignmentLanguage,
  missingModelsForLanguage,
  requiredLanguagesFor,
  setAlignmentLanguage,
} from '../src/js/alignment-model.js';

const store = {};
globalThis.localStorage = {
  getItem: (key) => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: (key) => { delete store[key]; },
};

describe('alignment language selection', () => {
  const models = [
    '한국어 가사 정렬 모델|C:\\Users\\x\\models\\wav2vec2-korean-lyrics',
    '영어 가사 정렬 모델|C:\\Users\\x\\models\\wav2vec2-english-lyrics',
  ];

  beforeEach(() => { for (const key in store) delete store[key]; });

  it('defaults to phonetic mixed-language mode and only persists selectable values', () => {
    expect(getAlignmentLanguage()).toBe('en-ko');
    setAlignmentLanguage('en');
    expect(getAlignmentLanguage()).toBe('en');
    setAlignmentLanguage('rap');
    expect(getAlignmentLanguage()).toBe('en');
  });

  it('migrates the retired rap setting to en-ko', () => {
    localStorage.setItem('alignmentLanguage', 'rap');
    expect(getAlignmentLanguage()).toBe('en-ko');
  });

  it('maps each selectable mode to one primary model', () => {
    expect(requiredLanguagesFor('ko')).toEqual(['ko']);
    expect(requiredLanguagesFor('en')).toEqual(['en']);
    expect(requiredLanguagesFor('en-ko')).toEqual(['ko']);
  });

  it('finds models by their installed folder id', () => {
    expect(findModelForLanguage(models, 'ko')).toBe(models[0]);
    expect(findModelForLanguage(models, 'en')).toBe(models[1]);
    expect(findModelForLanguage(models, 'rap')).toBeNull();
  });

  it('requires only the Korean model for en-ko', () => {
    expect(missingModelsForLanguage([models[0]], 'en-ko')).toEqual([]);
    expect(missingModelsForLanguage([], 'en-ko')).toMatchObject([
      { lang: 'ko', downloadableId: 'wav2vec2-korean-lyrics' },
    ]);
    expect(ALIGNMENT_LANGUAGES.rap).toBeUndefined();
  });
});
