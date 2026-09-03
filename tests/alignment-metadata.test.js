import { describe, expect, it } from 'vitest';
import { applyAlignmentMetadata, buildAlignmentMetadata } from '../src/js/alignment-metadata.js';

describe('alignment metadata sidecar', () => {
  it('persists assistant reasoning without changing the LRC schema', () => {
    const source = [{
      text: '검토 줄', start: 1, end: 2, approx: true,
      syncAssistant: {
        status: 'estimated_review', reasonCodes: ['assistant_repositioned'],
        vocalOverlapMs: 900, vocalOverlapRatio: 0.9,
      },
    }];
    const restored = applyAlignmentMetadata(source, buildAlignmentMetadata(source)).segments;
    expect(restored[0].syncAssistant).toMatchObject({
      status: 'estimated_review', reasonCodes: ['assistant_repositioned'], vocalOverlapMs: 900,
    });
  });
  it('restores AI trust without changing source text or timing', () => {
    const sidecar = buildAlignmentMetadata([{
      text: '원문 가사', start: 12.34, end: 14, approx: true,
      alignmentTrust: 'acoustic_soft', alignmentSource: 'ctc',
      qualityFlags: ['doubling_ambiguity'], confidence: 0.1,
    }]);
    const restored = applyAlignmentMetadata([{ text: '원문 가사', start: 12.34, end: 0 }], sidecar);

    expect(restored.reason).toBe('applied');
    expect(restored.segments[0]).toMatchObject({
      text: '원문 가사', start: 12.34, approx: true,
      alignmentTrust: 'acoustic_soft', alignmentSource: 'ctc',
      qualityFlags: ['doubling_ambiguity'],
    });
  });

  it('rejects metadata when source order or text changed', () => {
    const sidecar = buildAlignmentMetadata([
      { text: '첫 줄', start: 1, approx: true },
      { text: '둘째 줄', start: 2, approx: true },
    ]);
    const restored = applyAlignmentMetadata([
      { text: '둘째 줄', start: 2 },
      { text: '첫 줄', start: 1 },
    ], sidecar);

    expect(restored.reason).toBe('source_mismatch');
    expect(restored.appliedCount).toBe(0);
    expect(restored.segments.every((segment) => segment.approx === undefined)).toBe(true);
  });

  it('treats an externally changed timestamp as manual while restoring unchanged lines', () => {
    const sidecar = buildAlignmentMetadata([
      { text: '첫 줄', start: 1, approx: true, alignmentTrust: 'acoustic_strong' },
      { text: '둘째 줄', start: 2, approx: true, alignmentTrust: 'acoustic_soft' },
    ]);
    const restored = applyAlignmentMetadata([
      { text: '첫 줄', start: 1 },
      { text: '둘째 줄', start: 3 },
    ], sidecar);

    expect(restored.reason).toBe('partial');
    expect(restored.segments[0].alignmentTrust).toBe('acoustic_strong');
    expect(restored.segments[1].approx).toBeUndefined();
  });

  it('preserves a user-confirmed non-approximate timing', () => {
    const sidecar = buildAlignmentMetadata([{
      text: '수동 확정', start: 4.2, approx: false, alignmentTrust: 'manual',
    }]);
    const restored = applyAlignmentMetadata([{ text: '수동 확정', start: 4.2 }], sidecar);
    expect(restored.segments[0]).toMatchObject({
      approx: false, alignmentTrust: 'manual', alignmentSource: 'manual',
    });
  });

  it('does not turn an untimed non-approximate placeholder into a manual anchor', () => {
    const sidecar = buildAlignmentMetadata([{
      text: '아직 미싱크', start: 0, end: 0, approx: false,
    }]);
    const restored = applyAlignmentMetadata([{ text: '아직 미싱크', start: 0, end: 0 }], sidecar);
    expect(restored.segments[0].alignmentTrust).not.toBe('manual');
    expect(restored.segments[0].alignmentSource).not.toBe('manual');
  });

  it('round-trips the VAD boundary evidence without writing it into LRC timing', () => {
    const source = [{
      text: '경계 복구', start: 1, end: 3, approx: true,
      alignmentSource: 'vad_boundary_review',
      vadAssignment: {
        regions: [{ startMs: 1_000, endMs: 1_800, activity: 0.8 }],
        startBoundary: 'vad_start', endBoundary: 'vad_end',
      },
    }];
    const restored = applyAlignmentMetadata(
      [{ text: '경계 복구', start: 1, end: 3 }],
      buildAlignmentMetadata(source),
    );
    expect(restored.segments[0]).toMatchObject({
      alignmentSource: 'vad_boundary_review',
      vadAssignment: { startBoundary: 'vad_start', endBoundary: 'vad_end' },
    });
  });
});
