import { describe, expect, it } from 'vitest';
import {
  buildAlignmentLyrics,
  hasUserEditedPronunciation,
  isEnglishLine,
  transliterateEnglish,
} from '../src/js/eng-to-kor.js';

describe('English phonetic alignment preprocessing', () => {
  it('detects English and converts common lyric words', () => {
    expect(isEnglishLine("Oh I'm drowning")).toBe(true);
    expect(transliterateEnglish("Oh I'm drowning")).toContain('오');
    expect(transliterateEnglish("Oh I'm drowning")).toContain('드라우닝');
  });

  it('handles consonant approximations and contractions', () => {
    const result = transliterateEnglish("I can't breathe through five");
    expect(result).not.toMatch(/[A-Za-z]/);
    expect(result.length).toBeGreaterThan(2);
  });

  it('normalizes smart quotes before applying contraction pronunciation rules', () => {
    expect(transliterateEnglish('Oh I’m drowning')).toContain('아임');
    expect(transliterateEnglish('You’re taking my life')).toContain('유어');
    expect(transliterateEnglish("I can't breathe")).toContain('캔트');
  });

  it('preserves Korean content in mixed lines', () => {
    const { segments } = buildAlignmentLyrics([
      { text: '사랑 my love', start: 0, end: 0 },
      { text: '너를 바라봐', start: 0, end: 0 },
    ]);
    expect(segments[0].original).toBe('사랑 my love');
    expect(segments[0].pronunciation).toContain('사랑');
    expect(segments[0].pronunciation).not.toContain('my');
    expect(segments[1].text).toBe('너를 바라봐');
    expect(segments[1].pronunciation).toBeUndefined();
  });

  it('keeps a user-edited pronunciation', () => {
    const segment = {
      original: "It's raining",
      pronunciation: '잇 레이닝',
      start: 0,
      end: 0,
    };
    expect(hasUserEditedPronunciation(segment)).toBe(true);
    const prepared = buildAlignmentLyrics([segment]).segments[0];
    expect(prepared.pronunciation).toBe('잇 레이닝');
  });

  it('returns stable input and original segment indices', () => {
    const result = buildAlignmentLyrics([
      { text: '한국어', start: 0, end: 0 },
      { text: 'Oh drowning', start: 0, end: 0 },
    ]);
    expect(result.allTexts).toHaveLength(2);
    expect(result.entries[0].segmentIndex).toBe(0);
    expect(result.entries[1].segmentIndex).toBe(1);
    expect(result.entries[1].isEnglish).toBe(true);
    expect(result.entries[1].skipPrimary).toBe(true);
    expect(result.segments[1].original).toBe('Oh drowning');
    expect(result.segments[1]._skipPrimary).toBe(true);
  });

  it('keeps generated pronunciation temporary and leaves the original segment untouched', () => {
    const original = { text: 'Oh drowning', start: 1, end: 2 };
    const prepared = buildAlignmentLyrics([original]);
    expect(original).toEqual({ text: 'Oh drowning', start: 1, end: 2 });
    expect(prepared.segments[0].pronunciation).toBe('오 드라우닝');
  });

  it('marks unusably short generated phonetics for English-only fallback', () => {
    const prepared = buildAlignmentLyrics([{ text: 'A', start: 0, end: 0 }]);
    expect(prepared.segments[0]._alignmentSkip).toBe(true);
    expect(prepared.entries[0]).toMatchObject({ skipPrimary: true, fallbackCandidate: true });
  });
});
