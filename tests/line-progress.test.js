/**
 * 줄 안 진행도(가라오케 와이프).
 *
 * 단어 타임이 있으면 실제 발음 시점으로, 없으면 줄 단위 선형 보간으로
 * 물러난다 — 없다고 아무것도 안 그리면 예전보다 나빠진다(예전에 정렬한 곡,
 * 손으로 쓴 LRC, 다른 앱에서 가져온 가사가 전부 그쪽이다).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  lineProgress, buildAlignmentMetadata, applyAlignmentMetadata,
  readVocalRegions, snapToVocalEdge,
} from '../src/js/alignment-metadata.js';

/** 오버레이 쪽 정본 구현(shared.js는 클래식 스크립트라 이렇게 불러온다). */
function loadOverlayRatio() {
  const src = fs.readFileSync(path.resolve('src/js/overlay/shared.js'), 'utf-8');
  const w = {};
  new Function('window', src)(w);
  return w.OverlayShared.lineWipeRatio;
}

describe('lineProgress — 단어 타임이 없을 때', () => {
  const seg = { start: 10, end: 14 };   // 10s ~ 14s

  it('줄 시작 전이면 0', () => {
    expect(lineProgress(seg, 9000)).toBe(0);
    expect(lineProgress(seg, 10000)).toBe(0);
  });

  it('줄이 끝나면 1', () => {
    expect(lineProgress(seg, 14000)).toBe(1);
    expect(lineProgress(seg, 20000)).toBe(1);
  });

  it('가운데는 선형 보간', () => {
    expect(lineProgress(seg, 12000)).toBeCloseTo(0.5, 3);
    expect(lineProgress(seg, 11000)).toBeCloseTo(0.25, 3);
  });

  it('길이가 0이면 0 (0으로 나누지 않는다)', () => {
    expect(lineProgress({ start: 5, end: 5 }, 5000)).toBe(0);
  });

  it('잘못된 입력에 견딘다', () => {
    expect(lineProgress(null, 100)).toBe(0);
    expect(lineProgress(seg, NaN)).toBe(0);
    expect(lineProgress(seg, undefined)).toBe(0);
  });
});

describe('lineProgress — 단어 타임이 있을 때', () => {
  // "아침" (10.0~10.6) "햇살" (11.4~12.0)  — 사이에 숨 쉬는 구간이 있다
  const seg = {
    start: 10, end: 12,
    words: [
      { word: '아침', startMs: 10000, endMs: 10600 },
      { word: '햇살', startMs: 11400, endMs: 12000 },
    ],
  };

  it('첫 단어를 부르는 동안 그 단어 몫만큼만 찬다', () => {
    // 두 단어 모두 2글자 → 각각 0.5씩
    expect(lineProgress(seg, 10300)).toBeCloseTo(0.25, 2);
    expect(lineProgress(seg, 10600)).toBeCloseTo(0.5, 2);
  });

  it('단어 사이 빈 구간에서는 멈춰 있는다', () => {
    // 여기서 이어서 채우면 아직 부르지 않은 글자가 미리 칠해진다.
    expect(lineProgress(seg, 10800)).toBeCloseTo(0.5, 2);
    expect(lineProgress(seg, 11200)).toBeCloseTo(0.5, 2);
    expect(lineProgress(seg, 11399)).toBeCloseTo(0.5, 2);
  });

  it('둘째 단어에서 다시 찬다', () => {
    expect(lineProgress(seg, 11700)).toBeCloseTo(0.75, 2);
    expect(lineProgress(seg, 12000)).toBe(1);
  });

  it('긴 단어가 순식간에 칠해지지 않는다 (글자 수 가중치)', () => {
    const s2 = {
      start: 0, end: 2,
      words: [
        { word: '아', startMs: 0, endMs: 1000 },          // 1글자
        { word: '아름다운날', startMs: 1000, endMs: 2000 }, // 5글자
      ],
    };
    // 첫 단어를 다 불러도 6분의 1만 찬다.
    expect(lineProgress(s2, 1000)).toBeCloseTo(1 / 6, 2);
  });

  it('단조 증가한다', () => {
    let prev = -1;
    for (let t = 9500; t <= 12500; t += 50) {
      const v = lineProgress(seg, t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBe(1);
  });

  it('항상 0~1 범위', () => {
    for (let t = 0; t <= 20000; t += 137) {
      const v = lineProgress(seg, t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('사이드카 — 단어 타임 왕복', () => {
  const segments = [
    { text: '첫 줄', start: 1, end: 2, approx: false, words: [{ word: '첫', startMs: 1000, endMs: 1400 }] },
    { text: '둘째 줄', start: 2, end: 3 },
  ];

  it('저장했다가 읽으면 단어 타임이 살아 있다', () => {
    const sidecar = buildAlignmentMetadata(segments);
    expect(sidecar.schemaVersion).toBe(2);
    expect(sidecar.segments[0].words).toEqual([{ t: '첫', s: 1000, e: 1400 }]);
    expect(sidecar.segments[1].words).toBeNull();

    const fresh = segments.map(({ words, ...rest }) => ({ ...rest }));
    const { segments: out, appliedCount } = applyAlignmentMetadata(fresh, sidecar);
    expect(appliedCount).toBe(2);
    expect(out[0].words).toEqual([{ word: '첫', startMs: 1000, endMs: 1400 }]);
    expect(out[1].words).toBeUndefined();
  });

  it('망가진 단어 항목은 버리고 나머지는 살린다', () => {
    const s = buildAlignmentMetadata([
      { text: 'x', start: 0, end: 1, words: [
        { word: '', startMs: 0, endMs: 100 },        // 빈 텍스트
        { word: 'a', startMs: 200, endMs: 100 },     // 끝이 시작보다 앞
        { word: 'b', startMs: 300, endMs: 400 },     // 정상
      ] },
    ]);
    expect(s.segments[0].words).toEqual([{ t: 'b', s: 300, e: 400 }]);
  });

  it('v1 사이드카(단어 없음)도 거부하지 않는다', () => {
    const sidecar = buildAlignmentMetadata(segments);
    sidecar.schemaVersion = 1;
    sidecar.segments.forEach((e) => { delete e.words; });
    const { appliedCount, reason } = applyAlignmentMetadata(segments.map((x) => ({ ...x })), sidecar);
    expect(reason).toBe('applied');
    expect(appliedCount).toBe(2);
  });
});


describe('두 구현이 어긋나지 않는다', () => {
  // 오버레이 페이지는 클래식 스크립트라 ES 모듈(alignment-metadata.js)을 못
  // 부른다. 그래서 같은 규칙이 두 곳에 있다 — 어긋나면 앱 화면과 방송 화면의
  // 진행도가 달라지므로 여기서 같은 표로 대조한다.
  const overlayRatio = loadOverlayRatio();

  const cases = [
    { start: 10, end: 12, words: [['아침', 10000, 10600], ['햇살', 11400, 12000]] },
    { start: 0, end: 2, words: [['아', 0, 1000], ['아름다운날', 1000, 2000]] },
    { start: 5, end: 9, words: [] },
    { start: 3, end: 3, words: [] },
  ];

  it.each(cases)('start=$start end=$end 에서 같은 값을 낸다', ({ start, end, words }) => {
    const seg = {
      start, end,
      words: words.map(([t, s, e]) => ({ word: t, startMs: s, endMs: e })),
    };
    for (let t = (start * 1000) - 500; t <= (end * 1000) + 500; t += 73) {
      const app = lineProgress(seg, t);
      const overlay = overlayRatio(words, start * 1000, end * 1000, t);
      expect(overlay).toBeCloseTo(app, 6);
    }
  });
});

describe('보컬 활동 구간 — 저장·복원', () => {
  const regions = [
    { start_ms: 1000, end_ms: 2500, activity: 0.82 },
    { start_ms: 4000, end_ms: 6000, activity: 0.41 },
  ];

  it('사이드카 최상위에 담긴다 (곡 단위 값이라 줄과 무관)', () => {
    const s = buildAlignmentMetadata([{ text: 'a', start: 1, end: 2 }], { vocalRegions: regions });
    expect(s.vocalRegions).toEqual([
      { s: 1000, e: 2500, a: 0.82 },
      { s: 4000, e: 6000, a: 0.41 },
    ]);
  });

  it('없으면 필드를 만들지 않는다', () => {
    const s = buildAlignmentMetadata([{ text: 'a', start: 1, end: 2 }]);
    expect(s.vocalRegions).toBeUndefined();
  });

  it('망가진 구간은 버린다', () => {
    const s = buildAlignmentMetadata([{ text: 'a', start: 0, end: 1 }], {
      vocalRegions: [
        { start_ms: 100, end_ms: 50 },    // 끝이 시작보다 앞
        { start_ms: 'x', end_ms: 200 },   // 숫자가 아님
        { start_ms: 300, end_ms: 400, activity: 0.5 },
      ],
    });
    expect(s.vocalRegions).toEqual([{ s: 300, e: 400, a: 0.5 }]);
  });

  it('읽으면 카멜케이스로 돌아온다', () => {
    const s = buildAlignmentMetadata([{ text: 'a', start: 1, end: 2 }], { vocalRegions: regions });
    expect(readVocalRegions(s)).toEqual([
      { startMs: 1000, endMs: 2500, activity: 0.82 },
      { startMs: 4000, endMs: 6000, activity: 0.41 },
    ]);
  });

  it('사이드카가 없거나 비어도 빈 배열', () => {
    expect(readVocalRegions(null)).toEqual([]);
    expect(readVocalRegions({})).toEqual([]);
  });

  it('가사를 고쳐 줄이 바뀌어도 보컬 구간은 유효하다', () => {
    // 곡 단위 값이라 sourceFingerprint 검사와 무관해야 한다.
    const s = buildAlignmentMetadata([{ text: 'a', start: 1, end: 2 }], { vocalRegions: regions });
    const { appliedCount } = applyAlignmentMetadata([{ text: '완전히 다른 줄', start: 9, end: 10 }], s);
    expect(appliedCount).toBe(0);          // 줄 복원은 거부되지만
    expect(readVocalRegions(s)).toHaveLength(2);  // 오디오 기반 값은 그대로 읽힌다
  });
});

describe('경계 스냅', () => {
  const regions = [
    { startMs: 1000, endMs: 2500, activity: 0.8 },
    { startMs: 4000, endMs: 6000, activity: 0.4 },
  ];

  it('가까운 온셋에 붙는다', () => {
    expect(snapToVocalEdge(regions, 1040)).toBe(1000);
    expect(snapToVocalEdge(regions, 2460)).toBe(2500);
    expect(snapToVocalEdge(regions, 3950)).toBe(4000);
  });

  it('허용 범위 밖이면 붙지 않는다 (원래 값을 쓰게 null)', () => {
    expect(snapToVocalEdge(regions, 3000)).toBeNull();
    expect(snapToVocalEdge(regions, 1200)).toBeNull();
  });

  it('허용 범위는 조절할 수 있다', () => {
    expect(snapToVocalEdge(regions, 1200, 300)).toBe(1000);
  });

  it('두 온셋 사이면 더 가까운 쪽', () => {
    // 2500과 4000 사이 — 2900은 2500 쪽(400) vs 4000 쪽(1100)
    expect(snapToVocalEdge(regions, 2900, 500)).toBe(2500);
    expect(snapToVocalEdge(regions, 3800, 500)).toBe(4000);
  });

  it('구간이 없으면 null — 정렬한 적 없는 곡에서도 편집이 막히면 안 된다', () => {
    expect(snapToVocalEdge([], 1000)).toBeNull();
    expect(snapToVocalEdge(null, 1000)).toBeNull();
    expect(snapToVocalEdge(regions, NaN)).toBeNull();
  });
});
