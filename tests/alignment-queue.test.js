import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mergeAlignmentResult, resolveQueueCompletionSegments } from '../src/js/lrc-parser.js';
import { applyAlignmentMetadata, buildAlignmentMetadata } from '../src/js/alignment-metadata.js';

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
  buildFinalEstimateGroups,
  estimateUnsyncedTimings,
  applyEstimatedTimings,
  markRejectedEstimateGroups,
  enforceAiTimelineOrder,
  assessLyricsSourceMismatch,
  resetAutomaticTimingsForRealignment,
  collectGateLexicalEvidence,
  optimizeVocalBoundaryAssignments,
} from '../src/js/alignment-queue.js';

function withLexicalEvidence(entries, diagnostics = {}, similarity = 0.8) {
  return {
    ...diagnostics,
    lexical_evidence_by_id: Object.fromEntries((entries || []).map((entry) => [entry.id, {
      similarity,
      lineKind: entry.lineKind || 'lyric',
    }])),
  };
}

describe('lyrics source mismatch warning', () => {
  const healthyAudit = {
    sourceTextOrderPreserved: true,
    monotonicOrderPreserved: true,
    durationSanityPreserved: true,
  };
  const entries = Array.from({ length: 10 }, (_, segmentIndex) => ({
    id: `segment:${segmentIndex}`,
    segmentIndex,
  }));

  it('does not mistake confidence-only singing failures for bad source lyrics', () => {
    const rejected = [2, 3, 4, 5].map((index) => ({
      line: {
        segment_id: `segment:${index}`,
        confidence: 0.001,
        token_coverage: 1,
        vocal_activity: 0.9,
      },
      reasons: ['confidence'],
    }));
    const result = assessLyricsSourceMismatch({
      entries,
      primaryGate: { accepted: [], rejected, confidenceFloor: 0.02 },
      timingAudit: healthyAudit,
    });
    expect(result.suspected).toBe(false);
    expect(result.metrics.evidenceCount).toBe(0);
  });

  it('warns when broad consecutive lexical mismatches remain despite a healthy timeline', () => {
    const rejected = [2, 3, 4, 5].map((index) => ({
      line: {
        segment_id: `segment:${index}`,
        confidence: 0.001,
        token_coverage: 1,
        vocal_activity: 0.9,
      },
      reasons: ['confidence', 'lexical_mismatch'],
    }));
    const result = assessLyricsSourceMismatch({
      entries,
      primaryGate: { accepted: [], rejected, confidenceFloor: 0.02 },
      timingAudit: healthyAudit,
    });
    expect(result.suspected).toBe(true);
    expect(result.metrics).toMatchObject({ evidenceCount: 4, longestConsecutiveRun: 4 });
  });

  it('does not warn for a couple of isolated weak lines', () => {
    const rejected = [1, 7].map((index) => ({
      line: {
        segment_id: `segment:${index}`,
        confidence: 0.001,
        token_coverage: 1,
        vocal_activity: 0.9,
      },
      reasons: ['confidence'],
    }));
    expect(assessLyricsSourceMismatch({
      entries,
      primaryGate: { accepted: [], rejected, confidenceFloor: 0.02 },
      timingAudit: healthyAudit,
    }).suspected).toBe(false);
  });

  it('leaves structural timing failures to the timeline warning instead', () => {
    const accepted = [2, 3, 4, 5].map((index) => ({
      segment_id: `segment:${index}`,
      alignment_trust: 'acoustic_soft',
      quality_flags: ['low_confidence_corroborated'],
    }));
    expect(assessLyricsSourceMismatch({
      entries,
      primaryGate: { accepted, rejected: [], confidenceFloor: 0.02 },
      timingAudit: { ...healthyAudit, monotonicOrderPreserved: false },
    }).suspected).toBe(false);
  });

  it('does not make source claims from very short songs', () => {
    const shortEntries = entries.slice(0, 6);
    const accepted = shortEntries.slice(0, 4).map((entry) => ({
      segment_id: entry.id,
      alignment_trust: 'acoustic_soft',
      quality_flags: ['doubling_ambiguity'],
    }));
    expect(assessLyricsSourceMismatch({
      entries: shortEntries,
      primaryGate: { accepted, rejected: [], confidenceFloor: 0.02 },
      timingAudit: healthyAudit,
    }).suspected).toBe(false);
  });
});

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

  it('marks normalized duplicate lyrics without merging their segment IDs', () => {
    const segments = [
      { text: 'Same Hook!', start: 0, end: 0 },
      { text: '다른 줄', start: 0, end: 0 },
      { text: 'same   hook', start: 0, end: 0 },
    ];
    const { entries } = collectAlignmentAnchors(segments, {});
    expect(entries.map((entry) => entry.id)).toEqual(['segment:0', 'segment:1', 'segment:2']);
    expect(entries.map((entry) => entry.repeatedLyric)).toEqual([true, false, true]);
    expect(segments.map((segment) => segment.repeatedLyric)).toEqual([true, false, true]);
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

  it('drops the weaker automatic line when starts increase but time ranges overlap', () => {
    const segments = [
      { text: '앞 자동 가사', start: 10, end: 15, approx: true, confidence: 0.8, alignmentTrust: 'acoustic_strong' },
      { text: '뒤 자동 가사', start: 13, end: 16, approx: true, confidence: 0.2, alignmentTrust: 'acoustic_soft' },
    ];
    const dropped = enforceAiTimelineOrder(segments);
    expect(dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'segment:1', reason: 'overlap_weaker_auto' }),
    ]));
    expect(segments[0].start).toBe(10);
    expect(segments[1]).toMatchObject({ start: 0, end: 0 });
  });

  it('detects duplicate time ranges even when unsynced source lines sit between them', () => {
    const segments = [
      { text: '모든 건 다 영원할 수가 없다는 걸', start: 209.64, end: 217.16, approx: true, confidence: 0.8, alignmentTrust: 'acoustic_soft' },
      { text: '이미 미싱크', start: 0, end: 0, approx: true },
      { text: '모든 건 다 영원할 수가 없다는 걸', start: 209.64, end: 217.16, approx: true, confidence: 0.2, alignmentTrust: 'acoustic_soft' },
    ];
    const dropped = enforceAiTimelineOrder(segments);
    expect(dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'segment:2', reason: 'overlap_weaker_auto' }),
    ]));
    expect(segments[0].start).toBe(209.64);
    expect(segments[2]).toMatchObject({ start: 0, end: 0 });
  });

  it('rejects automatic timings that are extreme for the singable lyric length', () => {
    const segments = [
      { text: '열여섯글자에가까운아주긴문장', start: 1, end: 1.4, approx: true, confidence: 0.9 },
      { text: '짧은말', start: 3, end: 12, approx: true, confidence: 0.9 },
      { text: '정상적인 가사', start: 13, end: 15, approx: true, confidence: 0.9 },
    ];
    const dropped = enforceAiTimelineOrder(segments);
    expect(dropped.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'duration_too_short_for_lyrics',
      'duration_too_long_for_lyrics',
    ]));
    expect(segments[0]).toMatchObject({ start: 0, end: 0 });
    expect(segments[1]).toMatchObject({ start: 0, end: 0 });
    expect(segments[2].start).toBe(13);
  });

  it('never rewrites conflicting manual timings', () => {
    const segments = [
      { text: '수동 앞줄', start: 10, end: 15 },
      { text: '수동 뒷줄', start: 13, end: 16 },
    ];
    expect(enforceAiTimelineOrder(segments)).toEqual([]);
    expect(segments.map((segment) => segment.start)).toEqual([10, 13]);
  });

  it('keeps an explicitly matched sustained vocable within its separate duration cap', () => {
    const segments = [{
      text: '우우우', lineKind: 'vocable', start: 1, end: 7,
      approx: true, confidence: 0.1, alignmentTrust: 'acoustic_soft',
    }];
    expect(enforceAiTimelineOrder(segments)).toEqual([]);
    expect(segments[0].start).toBe(1);
  });
});

describe('second-pass rescue windows', () => {
  it('keeps unsynced lines between accepted anchors in one bounded window', () => {
    const entries = [0, 1, 2, 3].map((segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
    }));
    const segments = [
      { text: '앞 앵커', start: 10, end: 11, approx: true, alignmentTrust: 'acoustic_strong' },
      { text: '미싱크 하나', start: 0, end: 0 },
      { text: '미싱크 둘', start: 0, end: 0 },
      { text: '뒤 앵커', start: 20, end: 21, approx: true, alignmentTrust: 'acoustic_strong' },
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

  it('skips soft timings and uses the next strong anchors for the rescue window', () => {
    const entries = [0, 1, 2, 3, 4].map((segmentIndex) => ({ id: `segment:${segmentIndex}`, segmentIndex }));
    const segments = [
      { text: '강한 앞', start: 10, end: 11, approx: true, alignmentTrust: 'acoustic_strong' },
      { text: '약한 앞', start: 12, end: 13, approx: true, alignmentTrust: 'acoustic_soft' },
      { text: '미싱크', start: 0, end: 0 },
      { text: '약한 뒤', start: 14, end: 15, approx: true, alignmentTrust: 'estimated' },
      { text: '강한 뒤', start: 20, end: 21, approx: false },
    ];
    const [window] = buildSecondPassWindows({
      rescueEntries: [{ ...entries[2], language: 'ko' }],
      segments,
      entries,
      markers: {},
    });

    expect(window.windowContext.previousAnchor).toMatchObject({ segmentIndex: 0, trust: 'acoustic_strong' });
    expect(window.windowContext.nextAnchor).toMatchObject({ segmentIndex: 4, trust: 'manual' });
    expect(window.windowContext.softAnchorSkipped.map((anchor) => anchor.id)).toEqual(['segment:1', 'segment:3']);
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

describe('third-pass estimated sync', () => {
  it('keeps a 200-400ms breath inside one lyric assignment', () => {
    const result = optimizeVocalBoundaryAssignments([
      { startMs: 1_000, endMs: 2_000, activity: 0.8 },
      { startMs: 2_300, endMs: 3_300, activity: 0.8 },
    ], [{ text: '긴 한 줄' }], [4], [{}]);
    expect(result.assignments[0]).toMatchObject({ startMs: 1_000, endMs: 3_300 });
    expect(result.assignments[0].regions).toHaveLength(2);
  });

  it('prefers a 400-800ms VAD gap as a lyric boundary', () => {
    const result = optimizeVocalBoundaryAssignments([
      { startMs: 1_000, endMs: 2_000, activity: 0.8 },
      { startMs: 2_300, endMs: 3_300, activity: 0.8 },
      { startMs: 3_800, endMs: 4_800, activity: 0.8 },
    ], [{ text: '첫 줄' }, { text: '둘째 줄' }], [3, 3], [{}, {}]);
    expect(result.assignments.map((item) => [item.startMs, item.endMs])).toEqual([
      [1_000, 3_300],
      [3_800, 4_800],
    ]);
  });

  it('never lets one lyric cross a VAD gap over 800ms', () => {
    const result = optimizeVocalBoundaryAssignments([
      { startMs: 1_000, endMs: 2_000, activity: 0.8 },
      { startMs: 3_000, endMs: 4_000, activity: 0.8 },
    ], [{ text: '한 줄' }], [3], [{}]);
    expect(result.assignments[0].regions).toHaveLength(1);
  });

  it('drops standalone VAD clicks shorter than 160ms', () => {
    const result = optimizeVocalBoundaryAssignments([
      { startMs: 1_000, endMs: 1_120, activity: 1 },
      { startMs: 2_000, endMs: 3_000, activity: 0.7 },
    ], [{ text: '가사' }], [2], [{}]);
    expect(result.assignments[0].regions).toEqual([
      expect.objectContaining({ startMs: 2_000, endMs: 3_000 }),
    ]);
  });

  it('does not reuse lexical evidence from a different repeated-lyric time window', () => {
    const entries = [
      { id: 'segment:0', segmentIndex: 0, text: '앞 앵커' },
      { id: 'segment:1', segmentIndex: 1, text: '반복 후렴', repeatedLyric: true },
      { id: 'segment:2', segmentIndex: 2, text: '뒤 앵커' },
    ];
    const segments = [
      { text: '앞 앵커', start: 10, end: 11, approx: false },
      { text: '반복 후렴', start: 0, end: 0 },
      { text: '뒤 앵커', start: 20, end: 21, approx: false },
    ];
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), {
      audio_duration_ms: 60_000,
      vocal_regions: [{ start_ms: 11_000, end_ms: 20_000, activity: 0.8 }],
      lexical_evidence_by_id: {
        'segment:1': {
          similarity: 0.9,
          lineKind: 'lyric',
          startMs: 40_000,
          endMs: 41_000,
          candidates: [{ similarity: 0.9, lineKind: 'lyric', startMs: 40_000, endMs: 41_000 }],
        },
      },
    });

    expect(result.estimates).toHaveLength(0);
    expect(result.rejectedGroups[0]).toMatchObject({ rejectedReason: 'no_lexical_evidence' });
    expect(result.rejectedGroups[0].lexicalEligibility[0]).toMatchObject({
      similarity: null,
      evidenceWindowMatched: false,
      evidenceCandidateCount: 1,
    });
  });

  it('selects the best lexical candidate inside the current anchor window', () => {
    const entries = [
      { id: 'segment:0', segmentIndex: 0, text: '앞 앵커' },
      { id: 'segment:1', segmentIndex: 1, text: '반복 후렴' },
      { id: 'segment:2', segmentIndex: 2, text: '뒤 앵커' },
    ];
    const segments = [
      { text: '앞 앵커', start: 10, end: 11, approx: false },
      { text: '반복 후렴', start: 0, end: 0 },
      { text: '뒤 앵커', start: 20, end: 21, approx: false },
    ];
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), {
      audio_duration_ms: 60_000,
      vocal_regions: [{ start_ms: 11_000, end_ms: 20_000, activity: 0.8 }],
      lexical_evidence_by_id: {
        'segment:1': {
          similarity: 0.9,
          lineKind: 'lyric',
          candidates: [
            { similarity: 0.9, lineKind: 'lyric', startMs: 40_000, endMs: 41_000 },
            { similarity: 0.3, lineKind: 'lyric', startMs: 12_000, endMs: 13_000 },
          ],
        },
      },
    });

    expect(result.rejectedGroups).toHaveLength(0);
    expect(result.estimates).toHaveLength(1);
    expect(result.estimates[0].lexicalEligibility).toMatchObject({
      similarity: 0.3,
      evidenceWindowMatched: true,
      evidenceCandidateCount: 2,
      selectedEvidenceStartMs: 12_000,
    });
  });

  it('never treats a trailing manual LRC timestamp with an open end as unsynced', () => {
    const entries = [{ id: 'segment:0', segmentIndex: 0, text: '마지막 수동 줄' }];
    const segments = [{ text: '마지막 수동 줄', start: 42.5, end: 0, approx: false }];

    const groups = buildFinalEstimateGroups(segments, entries, {});
    const applied = applyEstimatedTimings(segments, [{
      segment_id: 'segment:0',
      segmentIndex: 0,
      start_ms: 1_000,
      end_ms: 2_000,
    }]);

    expect(groups).toHaveLength(0);
    expect(applied).toBe(0);
    expect(segments[0]).toMatchObject({ start: 42.5, end: 0, approx: false });
  });

  it('recovers an ordinary lyric in a closed VAD window without lexical evidence', () => {
    const entries = [{ id: 'segment:0', segmentIndex: 0, text: '다음 본문 가사', lineKind: 'lyric' }];
    const segments = [{ text: entries[0].text, start: 0, end: 0 }];
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), {
      audio_duration_ms: 8_000,
      vocal_regions: [{ start_ms: 1_000, end_ms: 7_000, activity: 0.9 }],
    });
    expect(result.rejectedGroups).toHaveLength(0);
    expect(result.estimates[0]).toMatchObject({
      segment_id: 'segment:0',
      method: 'vad_boundary_review',
      quality_flags: ['lexical_uncertain', 'vad_boundary_review', 'review_required'],
    });
  });

  it('does not reuse an implausible-duration rejection as third-pass lexical evidence', () => {
    const entries = [{ id: 'segment:0', segmentIndex: 0, text: '본문 가사', lineKind: 'lyric' }];
    const segments = [{ text: '본문 가사', start: 0, end: 0 }];
    const evidence = new Map();
    const regions = [];
    collectGateLexicalEvidence({
      accepted: [],
      rejected: [{
        line: {
          segment_id: 'segment:0', greedy_text_similarity: 0.8,
          start_ms: 1_000, end_ms: 12_000, line_kind: 'lyric',
        },
        reasons: ['duration_sanity'],
      }],
    }, evidence, regions);

    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), {
      audio_duration_ms: 15_000,
      vocal_regions: [{ start_ms: 1_000, end_ms: 14_000, activity: 0.9 }],
      lexical_evidence_by_id: evidence,
    });
    expect(evidence.get('segment:0').candidates[0].thirdPassEligible).toBe(false);
    expect(result.estimates).toHaveLength(0);
    expect(result.rejectedGroups[0]).toMatchObject({ rejectedReason: 'no_lexical_evidence' });
  });

  it('keeps a text-matching confidence-only rejection eligible for third-pass timing', () => {
    const entries = [{ id: 'segment:0', segmentIndex: 0, text: '본문 가사', lineKind: 'lyric' }];
    const segments = [{ text: '본문 가사', start: 0, end: 0 }];
    const evidence = new Map();
    collectGateLexicalEvidence({
      accepted: [],
      rejected: [{
        line: {
          segment_id: 'segment:0', greedy_text_similarity: 0.4,
          start_ms: 2_000, end_ms: 4_000, line_kind: 'lyric',
        },
        reasons: ['confidence'],
      }],
    }, evidence, []);

    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), {
      audio_duration_ms: 8_000,
      vocal_regions: [{ start_ms: 1_000, end_ms: 7_000, activity: 0.8 }],
      lexical_evidence_by_id: evidence,
    });
    expect(evidence.get('segment:0').candidates[0].thirdPassEligible).toBe(true);
    expect(result.estimates.map((estimate) => estimate.segment_id)).toEqual(['segment:0']);
  });

  it('constrains a plausible weak lexical candidate to the available VAD boundary', () => {
    const entries = [{ id: 'segment:0', segmentIndex: 0, text: '노래를 해주렴', lineKind: 'lyric' }];
    const segments = [{ text: entries[0].text, start: 0, end: 0 }];
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), {
      audio_duration_ms: 80_000,
      vocal_regions: [{ start_ms: 74_460, end_ms: 77_560, activity: 0.8 }],
      lexical_evidence_by_id: {
        'segment:0': {
          similarity: 0.285,
          lineKind: 'lyric',
          startMs: 66_200,
          endMs: 68_320,
          thirdPassEligible: true,
        },
      },
    });

    expect(result.estimates).toHaveLength(1);
    expect(result.estimates[0]).toMatchObject({
      segment_id: 'segment:0',
      start_ms: 74_460,
      end_ms: 77_560,
      method: 'lexical_candidate',
    });
  });

  it('keeps a lexical candidate and VAD-recovers its unevidenced neighbor in source order', () => {
    const entries = [0, 1].map((segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
      text: `가사 ${segmentIndex}`,
      lineKind: 'lyric',
    }));
    const segments = entries.map((entry) => ({ text: entry.text, start: 0, end: 0 }));
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), {
      audio_duration_ms: 8_000,
      vocal_regions: [{ start_ms: 1_000, end_ms: 7_000, activity: 0.8 }],
      lexical_evidence_by_id: {
        'segment:0': { similarity: 0.4, lineKind: 'lyric', startMs: 1_000, endMs: 3_000 },
      },
    });

    expect(result.estimates.map((estimate) => estimate.segment_id)).toEqual(['segment:0', 'segment:1']);
    expect(result.rejectedGroups).toHaveLength(0);
    expect(result.estimates[1]).toMatchObject({ method: 'vad_ordered_review' });
    expect(result.estimates[1].quality_flags).toContain('review_required');
    expect(result.estimates[0].end_ms).toBeLessThanOrEqual(4_000);
  });

  it('excludes a high-VAD non-lexical region before allocating an evidenced lyric', () => {
    const entries = [{ id: 'segment:0', segmentIndex: 0, text: '다음 본문 가사', lineKind: 'lyric' }];
    const segments = [{ text: entries[0].text, start: 0, end: 0 }];
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), withLexicalEvidence(entries, {
      audio_duration_ms: 10_000,
      vocal_regions: [
        { start_ms: 1_000, end_ms: 3_000, activity: 0.95 },
        { start_ms: 6_000, end_ms: 9_000, activity: 0.7 },
      ],
      non_lexical_vocal_regions: [{ startMs: 1_000, endMs: 3_000 }],
    }, 0.3));
    expect(result.estimates).toHaveLength(1);
    expect(result.estimates[0].start_ms).toBeGreaterThanOrEqual(6_000);
  });

  it('never restores a window completely removed as non-lexical vocal', () => {
    const entries = [{ id: 'segment:0', segmentIndex: 0, text: '다음 본문 가사', lineKind: 'lyric' }];
    const segments = [{ text: entries[0].text, start: 0, end: 0 }];
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), withLexicalEvidence(entries, {
      audio_duration_ms: 5_000,
      vocal_regions: [{ start_ms: 0, end_ms: 5_000, activity: 0.9 }],
      non_lexical_vocal_regions: [{ startMs: 0, endMs: 5_000 }],
    }, 0.3));
    expect(result.estimates).toHaveLength(0);
    expect(result.rejectedGroups[0]).toMatchObject({ rejectedReason: 'insufficient_window_density' });
  });

  it('fills consecutive missing lyrics between anchors using vocal regions', () => {
    const entries = [0, 1, 2, 3].map((segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
      text: ['앞 앵커', '짧은 줄', '조금 더 긴 가사 줄', '뒤 앵커'][segmentIndex],
    }));
    const segments = [
      { text: '앞 앵커', start: 10, end: 11, approx: false },
      { text: '짧은 줄', start: 0, end: 0 },
      { text: '조금 더 긴 가사 줄', start: 0, end: 0 },
      { text: '뒤 앵커', start: 20, end: 21, approx: true, alignmentTrust: 'acoustic_strong' },
    ];
    const groups = buildFinalEstimateGroups(segments, entries, {});
    const { estimates, rejectedGroups } = estimateUnsyncedTimings(groups, withLexicalEvidence(entries, {
      audio_duration_ms: 30_000,
      vocal_regions: [
        { start_ms: 12_000, end_ms: 15_000, activity: 0.8 },
        { start_ms: 16_000, end_ms: 19_000, activity: 0.7 },
      ],
    }));

    expect(groups).toHaveLength(1);
    expect(rejectedGroups).toHaveLength(0);
    expect(estimates.map((line) => line.segment_id)).toEqual(['segment:1', 'segment:2']);
    expect(estimates[0].start_ms).toBeGreaterThan(11_000);
    expect(estimates[1].start_ms).toBeGreaterThan(estimates[0].start_ms);
    expect(estimates[1].end_ms).toBeLessThanOrEqual(20_000);
    expect(estimates.every((line) => line.method === 'vad_boundary_review')).toBe(true);

    expect(applyEstimatedTimings(segments, estimates)).toBe(2);
    expect(segments[0]).toMatchObject({ start: 10, end: 11, approx: false });
    expect(segments[3]).toMatchObject({ start: 20, end: 21, approx: true });
    expect(segments[1]).toMatchObject({ approx: true, confidence: 0, alignmentSource: 'vad_boundary_review' });
  });

  it('replays the supplied log regression groups without treating ordinary lyrics as vocables', () => {
    const groups = [
      { from: 30_680, to: 44_720, base: 3 },
      { from: 158_320, to: 180_660, base: 18 },
    ];
    const entries = groups.flatMap(({ base }) => [0, 1, 2].map((offset) => ({
      id: `segment:${base + offset}`,
      segmentIndex: base + offset,
      text: `일반 가사 ${base + offset}`,
      lineKind: 'lyric',
    })));
    const estimateGroups = groups.map(({ from, to, base }) => ({
      lowerBoundMs: from,
      upperBoundMs: to,
      entries: entries.filter((entry) => entry.segmentIndex >= base && entry.segmentIndex < base + 3),
      interludes: [],
      previousAnchor: null,
      nextAnchor: null,
    }));
    const result = estimateUnsyncedTimings(estimateGroups, {
      audio_duration_ms: 181_000,
      vocal_regions: groups.map(({ from, to }) => ({ start_ms: from, end_ms: to, activity: 0.65 })),
      non_lexical_vocal_regions: [],
    });

    expect(result.rejectedGroups).toHaveLength(0);
    expect(result.estimates).toHaveLength(6);
    expect(result.estimates.every((line) => line.method === 'vad_ordered_review')).toBe(true);
    expect(result.estimates.every((line) => line.quality_flags.includes('review_required'))).toBe(true);
  });

  it('uses time weighting with no anchors or VAD and leaves no zero-start lyric', () => {
    const entries = [0, 1, 2].map((segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
      text: `가사 ${segmentIndex}`,
    }));
    const segments = entries.map((entry) => ({ text: entry.text, start: 0, end: 0 }));
    const { estimates } = estimateUnsyncedTimings(
      buildFinalEstimateGroups(segments, entries, {}),
      withLexicalEvidence(entries, { audio_duration_ms: 9_000, vocal_regions: [] }),
    );

    expect(estimates).toHaveLength(3);
    expect(estimates.every((line) => line.method === 'time_weighted')).toBe(true);
    expect(estimates[0].start_ms).toBeGreaterThan(0);
    expect(estimates[1].start_ms).toBeGreaterThan(estimates[0].start_ms);
    expect(estimates[2].start_ms).toBeGreaterThan(estimates[1].start_ms);
    expect(estimates[2].end_ms).toBeLessThanOrEqual(9_000);
  });

  it('never places an estimated start inside an instrumental interval', () => {
    const entries = [0, 1].map((segmentIndex) => ({ id: `segment:${segmentIndex}`, segmentIndex, text: '가나다라' }));
    const segments = entries.map(() => ({ text: '가나다라', start: 0, end: 0 }));
    const groups = buildFinalEstimateGroups(segments, entries, {
      vocalStartSec: 1,
      interludes: [{ start: 3, end: 7 }],
    });
    const { estimates } = estimateUnsyncedTimings(groups, withLexicalEvidence(entries, { audio_duration_ms: 10_000 }));

    expect(estimates).toHaveLength(2);
    expect(estimates.every((line) => line.start_ms < 3_000 || line.start_ms >= 7_000)).toBe(true);
  });

  it('rejects a narrow anchor window instead of compressing several lyrics into it', () => {
    const entries = [0, 1, 2, 3, 4].map((segmentIndex) => ({ id: `segment:${segmentIndex}`, segmentIndex, text: '가' }));
    const segments = [
      { text: '앞', start: 1, end: 1.01 },
      { text: '가', start: 0, end: 0 },
      { text: '나', start: 0, end: 0 },
      { text: '다', start: 0, end: 0 },
      { text: '뒤', start: 1.10, end: 1.2 },
    ];
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), withLexicalEvidence(entries));
    expect(result.estimates).toHaveLength(0);
    expect(result.rejectedGroups[0]).toMatchObject({
      rejectedReason: 'insufficient_window_density',
      segmentIds: ['segment:1', 'segment:2', 'segment:3'],
    });
    expect(result.rejectedGroups[0].availableDurationMs).toBeLessThan(result.rejectedGroups[0].requiredDurationMs);
    expect(markRejectedEstimateGroups(segments, result.rejectedGroups)).toEqual(['segment:1', 'segment:2', 'segment:3']);
    expect(segments[1]).toMatchObject({ start: 0, end: 0, approx: true, alignmentSource: 'unsynced_review' });
  });

  it('rejects a VAD allocation when one lyric would collapse below its own duration floor', () => {
    const entries = [0, 1].map((segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
      text: '가나다라',
      lineKind: 'lyric',
    }));
    const segments = entries.map((entry) => ({ text: entry.text, start: 0, end: 0 }));
    const result = estimateUnsyncedTimings(
      buildFinalEstimateGroups(segments, entries, {}),
      withLexicalEvidence(entries, {
        audio_duration_ms: 5_000,
        vocal_regions: [
          { start_ms: 1_000, end_ms: 1_080, activity: 1 },
          { start_ms: 2_000, end_ms: 5_000, activity: 1 },
        ],
      }),
    );

    expect(result.estimates).toHaveLength(1);
    expect(result.estimates[0].segment_id).toBe('segment:1');
    expect(result.rejectedGroups[0]).toMatchObject({
      rejectedReason: 'insufficient_per_line_duration',
      segmentIds: ['segment:0'],
    });
    expect(result.rejectedGroups[0].perLineDurationChecks[0]).toMatchObject({
      durationMs: 80,
      minimumDurationMs: 200,
      plausible: false,
    });
  });

  it('rejects six doubled-hook lines when only 4.58 seconds of vocal activity are available', () => {
    const entries = Array.from({ length: 8 }, (_, segmentIndex) => ({
      id: `segment:${segmentIndex}`,
      segmentIndex,
      text: segmentIndex === 0 || segmentIndex === 7 ? '강한 앵커' : `반복 후렴 ${segmentIndex}`,
    }));
    const segments = entries.map((entry, index) => ({
      text: entry.text,
      start: index === 0 ? 230 : (index === 7 ? 241 : 0),
      end: index === 0 ? 231 : (index === 7 ? 242 : 0),
      approx: index === 0 || index === 7 ? false : undefined,
    }));
    const result = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), withLexicalEvidence(entries, {
      audio_duration_ms: 260_000,
      vocal_regions: [{ start_ms: 235_900, end_ms: 240_480, activity: 0.9 }],
    }));

    expect(result.estimates).toHaveLength(0);
    expect(result.rejectedGroups[0]).toMatchObject({
      segmentIds: ['segment:1', 'segment:2', 'segment:3', 'segment:4', 'segment:5', 'segment:6'],
      availableDurationMs: 4_580,
      rejectedReason: 'insufficient_window_density',
    });
    expect(result.rejectedGroups[0].requiredDurationMs).toBeGreaterThanOrEqual(4_800);
  });

  it('uses start-order space when neighboring accepted lyrics overlap', () => {
    const entries = [0, 1, 2].map((segmentIndex) => ({ id: `segment:${segmentIndex}`, segmentIndex, text: '가사' }));
    const segments = [
      { text: '긴 앞줄', start: 10, end: 15, approx: true, alignmentTrust: 'acoustic_strong' },
      { text: '미싱크', start: 0, end: 0 },
      { text: '겹친 다음줄', start: 13, end: 16, approx: true, alignmentTrust: 'acoustic_strong' },
    ];
    const { estimates } = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), withLexicalEvidence(entries));
    expect(estimates).toHaveLength(1);
    expect(estimates[0].start_ms).toBeGreaterThan(10_000);
    expect(estimates[0].start_ms).toBeLessThan(13_000);
  });

  it('chooses the vocal cluster matching the missing line count across a long instrumental gap', () => {
    const entries = [0, 1, 2].map((segmentIndex) => ({ id: `segment:${segmentIndex}`, segmentIndex, text: '잊었니 날 잊어버렸니' }));
    const segments = [
      { text: '앞줄', start: 71.52, end: 74.94, approx: true, alignmentTrust: 'acoustic_strong' },
      { text: '잊었니 날 잊어버렸니', start: 0, end: 0 },
      { text: '뒷줄', start: 103.08, end: 107.22, approx: true, alignmentTrust: 'acoustic_strong' },
    ];
    const { estimates } = estimateUnsyncedTimings(buildFinalEstimateGroups(segments, entries, {}), withLexicalEvidence(entries, {
      audio_duration_ms: 193_660,
      vocal_regions: [
        { start_ms: 75_140, end_ms: 76_880, activity: 0.59 },
        { start_ms: 98_260, end_ms: 99_420, activity: 0.56 },
        { start_ms: 100_000, end_ms: 102_600, activity: 0.57 },
      ],
    }));

    expect(estimates).toHaveLength(1);
    expect(estimates[0].start_ms).toBeGreaterThanOrEqual(98_260);
    expect(estimates[0].end_ms).toBeLessThanOrEqual(103_080);
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

describe('queue completion adoption', () => {
  it('does not resurrect a raw timing cleared by the final timeline audit', () => {
    const current = [{ text: '첫 줄', start: 0, end: 0 }];
    const rawAccepted = [{ text: '첫 줄', start_ms: 5000, end_ms: 6000 }];
    const audited = [{
      text: '첫 줄',
      start: 0,
      end: 0,
      approx: true,
      alignmentSource: 'unsynced_review',
      qualityFlags: ['out_of_order_weaker_auto'],
    }];

    const result = resolveQueueCompletionSegments(current, rawAccepted, audited);

    expect(result.adoptedAudited).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.segments[0]).toMatchObject({
      start: 0,
      end: 0,
      alignmentSource: 'unsynced_review',
    });
    expect(current[0]).toMatchObject({ start: 0, end: 0 });
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

  it('does not promote a restored soft AI timing to a manual anchor', () => {
    const stored = buildAlignmentMetadata([{
      text: '약한 AI 결과', start: 12, end: 14, approx: true,
      alignmentTrust: 'acoustic_soft', alignmentSource: 'ctc',
    }]);
    const reloaded = applyAlignmentMetadata([
      { text: '약한 AI 결과', start: 12, end: 0 },
    ], stored).segments;

    const prepared = collectAlignmentAnchors(reloaded, []);
    expect(reloaded[0]).toMatchObject({ approx: true, alignmentTrust: 'acoustic_soft' });
    expect(prepared.anchors).toEqual([]);
  });

  it('resets restored automatic timings for an explicit rerun but preserves manual anchors', () => {
    const segments = [
      { text: '자동', start: 12, end: 14, approx: true, alignmentTrust: 'acoustic_soft' },
      { text: '수동', start: 20, end: 22, approx: false, alignmentTrust: 'manual' },
    ];
    const reset = resetAutomaticTimingsForRealignment(segments);

    expect(reset.map((entry) => entry.id)).toEqual(['segment:0']);
    expect(segments[0]).toMatchObject({ start: 0, end: 0, approx: true });
    expect(segments[0].alignmentTrust).toBeUndefined();
    expect(segments[1]).toMatchObject({ start: 20, end: 22, approx: false, alignmentTrust: 'manual' });
    expect(collectAlignmentAnchors(segments, []).anchors).toEqual([[1, 20000]]);
  });

  it('does not save AI timestamps when provenance metadata persistence fails', async () => {
    let lrcSaved = false;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'load_lrc_file') return '[00:00.00]가사 한 줄';
      if (cmd === 'get_model_list') return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
      if (cmd === 'run_forced_alignment') {
        return { lines: [{
          segment_id: 'segment:0', text: '가사 한 줄', start_ms: 1000, end_ms: 2000,
          confidence: 0.9, token_coverage: 1, greedy_text_similarity: 0.9,
        }] };
      }
      if (cmd === 'save_alignment_metadata') throw new Error('disk full');
      if (cmd === 'save_lrc_file') lrcSaved = true;
      return null;
    });

    enqueueAlignment(['metadata-write-failure']);
    await flushQueue();

    const item = state.alignmentQueue.find((entry) => entry.path === 'metadata-write-failure');
    expect(item.status).toBe('error');
    expect(item.error).toContain('메타데이터');
    expect(lrcSaved).toBe(false);
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
    const item = state.alignmentQueue.find((entry) => entry.path === 'english-original');
    expect(item.status).toBe('done');
    expect(item.note).toContain('영어 모델 없음 1줄');
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
    const traces = [];
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
          if (!String(args.lyrics || '').trim()) throw new Error('유효한 가사 토큰이 없습니다.');
          alignmentCalls.push({ language: args.language, lyrics: args.lyrics });
          return args.language === 'ko'
            ? { lines: [{ text: '오 드라우닝', start_ms: 1000, end_ms: 2000, confidence: 0, token_coverage: 0 }] }
            : { lines: [{ text: 'Oh drowning', start_ms: 2000, end_ms: 2800, confidence: 0.8, token_coverage: 1 }] };
        case 'save_lrc_file':
          saved = args.content;
          return 'ok';
        case 'write_alignment_debug_trace':
          traces.push(args);
          return 'trace.jsonl';
        default:
          return null;
      }
    });

    enqueueAlignment(['english-fallback']);
    await flushQueue();
    expect(state.alignmentQueue.find((i) => i.path === 'english-fallback').status).toBe('done');
    expect(alignmentCalls.map((call) => call.language)).toEqual(['ko', 'en']);
    expect(alignmentCalls[0].lyrics).toContain('오 드라우닝');
    expect(saved).toContain('Oh drowning');
    expect(saved).not.toContain('[pron]');
    expect(traces.find((trace) => trace.stage === 'input_prepared')?.payload).toMatchObject({
      alignmentPipelineRevision: 'ordered-lexical-window-v3',
      policy: {
        sourceOrder: 'immutable_segment_id',
        thirdPassLexicalEvidence: 'same_anchor_window_per_line',
      },
    });
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
                { segment_id: 'segment:0', text: '첫 번째 줄', start_ms: 1000, end_ms: 2000, confidence: 0.9, greedy_text_similarity: 0.8 },
                { segment_id: 'segment:1', text: '두 번째 줄', start_ms: 2000, end_ms: 3000, confidence: 0, greedy_text_similarity: 0.3 },
              ],
            };
          }
          return {
            lines: [{ segment_id: 'segment:1', text: '두 번째 줄', start_ms: 2400, end_ms: 3400, confidence: 0.9, greedy_text_similarity: 0.8 }],
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

  it('leaves an acoustically unsupported line unsynced instead of forcing a VAD-only estimate', async () => {
    let saved = '';
    let alignmentCallCount = 0;
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'load_lrc_file') return '[00:00.00]첫 번째 약한 줄\n[00:00.00]두 번째 약한 줄';
      if (cmd === 'get_model_list') return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
      if (cmd === 'run_forced_alignment') {
        alignmentCallCount++;
        return {
          lines: [
            { segment_id: 'segment:0', text: '첫 번째 약한 줄', start_ms: 1000, end_ms: 2000, confidence: 0, token_coverage: 1, greedy_text_similarity: 0.3 },
            { segment_id: 'segment:1', text: '두 번째 약한 줄', start_ms: 2200, end_ms: 3200, confidence: 0, token_coverage: 1, greedy_text_similarity: 0.3 },
          ],
          diagnostics: {
            audio_duration_ms: 12_000,
            vocal_regions: [{ start_ms: 2_000, end_ms: 10_000, activity: 0.7 }],
          },
        };
      }
      if (cmd === 'save_lrc_file') { saved = args.content; return 'ok'; }
      return null;
    });

    enqueueAlignment(['third-pass-estimate']);
    await flushQueue();

    expect(state.alignmentQueue.find((item) => item.path === 'third-pass-estimate').status).toBe('done');
    expect(alignmentCallCount).toBe(2);
    expect(saved).toContain('[00:00.00]첫 번째 약한 줄');
    expect(saved).toContain('첫 번째 약한 줄');
    expect(saved).toContain('두 번째 약한 줄');
  });

  it('saves a partial result and marks the song unsynced when estimate density is unsafe', async () => {
    let saved = '';
    state.songLibrary.push({ path: 'unsafe-density' });
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'load_lrc_file') return '[00:00.00]첫 번째 긴 후렴 가사\n[00:00.00]두 번째 긴 후렴 가사';
      if (cmd === 'get_model_list') return ['한국어 모델|/models/wav2vec2-korean-lyrics'];
      if (cmd === 'run_forced_alignment') {
        return {
          lines: [
            { segment_id: 'segment:0', text: '첫 번째 긴 후렴 가사', start_ms: 1_000, end_ms: 1_300, confidence: 0, token_coverage: 1, greedy_text_similarity: 0.3 },
            { segment_id: 'segment:1', text: '두 번째 긴 후렴 가사', start_ms: 1_320, end_ms: 1_600, confidence: 0, token_coverage: 1, greedy_text_similarity: 0.3 },
          ],
          diagnostics: {
            audio_duration_ms: 2_000,
            vocal_regions: [{ start_ms: 1_000, end_ms: 1_600, activity: 0.9 }],
          },
        };
      }
      if (cmd === 'save_lrc_file') { saved = args.content; return 'ok'; }
      return null;
    });

    enqueueAlignment(['unsafe-density']);
    await flushQueue();

    const item = state.alignmentQueue.find((entry) => entry.path === 'unsafe-density');
    expect(item.status).toBe('done');
    expect(item.note).toContain('2줄 미싱크');
    expect(saved.match(/\[00:00\.00\]/g)).toHaveLength(2);
    expect(state.songLibrary[0].lyricSyncStatus).toBe('unsynced');
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
