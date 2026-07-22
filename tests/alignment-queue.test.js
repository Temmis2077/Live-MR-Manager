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
import { enqueueAlignment, isAlignmentBusy, onAlignmentItemComplete, collectAlignmentAnchors } from '../src/js/alignment-queue.js';

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

  it('uses vocalStart as the first-line anchor only when line 0 is unsynced', () => {
    const segments = [
      { text: '첫 줄', start: 0, end: 0 },
      { text: '둘째 줄', start: 0, end: 0 },
    ];
    const { anchors } = collectAlignmentAnchors(segments, { vocalStartSec: 12.34 });
    expect(anchors).toEqual([[0, 12340]]);
  });

  it('prefers a real synced line 0 over the vocalStart marker', () => {
    const segments = [{ text: '첫 줄', start: 2, end: 4 }];
    const { anchors } = collectAlignmentAnchors(segments, { vocalStartSec: 12.34 });
    // 첫 줄이 이미 싱크됐으므로 보컬시작 마커 앵커는 추가되지 않는다.
    expect(anchors).toEqual([[0, 2000]]);
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
