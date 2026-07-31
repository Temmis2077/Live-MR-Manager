import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mergeAlignmentResult } from '../src/js/lrc-parser.js';

// alignment-model.js(언어→모델 매핑)가 localStorage를 읽으므로 스텁 제공.
// 기본 'ko'라, get_model_list 목은 한국어 폴더명이 포함된 경로를 돌려줘야 매칭됨.
const lsStore = {};
globalThis.localStorage = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};

// alignment-queue.js가 끌어오는 앱 전역 의존성(tauri invoke, state, UI 갱신)을
// 전부 목으로 대체 — 순차 처리 로직만 격리해서 검증한다.
vi.mock('../src/js/tauri-bridge.js', () => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../src/js/state.js', () => ({
  state: { alignmentQueue: [], songLibrary: [] },
}));
vi.mock('../src/js/ui/components.js', () => ({
  updateTaskUI: vi.fn(),
}));

import { invoke } from '../src/js/tauri-bridge.js';
import { state } from '../src/js/state.js';
import {
  enqueueAlignment,
  isAlignmentBusy,
  onAlignmentItemComplete,
  collectAlignmentAnchors,
  buildEnglishFallbackWindows,
  buildSecondPassWindows,
  enforceAiTimelineOrder,
} from '../src/js/alignment-queue.js';

describe('English fallback windows', () => {
  it('bounds a contiguous English block between nearby primary anchors', () => {
    const entries = [0, 1, 2, 3, 4].map((segmentIndex) => ({ id: `segment:${segmentIndex}`, segmentIndex }));
    const windows = buildEnglishFallbackWindows({
      fallbackEntries: [entries[1], entries[2]],
      primaryRawLines: [
        { segment_id: 'segment:1', start_ms: 2000, end_ms: 3000 },
        { segment_id: 'segment:2', start_ms: 3200, end_ms: 4000 },
      ],
      acceptedLines: [
        { segment_id: 'segment:0', start_ms: 0, end_ms: 1000 },
        { segment_id: 'segment:4', start_ms: 6000, end_ms: 7000 },
      ],
      entries,
      segments: entries.map(() => ({ start: 0, end: 0 })),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ windowStartMs: 1000, windowEndMs: 6000 });
    expect(windows[0].entries.map((entry) => entry.id)).toEqual(['segment:1', 'segment:2']);
  });

  it('infers a bounded fallback window when primary skips pure English lines', () => {
    const windows = buildEnglishFallbackWindows({
      fallbackEntries: [{ id: 'segment:1', segmentIndex: 1 }],
      primaryRawLines: [],
      acceptedLines: [],
      entries: [{ id: 'segment:1', segmentIndex: 1 }],
      segments: [{ start: 0, end: 0 }, { start: 0, end: 0 }],
    });
    expect(windows[0]).toMatchObject({ windowStartMs: 0, windowEndMs: 9000 });
  });
});

describe('collectAlignmentAnchors', () => {
  it('makes synced lines into (index, ms) anchors and skips unsynced ones', () => {
    const segments = [
      { text: '첫 줄', start: 3, end: 5 },      // synced → anchor at 3000ms
      { text: '둘째 줄', start: 0, end: 0 },     // unsynced → no anchor
      { text: '셋째 줄', start: 8.5, end: 10 },  // synced → anchor at 8500ms
    ];
    const { allTexts, anchors } = collectAlignmentAnchors(segments, {});
    expect(allTexts).toEqual(['첫 줄', '둘째 줄', '셋째 줄']);
    expect(anchors).toEqual([[0, 3000], [2, 8500]]);
  });

  it('completely ignores vocalStart during alignment', () => {
    const segments = [
      { text: '첫 줄', start: 0, end: 0 },
      { text: '둘째 줄', start: 0, end: 0 },
    ];
    const { anchors } = collectAlignmentAnchors(segments, { vocalStartSec: 12.34 });
    // 보컬 시작 마커는 재생/표시용일 뿐, AI 정렬의 하드 앵커가 아니다.
    expect(anchors).toEqual([]);
  });

  it('keeps manual lyric anchors but ignores vocalStart', () => {
    const segments = [{ text: '첫 줄', start: 2, end: 4 }];
    const { anchors } = collectAlignmentAnchors(segments, { vocalStartSec: 12.34 });
    expect(anchors).toEqual([[0, 2000]]);
  });

  it('does not promote an AI approx result to a hard manual anchor', () => {
    const segments = [
      { text: 'AI 결과', start: 2, end: 4, approx: true },
      { text: '수동 확정', start: 6, end: 8 },
    ];
    const { anchors } = collectAlignmentAnchors(segments, {});
    expect(anchors).toEqual([[1, 6000]]);
  });

  it('ignores interlude markers during alignment', () => {
    const segments = [
      { text: '첫 줄', start: 0, end: 0 },
      { text: '둘째 줄', start: 0, end: 0 },
    ];
    const { allTexts, anchors } = collectAlignmentAnchors(segments, {
      vocalStartSec: 4,
      interludes: [{ start: 10, end: 30 }],
    });
    expect(allTexts).toEqual(['첫 줄', '둘째 줄']);
    expect(anchors).toEqual([]);
  });

  it('does not treat a structure label as an alignment line', () => {
    const segments = [
      { text: '간주', start: 10, end: 20 },
      { text: '첫 줄', start: 0, end: 0 },
    ];
    const { allTexts, anchors } = collectAlignmentAnchors(segments, {});
    expect(allTexts).toEqual(['첫 줄']);
    expect(anchors).toEqual([]);
  });

  it('skips empty sync-text lines when indexing anchors', () => {
    const segments = [
      { text: '', start: 3, end: 5 },        // empty sync text → not in allTexts
      { text: '진짜 줄', start: 6, end: 8 },  // index 0 in allTexts
    ];
    const { allTexts, anchors } = collectAlignmentAnchors(segments, {});
    expect(allTexts).toEqual(['진짜 줄']);
    expect(anchors).toEqual([[0, 6000]]);
  });

  it('keeps pure English IDs but sends blank primary text for Korean pass', () => {
    const { allTexts, entries } = collectAlignmentAnchors([
      { text: '한국어 줄', start: 0, end: 0 },
      { original: 'Oh drowning', pronunciation: '오 드라우닝', text: 'Oh drowning', start: 0, end: 0 },
      { text: '다음 한국어', start: 0, end: 0 },
    ], {}, { skipPureEnglish: true });
    expect(allTexts).toEqual(['한국어 줄', '', '다음 한국어']);
    expect(entries[1]).toMatchObject({ segmentIndex: 1, skipPrimary: true, fallbackCandidate: true });
  });

  it('keeps pure English text for English and dual-language passes', () => {
    const { allTexts, entries } = collectAlignmentAnchors([
      { text: '한국어 줄', start: 0, end: 0 },
      { text: 'Oh drowning', start: 0, end: 0 },
    ], {});
    expect(allTexts).toEqual(['한국어 줄', 'Oh drowning']);
    expect(entries[1]).toMatchObject({ skipPrimary: false, fallbackCandidate: false });
  });
});

describe('post-merge timeline gate', () => {
  it('drops only the weaker automatic line when starts reverse', () => {
    const segments = [
      { text: '앞줄', start: 10, end: 11, approx: true, confidence: 0.8 },
      { text: '뒷줄', start: 9.9, end: 10.5, approx: true, confidence: 0.2 },
    ];
    const dropped = enforceAiTimelineOrder(segments);
    expect(dropped.map((item) => item.id)).toEqual(['segment:1']);
    expect(segments[0].start).toBe(10);
    expect(segments[1].start).toBe(0);
  });

  it('preserves a manual line and drops a reversed automatic line', () => {
    const segments = [
      { text: '수동 줄', start: 10, end: 11, confidence: 1 },
      { text: '자동 줄', start: 9.9, end: 10.5, approx: true, confidence: 0.9 },
    ];
    const dropped = enforceAiTimelineOrder(segments);
    expect(dropped.map((item) => item.id)).toEqual(['segment:1']);
    expect(segments[0].start).toBe(10);
    expect(segments[1].start).toBe(0);
  });
});

describe('second-pass rescue windows', () => {
  it('keeps unsynced lines between accepted anchors in one bounded window', () => {
    const entries = [0, 1, 2, 3].map((segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
    }));
    const segments = [
      { text: '앞 앵커', start: 10, end: 11, approx: true },
      { text: '미싱크 하나', start: 0, end: 0 },
      { text: '미싱크 둘', start: 0, end: 0 },
      { text: '뒤 앵커', start: 20, end: 21, approx: true },
    ];
    const windows = buildSecondPassWindows({
      rescueEntries: [entries[1], entries[2]],
      segments,
      entries,
      markers: {},
      paddingMs: 2_000,
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      language: 'ko',
      windowStartMs: 9_000,
      windowEndMs: 20_000,
      windowSource: 'accepted_anchor_window',
    });
    expect(windows[0].entries.map((entry) => entry.id)).toEqual([
      'segment:1',
      'segment:2',
    ]);
    expect(windows[0].windowContext.previousAnchor).toMatchObject({ segmentIndex: 0 });
    expect(windows[0].windowContext.nextAnchor).toMatchObject({ segmentIndex: 3 });
  });

  it('splits contiguous rescue lines when their language changes', () => {
    const entries = [0, 1, 2].map((segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
    }));
    const windows = buildSecondPassWindows({
      rescueEntries: [
        { ...entries[0], language: 'ko' },
        { ...entries[1], language: 'en' },
        { ...entries[2], language: 'en' },
      ],
      segments: entries.map(() => ({ start: 0, end: 0 })),
      entries,
      markers: { vocalStartSec: 3 },
    });

    expect(windows.map((window) => window.language)).toEqual(['ko', 'en']);
    expect(windows.map((window) => window.entries.length)).toEqual([1, 2]);
    expect(windows.every((window) => window.windowEndMs > window.windowStartMs)).toBe(true);
  });
});

describe('mergeAlignmentResult', () => {
  it('fills only fully-unsynced segments and marks them approx', () => {
    const segments = [
      { text: '이미 싱크된 줄', start: 5, end: 8 },
      { text: '미싱크 줄', start: 0, end: 0 },
    ];
    const lines = [
      { text: '이미 싱크된 줄', start_ms: 1000, end_ms: 2000 },
      { text: '미싱크 줄', start_ms: 10000, end_ms: 12000 },
    ];
    const applied = mergeAlignmentResult(segments, lines);
    expect(applied).toBe(1);
    // 기존 수동 싱크는 절대 건드리지 않음
    expect(segments[0].start).toBe(5);
    expect(segments[0].end).toBe(8);
    expect(segments[0].approx).toBeUndefined();
    // 미싱크 줄만 채워지고 approx 마킹
    expect(segments[1].start).toBeCloseTo(10);
    expect(segments[1].end).toBeCloseTo(12);
    expect(segments[1].approx).toBe(true);
  });

  it('matches triplet cues by pronunciation (sync text)', () => {
    const segments = [
      { original: '忘れられぬ', pronunciation: '와스레라레누', translation: '잊지 못하는', text: '忘れられぬ', start: 0, end: 0 },
    ];
    const lines = [{ text: '와스레라레누', start_ms: 3000, end_ms: 5000 }];
    const applied = mergeAlignmentResult(segments, lines);
    expect(applied).toBe(1);
    expect(segments[0].start).toBeCloseTo(3);
  });

  it('carries per-line confidence onto the filled segment for review flagging', () => {
    const segments = [{ text: '미싱크 줄', start: 0, end: 0 }];
    const lines = [{ text: '미싱크 줄', start_ms: 1000, end_ms: 2000, confidence: 0.12 }];
    mergeAlignmentResult(segments, lines);
    expect(segments[0].confidence).toBeCloseTo(0.12);
    expect(segments[0].approx).toBe(true);
  });

  it('returns 0 for empty inputs without throwing', () => {
    expect(mergeAlignmentResult([], [])).toBe(0);
    expect(mergeAlignmentResult(null, null)).toBe(0);
  });

  it('matches lines despite punctuation the backend strips (quotes/comma/hyphen/apostrophe)', () => {
    // 백엔드는 정렬 전 clean_lyrics로 문장부호를 공백/제거하고 따옴표도 걷어내
    // 원본과 다른 텍스트를 돌려준다. 정규화 비교로 그래도 매칭돼야 한다.
    const segments = [
      { text: `Don't bend, don't break, baby, don't back down`, start: 0, end: 0 },
      { text: `Like Frankie said, "I did it my way"`, start: 0, end: 0 },
      { text: 'No silent prayer for the faith-departed', start: 0, end: 0 },
    ];
    const lines = [
      { text: 'Don t bend don t break baby don t back down', start_ms: 1000, end_ms: 2000 },
      { text: 'Like Frankie said  I did it my way', start_ms: 3000, end_ms: 4000 },
      { text: 'No silent prayer for the faith departed', start_ms: 5000, end_ms: 6000 },
    ];
    expect(mergeAlignmentResult(segments, lines)).toBe(3);
    expect(segments[0].start).toBeCloseTo(1);
    expect(segments[1].start).toBeCloseTo(3);
    expect(segments[2].start).toBeCloseTo(5);
  });

  it('places lines whose parentheses hold real chorus lyrics', () => {
    // 백엔드 clean_lyrics는 구조 지시어가 아닌 괄호는 표시만 벗기고 안의 가사를
    // 남긴다(실제로 불리는 코러스라 정렬 대상에 있어야 함). 프론트 정규화도
    // 같은 규칙이어야 매칭된다 — 예전엔 여기서 괄호 내용을 지워서 이런 줄이
    // 아예 배치되지 않았다.
    const segments = [
      { text: 'God mercy (God mercy on this ground)', start: 0, end: 0 },
      { text: 'Where the hell (where the hell is EROS going)', start: 0, end: 0 },
    ];
    const lines = [
      { text: 'God mercy  God mercy on this ground', start_ms: 1000, end_ms: 2000 },
      { text: 'Where the hell  where the hell is EROS going', start_ms: 3000, end_ms: 4000 },
    ];
    expect(mergeAlignmentResult(segments, lines)).toBe(2);
    expect(segments[0].start).toBeCloseTo(1);
    expect(segments[1].start).toBeCloseTo(3);
  });

  it('still strips structure directives so they match the backend', () => {
    // 구조 지시어는 백엔드가 통째로 지우므로, 프론트도 지워야 키가 맞는다.
    const segments = [
      { text: '[Chorus] 사랑해', start: 0, end: 0 },
      { text: '(Verse 2) 오늘도 걸어', start: 0, end: 0 },
    ];
    const lines = [
      { text: '사랑해', start_ms: 1000, end_ms: 2000 },
      { text: '오늘도 걸어', start_ms: 3000, end_ms: 4000 },
    ];
    expect(mergeAlignmentResult(segments, lines)).toBe(2);
    expect(segments[0].start).toBeCloseTo(1);
    expect(segments[1].start).toBeCloseTo(3);
  });

  it('does not reuse one alignment line for two identical lyric lines', () => {
    const segments = [
      { text: '후렴', start: 0, end: 0 },
      { text: '후렴', start: 0, end: 0 },
    ];
    const lines = [
      { text: '후렴', start_ms: 1000, end_ms: 2000 },
      { text: '후렴', start_ms: 9000, end_ms: 10000 },
    ];
    expect(mergeAlignmentResult(segments, lines)).toBe(2);
    expect(segments[0].start).toBeCloseTo(1);
    expect(segments[1].start).toBeCloseTo(9);
  });

  it('never text-rematches an ID result onto another repeated lyric block', () => {
    const segments = [
      { text: '후렴', start: 5, end: 6 },
      { text: '후렴', start: 0, end: 0 },
    ];
    const entries = [
      { id: 'segment:0', segmentIndex: 0 },
      { id: 'segment:1', segmentIndex: 1 },
    ];
    const lines = [
      { segment_id: 'segment:0', text: '후렴', start_ms: 1000, end_ms: 2000 },
    ];
    expect(mergeAlignmentResult(segments, lines, entries)).toBe(0);
    expect(segments[1]).toMatchObject({ start: 0, end: 0 });
  });
});

describe('alignment queue sequential processor', () => {
  const flushQueue = async () => {
    // 대기열이 완전히 소진될 때까지 대기 (queued/processing 항목이 없어질 때까지)
    for (let i = 0; i < 200; i++) {
      const busy = state.alignmentQueue.some((it) => it.status === 'queued' || it.status === 'processing');
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('queue did not drain');
  };

  beforeEach(() => {
    state.alignmentQueue.length = 0;
    state.songLibrary.length = 0;
    invoke.mockReset();
  });

  it('processes items strictly one at a time and skips no-lyrics songs', async () => {
    const log = [];
    const lrcByPath = {
      'song-a': '[00:00.00]가사 한 줄',
      'song-b': '', // 가사 없음 — run_forced_alignment까지 가면 안 됨
      'song-c': '[00:00.00]다른 가사',
    };

    invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'load_lrc_file':
          return lrcByPath[args.audioPath] ?? '';
        case 'get_model_list':
          return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
        case 'run_forced_alignment': {
          log.push(`align-start:${args.audioPath}`);
          await new Promise((r) => setTimeout(r, 20));
          log.push(`align-end:${args.audioPath}`);
          const firstLine = args.lyrics.split('\n')[0];
          return { lines: [{ text: firstLine, start_ms: 1000, end_ms: 2000 }] };
        }
        case 'save_lrc_file':
          log.push(`save:${args.audioPath}`);
          return 'ok';
        default:
          return null;
      }
    });

    enqueueAlignment(['song-a', 'song-b', 'song-c']);
    await flushQueue();

    // song-b는 가사가 없어 정렬 자체가 호출되지 않아야 함
    expect(log.filter((l) => l.includes('song-b'))).toHaveLength(0);
    expect(state.alignmentQueue.find((i) => i.path === 'song-b').status).toBe('no-lyrics');

    // 엄격한 순차: a의 정렬+저장이 모두 끝난 뒤에야 c의 정렬이 시작
    expect(log).toEqual([
      'align-start:song-a',
      'align-end:song-a',
      'save:song-a',
      'align-start:song-c',
      'align-end:song-c',
      'save:song-c',
    ]);

    expect(state.alignmentQueue.find((i) => i.path === 'song-a').status).toBe('done');
    expect(state.alignmentQueue.find((i) => i.path === 'song-c').status).toBe('done');
  });

  it('marks an item error when no alignment model is installed and continues the batch', async () => {
    invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'load_lrc_file':
          return '[00:00.00]가사';
        case 'get_model_list':
          return ['설치 안 된 모델|none']; // 사용 가능 모델 없음
        default:
          return null;
      }
    });

    enqueueAlignment(['song-x']);
    await flushQueue();

    const item = state.alignmentQueue.find((i) => i.path === 'song-x');
    expect(item.status).toBe('error');
    expect(item.error).toContain('모델');
  });

  it('saves timing onto the original English LRC without persisting temporary phonetics', async () => {
    lsStore.alignmentLanguage = 'en-ko';
    let saved = '';
    invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'load_lrc_file':
          return '[00:00.00]Oh drowning';
        case 'get_model_list':
          return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
        case 'run_forced_alignment':
          return { lines: [{ text: '오 드라우닝', start_ms: 1000, end_ms: 2000 }] };
        case 'save_lrc_file':
          saved = args.content;
          return 'ok';
        default:
          return null;
      }
    });

    enqueueAlignment(['english-original']);
    await flushQueue();
    expect(saved).toContain('Oh drowning');
    expect(saved).not.toContain('[pron]');
    expect(saved).not.toContain('오 드라우닝');
  });

  it('sends original English text to the English-only model', async () => {
    lsStore.alignmentLanguage = 'en';
    let saved = '';
    const alignmentCalls = [];
    invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'load_lrc_file':
          return '[00:00.00]Oh drowning';
        case 'get_model_list':
          return ['English model|/models/wav2vec2-english-lyrics'];
        case 'run_forced_alignment':
          alignmentCalls.push(args);
          return {
            lines: [{
              segment_id: 'segment:0',
              text: 'Oh drowning',
              start_ms: 1000,
              end_ms: 2000,
              confidence: 0.8,
              token_coverage: 1,
            }],
          };
        case 'save_lrc_file':
          saved = args.content;
          return 'ok';
        default:
          return null;
      }
    });

    enqueueAlignment(['english-only']);
    await flushQueue();

    expect(alignmentCalls).toHaveLength(1);
    expect(alignmentCalls[0]).toMatchObject({ language: 'en', lyrics: 'Oh drowning' });
    expect(saved).toContain('[00:01.00]Oh drowning');
  });

  it('continues through the English fallback diagnostic stage without changing source text', async () => {
    lsStore.alignmentLanguage = 'en-ko';
    let saved = '';
    const alignmentCalls = [];
    invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'load_lrc_file':
          return '[00:00.00]Oh drowning';
        case 'get_model_list':
          return [
            '한국어 모델|/models/wav2vec2-korean-lyrics',
            'English model|/models/wav2vec2-english-lyrics',
          ];
        case 'run_forced_alignment':
          alignmentCalls.push({ language: args.language, lyrics: args.lyrics });
          return args.language === 'ko'
            ? { lines: [{ text: '오 드라우닝', start_ms: 1000, end_ms: 2000, confidence: 0, token_coverage: 0 }] }
            : { lines: [{ text: 'Oh drowning', start_ms: 2000, end_ms: 2800, confidence: 0.8, token_coverage: 1 }] };
        case 'save_lrc_file':
          saved = args.content;
          return 'ok';
        default:
          return null;
      }
    });

    enqueueAlignment(['english-fallback']);
    await flushQueue();
    expect(state.alignmentQueue.find((i) => i.path === 'english-fallback').status).toBe('done');
    expect(alignmentCalls.map((call) => call.language)).toEqual(['ko', 'ko', 'en']);
    expect(alignmentCalls[0].lyrics).toBe('');
    expect(alignmentCalls[1].lyrics).toContain('오 드라우닝');
    expect(saved).toContain('Oh drowning');
    expect(saved).not.toContain('[pron]');
  });

  it('rescues only the remaining unsynced lines in a second local pass', async () => {
    lsStore.alignmentLanguage = 'ko';
    let saved = '';
    const alignmentCalls = [];
    invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'load_lrc_file':
          return '[00:00.00]첫 번째 줄\n[00:00.00]두 번째 줄';
        case 'get_model_list':
          return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
        case 'run_forced_alignment':
          alignmentCalls.push(args);
          if (alignmentCalls.length === 1) {
            return {
              lines: [
                { segment_id: 'segment:0', text: '첫 번째 줄', start_ms: 1000, end_ms: 2000, confidence: 0.9 },
                { segment_id: 'segment:1', text: '두 번째 줄', start_ms: 2000, end_ms: 3000, confidence: 0 },
              ],
            };
          }
          return {
            lines: [{ segment_id: 'segment:1', text: '두 번째 줄', start_ms: 2400, end_ms: 3400, confidence: 0.9 }],
          };
        case 'save_lrc_file':
          saved = args.content;
          return 'ok';
        default:
          return null;
      }
    });

    enqueueAlignment(['second-pass-ko']);
    await flushQueue();

    expect(state.alignmentQueue.find((item) => item.path === 'second-pass-ko').status).toBe('done');
    expect(alignmentCalls).toHaveLength(2);
    expect(alignmentCalls[1].language).toBe('ko');
    expect(alignmentCalls[1].lyrics).toBe('두 번째 줄');
    expect(alignmentCalls[1].windowStartMs).toBe(0);
    expect(alignmentCalls[1].windowEndMs).toBe(10000);
    expect(saved).toContain('[00:01.00]첫 번째 줄');
    expect(saved).toContain('[00:02.40]두 번째 줄');
  });

  it('dedupes paths already queued', () => {
    invoke.mockImplementation(async () => '');
    const first = enqueueAlignment(['dup-song']);
    const second = enqueueAlignment(['dup-song']);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('queues a second song requested while the first is still processing', async () => {
    const doneOrder = [];
    let releaseFirst;
    const firstGate = new Promise((res) => { releaseFirst = res; });

    invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'load_lrc_file':
          return '[00:00.00]가사 한 줄';
        case 'get_model_list':
          return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
        case 'run_forced_alignment':
          // 첫 곡의 정렬을 게이트로 붙잡아 "진행 중" 상태를 유지
          if (args.audioPath === 'first') await firstGate;
          return { lines: [{ text: '가사 한 줄', start_ms: 1000, end_ms: 2000 }] };
        case 'save_lrc_file':
          doneOrder.push(args.audioPath);
          return 'ok';
        default:
          return null;
      }
    });

    // 첫 곡 등록 → 처리 시작될 때까지 대기
    enqueueAlignment(['first']);
    for (let i = 0; i < 100; i++) {
      if (state.alignmentQueue.find((x) => x.path === 'first')?.status === 'processing') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(isAlignmentBusy()).toBe(true);

    // 진행 중에 둘째 곡 등록 → 대기열에 'queued'로 들어가야 함(드롭 아님)
    const added = enqueueAlignment(['second']);
    expect(added).toBe(1);
    expect(state.alignmentQueue.find((x) => x.path === 'second').status).toBe('queued');

    // 첫 곡 정렬 완료시키면 둘째가 이어서 처리됨
    releaseFirst();
    await flushQueue();
    expect(doneOrder).toEqual(['first', 'second']);
  });

  it('notifies completion listeners with the alignment lines', async () => {
    const seen = [];
    onAlignmentItemComplete((path, lines) => seen.push({ path, count: lines.length }));

    invoke.mockImplementation(async (cmd) => {
      switch (cmd) {
        case 'load_lrc_file':
          return '[00:00.00]가사';
        case 'get_model_list':
          return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
        case 'run_forced_alignment':
          return { lines: [{ text: '가사', start_ms: 500, end_ms: 1500 }] };
        case 'save_lrc_file':
          return 'ok';
        default:
          return null;
      }
    });

    enqueueAlignment(['notify-song']);
    await flushQueue();
    expect(seen).toContainEqual({ path: 'notify-song', count: 1 });
  });
});
