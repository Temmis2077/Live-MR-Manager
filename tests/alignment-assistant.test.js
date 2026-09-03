import { describe, expect, it } from 'vitest';
import { applyAlignmentAssistant, assessAlignmentSegments } from '../src/js/alignment-assistant.js';

describe('alignment assistant validation', () => {
    it('marks an estimated block with no acoustic evidence as invalid silence', () => {
        const result = assessAlignmentSegments([
            { text: '가사', start: 1, end: 2, approx: true, alignmentTrust: 'estimated', alignmentSource: 'anchor_interpolation' },
        ], [{ startMs: 5_000, endMs: 6_000, activity: 0.8 }], 10_000);
        expect(result[0]).toMatchObject({
            status: 'invalid_silence',
            reasonCodes: ['no_vocal_or_lexical_evidence'],
            vocalOverlapMs: 0,
        });
    });

    it('moves an invalid automatic block only when there is one safe candidate', () => {
        const segments = [
            { text: '가사', start: 1, end: 2, approx: true, alignmentTrust: 'estimated', alignmentSource: 'anchor_interpolation' },
        ];
        const result = applyAlignmentAssistant(segments, [{ startMs: 5_000, endMs: 6_000 }], 10_000);
        expect(result.changes).toHaveLength(1);
        expect(segments[0]).toMatchObject({ start: 5, end: 6, alignmentSource: 'vad_boundary_review' });
        expect(segments[0].syncAssistant.previousRange).toEqual({ startMs: 1_000, endMs: 2_000 });
    });

    it('clears an unsupported estimate when several candidates are ambiguous', () => {
        const segments = [
            { text: '가사', start: 1, end: 2, approx: true, alignmentTrust: 'estimated', alignmentSource: 'anchor_interpolation' },
        ];
        applyAlignmentAssistant(segments, [
            { startMs: 5_000, endMs: 6_000 },
            { startMs: 7_000, endMs: 8_000 },
        ], 10_000);
        expect(segments[0]).toMatchObject({ start: 0, end: 0, alignmentSource: 'unsynced_review' });
    });

    it('does not move an invalid line onto a vocal region already used by another lyric', () => {
        const segments = [
            { text: '잘못된 줄', start: 1, end: 2, approx: true, alignmentTrust: 'estimated', alignmentSource: 'anchor_interpolation' },
            { text: '정상 줄', start: 5, end: 6, approx: false, alignmentTrust: 'manual' },
        ];
        applyAlignmentAssistant(segments, [{ startMs: 5_000, endMs: 6_000 }], 10_000);
        expect(segments[0]).toMatchObject({ start: 0, end: 0, alignmentSource: 'unsynced_review' });
        expect(segments[1]).toMatchObject({ start: 5, end: 6 });
    });

    it('does not move manual timing even when VAD disagrees', () => {
        const segments = [{ text: '수동', start: 1, end: 2, approx: false, alignmentTrust: 'manual' }];
        const result = applyAlignmentAssistant(segments, [{ startMs: 5_000, endMs: 6_000 }], 10_000);
        expect(result.changes).toHaveLength(0);
        expect(segments[0]).toMatchObject({ start: 1, end: 2 });
        expect(segments[0].syncAssistant).toMatchObject({
            status: 'confirmed',
            reasonCodes: ['manual_vad_disagreement'],
            suggestedRange: { startMs: 5_000, endMs: 6_000 },
            autoFixSafe: false,
        });
    });

    it('treats an empty VAD source as unavailable instead of interpolating', () => {
        const segments = [
            { text: '가사', start: 1, end: 2, approx: true, alignmentTrust: 'estimated', alignmentSource: 'anchor_interpolation' },
        ];
        applyAlignmentAssistant(segments, [], 10_000);
        expect(segments[0]).toMatchObject({ start: 0, end: 0, alignmentSource: 'unsynced_review' });
        expect(segments[0].syncAssistant.status).toBe('source_unavailable');
    });

    it('keeps strong lexical alignment even when VAD misses it', () => {
        const segments = [
            { text: '가사', start: 1, end: 2, approx: true, alignmentTrust: 'acoustic_strong', greedyTextSimilarity: 0.9 },
        ];
        const result = applyAlignmentAssistant(segments, [], 10_000);
        expect(result.changes).toHaveLength(0);
        expect(segments[0]).toMatchObject({ start: 1, end: 2 });
    });
});
