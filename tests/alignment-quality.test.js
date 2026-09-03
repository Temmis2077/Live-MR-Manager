import { describe, expect, it } from 'vitest';
import {
  attachMissingSegmentIds,
  alignmentTextSimilarity,
  buildAlignmentEntries,
  classifyAlignmentLine,
  gateAlignmentLines,
  segmentId,
} from '../src/js/alignment-quality.js';
import { mergeAlignmentResult } from '../src/js/lrc-parser.js';

describe('alignment identity and quality gate', () => {
  it('normalizes Hangul decomposition, case, spaces, and punctuation for lexical similarity', () => {
    expect(alignmentTextSimilarity('가슴엔, 눈물이!', '가슴엔 눈물이')).toBe(1);
    expect(alignmentTextSimilarity('Oh, YEAH', 'oh yeah')).toBe(1);
    expect(alignmentTextSimilarity('다음 본문 가사', '우우 예아')).toBeLessThan(0.25);
  });

  it('uses segment IDs so repeated lyrics map to their original blocks', () => {
    const segments = [
      { text: '사랑해 너를', start: 0, end: 0 },
      { text: '다른 줄', start: 0, end: 0 },
      { text: '사랑해 너를', start: 0, end: 0 },
    ];
    const entries = buildAlignmentEntries(segments);
    const lines = [
      { segment_id: segmentId(0), text: '사랑해 너를', start_ms: 10_000, end_ms: 11_000, confidence: 0.8 },
      { segment_id: segmentId(1), text: '다른 줄', start_ms: 12_000, end_ms: 13_000, confidence: 0.8 },
      { segment_id: segmentId(2), text: '사랑해 너를', start_ms: 20_000, end_ms: 21_000, confidence: 0.8 },
    ];
    expect(mergeAlignmentResult(segments, lines, entries)).toBe(3);
    expect(segments.map((s) => s.start)).toEqual([10, 12, 20]);
  });

  it('leaves low-evidence lines unsynced instead of inventing a timestamp', () => {
    const entries = [{ id: segmentId(0) }, { id: segmentId(1) }];
    const result = gateAlignmentLines([
      { segment_id: segmentId(0), start_ms: 1000, end_ms: 2000, confidence: 0.8, token_coverage: 1, vocal_activity: 0.8 },
      { segment_id: segmentId(1), start_ms: 3000, end_ms: 4000, confidence: 0.001, token_coverage: 0.4, vocal_activity: 0.01 },
    ], entries);
    expect(result.accepted.map((line) => line.segment_id)).toEqual([segmentId(0)]);
    expect(result.rejected[0].reasons).toEqual(expect.arrayContaining(['confidence', 'token_coverage', 'vocal_silence']));
  });

  it('keeps a low-confidence Korean timing when every structural signal corroborates it', () => {
    const entries = [{ id: segmentId(0) }];
    const result = gateAlignmentLines([{
      segment_id: segmentId(0),
      text: '가슴엔 늘 눈물이 고여',
      start_ms: 134_840,
      end_ms: 138_260,
      confidence: 0.000724,
      greedy_text_similarity: 0.62,
      acoustic_margin: 0.089,
      token_coverage: 1,
      vocal_activity: 0.756,
    }], entries);

    expect(result.rejected).toHaveLength(0);
    expect(result.softAccepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      segment_id: segmentId(0),
      gate_decision: 'low_confidence_corroborated',
      alignment_trust: 'acoustic_soft',
    });
    expect(result.accepted[0].quality_flags).toContain('doubling_ambiguity');
  });

  it('classifies ordinary accepted results as strong acoustic anchors', () => {
    const entries = [{ id: segmentId(0), repeatedLyric: true }];
    const result = gateAlignmentLines([{
      segment_id: segmentId(0),
      text: '반복 후렴',
      start_ms: 1_000,
      end_ms: 3_000,
      confidence: 0.7,
      greedy_text_similarity: 0.8,
      acoustic_margin: 0.5,
      token_coverage: 1,
      vocal_activity: 0.8,
    }], entries);
    expect(result.accepted[0]).toMatchObject({
      alignment_trust: 'acoustic_strong',
      repeated_lyric: true,
    });
  });

  it('still rejects confidence-only evidence without an explicit VAD measurement', () => {
    const entries = [{ id: segmentId(0) }];
    const result = gateAlignmentLines([{
      segment_id: segmentId(0),
      start_ms: 1000,
      end_ms: 2000,
      confidence: 0.001,
      acoustic_margin: 0.5,
      token_coverage: 1,
    }], entries);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reasons).toEqual(['confidence']);
  });

  it('keeps an ordinary lyric mismatch advisory instead of blocking its vocal region', () => {
    const entries = [{ id: segmentId(0), text: '다음 본문 가사', lineKind: 'lyric' }];
    const result = gateAlignmentLines([{
      segment_id: segmentId(0),
      text: '다음 본문 가사',
      extracted_text: '우우 예아',
      greedy_text_similarity: 0.08,
      start_ms: 1000,
      end_ms: 3000,
      confidence: 0.001,
      acoustic_margin: 0.5,
      token_coverage: 1,
      vocal_activity: 0.95,
    }], entries);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reasons).toContain('lexical_mismatch');
    expect(result.rejected[0].line.quality_flags).toContain('lexical_uncertain');
    expect(result.rejected[0].line.quality_flags).not.toContain('non_lexical_vocal_risk');
    expect(result.nonLexicalVocalRegions).toEqual([]);
  });

  it('requires independent lexical evidence before soft acceptance', () => {
    const entries = [{ id: segmentId(0), text: '가슴엔 늘 눈물이 고여', lineKind: 'lyric' }];
    const base = {
      segment_id: segmentId(0), text: entries[0].text,
      start_ms: 1000, end_ms: 3000, confidence: 0.001,
      acoustic_margin: 0.5, token_coverage: 1, vocal_activity: 0.8,
    };
    expect(gateAlignmentLines([{ ...base, greedy_text_similarity: 0.14 }], entries).accepted).toHaveLength(0);
    expect(gateAlignmentLines([{ ...base, greedy_text_similarity: 0.15 }], entries).softAccepted).toHaveLength(1);
  });

  it('classifies only explicit short vocables separately from ordinary onomatopoeia', () => {
    expect(classifyAlignmentLine('Oh yeah')).toBe('vocable');
    expect(classifyAlignmentLine('우우우')).toBe('vocable');
    expect(classifyAlignmentLine('빵빵 달려가')).toBe('lyric');
    expect(classifyAlignmentLine('쿵쿵')).toBe('lyric');
  });

  it('aligns a written vocable only when its greedy text also matches', () => {
    const entries = [{ id: segmentId(0), text: 'Oh', lineKind: 'vocable' }];
    const base = {
      segment_id: segmentId(0), text: 'Oh', start_ms: 1000, end_ms: 2500,
      confidence: 0.001, token_coverage: 1, vocal_activity: 0.8,
    };
    expect(gateAlignmentLines([{ ...base, greedy_text_similarity: 0.49 }], entries).accepted).toHaveLength(0);
    expect(gateAlignmentLines([{ ...base, greedy_text_similarity: 1 }], entries).softAccepted).toHaveLength(1);
  });

  it('blocks only an explicit mismatched vocable as non-lexical vocal', () => {
    const entries = [{ id: segmentId(0), text: 'Oh yeah', lineKind: 'vocable' }];
    const result = gateAlignmentLines([{
      segment_id: segmentId(0), text: 'Oh yeah', start_ms: 1000, end_ms: 3000,
      confidence: 0.001, acoustic_margin: 0.5, token_coverage: 1,
      vocal_activity: 0.9, greedy_text_similarity: 0.1,
    }], entries);
    expect(result.nonLexicalVocalRegions[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
    expect(result.rejected[0].line.quality_flags).toContain('non_lexical_vocal_risk');
  });

  it('allows a clearly matched written vocable to sustain longer than an ordinary short line', () => {
    const entries = [{ id: segmentId(0), text: '우우우', lineKind: 'vocable' }];
    const result = gateAlignmentLines([{
      segment_id: segmentId(0), text: '우우우', start_ms: 1000, end_ms: 7000,
      confidence: 0.001, acoustic_margin: 0.5, token_coverage: 1, vocal_activity: 0.8,
      greedy_text_similarity: 1,
    }], entries);
    expect(result.rejected).toHaveLength(0);
    expect(result.softAccepted).toHaveLength(1);
  });

  it('rejects the weaker result when chronological order is contradictory', () => {
    const entries = [{ id: segmentId(0) }, { id: segmentId(1) }];
    const result = gateAlignmentLines([
      { segment_id: segmentId(0), start_ms: 5000, end_ms: 6000, confidence: 0.9, token_coverage: 1, vocal_activity: 0.8 },
      { segment_id: segmentId(1), start_ms: 2000, end_ms: 3000, confidence: 0.4, token_coverage: 1, vocal_activity: 0.8 },
    ], entries);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].segment_id).toBe(segmentId(0));
    expect(result.rejected[0].reasons).toContain('out_of_order');
  });

  it('does not allow two acoustic results to claim the same original segment', () => {
    const entries = [{ id: segmentId(0) }];
    const result = gateAlignmentLines([
      { segment_id: segmentId(0), start_ms: 1000, end_ms: 2000, confidence: 0.8, token_coverage: 1 },
      { segment_id: segmentId(0), start_ms: 3000, end_ms: 4000, confidence: 0.8, token_coverage: 1 },
    ], entries);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reasons).toContain('duplicate_id');
  });

  it('preserves compatibility with a backend result that lacks new fields', () => {
    const attached = attachMissingSegmentIds([{ text: '가사', start_ms: 1000, end_ms: 2000 }], [{ id: segmentId(3) }]);
    expect(attached[0]).toMatchObject({ segment_id: segmentId(3), confidence: 1, token_coverage: 1 });
  });

  it('does not guess IDs by position when the backend omitted request rows', () => {
    const attached = attachMissingSegmentIds(
      [{ text: '뒤 한국어 줄', start_ms: 1000, end_ms: 2000 }],
      [{ id: segmentId(0) }, { id: segmentId(1) }],
    );
    expect(attached[0].segment_id).toBe('');
  });

  it('uses backend input_index before positional compatibility recovery', () => {
    const attached = attachMissingSegmentIds(
      [{ input_index: 1, text: '둘째 줄', start_ms: 1000, end_ms: 2000 }],
      [{ id: segmentId(0) }, { id: segmentId(1) }],
    );
    expect(attached[0].segment_id).toBe(segmentId(1));
  });

  it('uses a softer confidence floor only inside a bounded fallback window', () => {
    const entries = [{ id: segmentId(0) }, { id: segmentId(1) }, { id: segmentId(2) }];
    const result = gateAlignmentLines([
      { segment_id: segmentId(0), start_ms: 1000, end_ms: 1800, confidence: 0.03, token_coverage: 1, vocal_activity: 0.6 },
      { segment_id: segmentId(1), start_ms: 2000, end_ms: 2800, confidence: 0.14, token_coverage: 1, vocal_activity: 0.6 },
      { segment_id: segmentId(2), start_ms: 3000, end_ms: 3800, confidence: 0.16, token_coverage: 1, vocal_activity: 0.6 },
    ], entries, { windowStartMs: 0, windowEndMs: 4000, confidenceScale: 0.25 });
    expect(result.accepted).toHaveLength(3);
  });

  it('rejects a weak line that swallows an implausibly long gap', () => {
    const entries = [{ id: segmentId(0) }];
    const result = gateAlignmentLines([
      {
        segment_id: segmentId(0),
        text: 'Oh oh I’m drowning',
        start_ms: 1000,
        end_ms: 12_000,
        confidence: 0.05,
        acoustic_margin: 0.2,
        token_coverage: 1,
        vocal_activity: 0.8,
      },
    ], entries);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reasons).toContain('duration_sanity');
  });

  it('keeps a genuinely strong sustained line despite the duration heuristic', () => {
    const entries = [{ id: segmentId(0) }];
    const result = gateAlignmentLines([
      {
        segment_id: segmentId(0),
        text: 'Oh oh I’m drowning',
        start_ms: 1000,
        end_ms: 12_000,
        confidence: 0.8,
        acoustic_margin: 0.8,
        token_coverage: 1,
        vocal_activity: 0.8,
      },
    ], entries);
    expect(result.accepted).toHaveLength(1);
  });

  it('rechecks chronology after displacing multiple weaker predecessors', () => {
    const entries = [0, 1, 2].map((index) => ({ id: segmentId(index) }));
    const result = gateAlignmentLines([
      { segment_id: segmentId(0), start_ms: 10_000, end_ms: 11_000, confidence: 0.7, token_coverage: 1 },
      { segment_id: segmentId(1), start_ms: 30_000, end_ms: 31_000, confidence: 0.1, token_coverage: 1 },
      { segment_id: segmentId(2), start_ms: 5_000, end_ms: 6_000, confidence: 0.9, token_coverage: 1 },
    ], entries);
    const starts = result.accepted.map((line) => line.start_ms);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(result.accepted.map((line) => line.segment_id)).toEqual([segmentId(2)]);
  });
});
