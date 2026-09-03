import { describe, it, expect } from 'vitest';
import {
  MIN_SEGMENT_LEN, findNextStarted, findPrevStarted, planSegmentEnd, planSegmentStart,
} from '../src/js/segment-bounds.js';

/**
 * 이 테스트가 생긴 이유 — 가사 끝(Shift+Enter)이 다음 줄 시작 앞에서 잘려서,
 * AI 정렬을 한 번 돌리고 나면(모든 줄에 시작이 생김) 아무것도 못 넘겼다.
 * 반대로 방향키 미세조정은 이웃을 마음대로 침범했다. 같은 편집기 안에서
 * 규칙이 정반대였고, 그 규칙을 여기 하나로 모았다.
 */

const seg = (start, end) => ({ start, end });

describe('findNextStarted / findPrevStarted', () => {
  it('아직 안 찍은 줄(start<=0)은 건너뛴다', () => {
    // 손으로 처음부터 찍어 나갈 때 뒤의 빈 줄들이 벽이 되면 안 된다.
    const segs = [seg(10, 14), seg(0, 0), seg(30, 34)];
    expect(findNextStarted(segs, 0).start).toBe(30);
  });

  it('뒤에 찍힌 줄이 없으면 null', () => {
    expect(findNextStarted([seg(10, 14), seg(0, 0)], 0)).toBe(null);
  });

  it('앞쪽도 같은 규칙', () => {
    const segs = [seg(5, 8), seg(0, 0), seg(20, 24)];
    expect(findPrevStarted(segs, 2).start).toBe(5);
    expect(findPrevStarted(segs, 0)).toBe(null);
  });
});

describe('planSegmentEnd — 끝을 옮길 때', () => {
  it('다음 줄 시작을 넘으면 그 줄을 밀어준다', () => {
    // 예전에는 15.00에서 잘렸다. 사용자가 "여기까지가 이 줄"이라고 찍은 것이므로
    // 다음 줄이 물러나는 게 맞다.
    const plan = planSegmentEnd({ seg: seg(10, 14), next: seg(15, 19), duration: 200, requestedEnd: 17 });
    expect(plan.applied).toBe(17);
    expect(plan.pushNextStartTo).toBe(17);
  });

  it('다음 줄을 통째로 삼키지는 않는다', () => {
    // 다음 줄도 최소 길이는 남긴다.
    const plan = planSegmentEnd({ seg: seg(10, 14), next: seg(15, 19), duration: 200, requestedEnd: 100 });
    expect(plan.applied).toBeCloseTo(19 - MIN_SEGMENT_LEN, 5);
    expect(plan.pushNextStartTo).toBeCloseTo(19 - MIN_SEGMENT_LEN, 5);
  });

  it('다음 줄을 안 넘으면 밀지 않는다', () => {
    const plan = planSegmentEnd({ seg: seg(10, 14), next: seg(20, 24), duration: 200, requestedEnd: 16 });
    expect(plan.applied).toBe(16);
    expect(plan.pushNextStartTo).toBe(null);
  });

  it('다음 줄이 없으면 곡 끝까지 자유롭다', () => {
    const plan = planSegmentEnd({ seg: seg(10, 14), next: null, duration: 200, requestedEnd: 180 });
    expect(plan.applied).toBe(180);
    expect(plan.pushNextStartTo).toBe(null);
  });

  it('곡 길이를 넘지는 않는다', () => {
    const plan = planSegmentEnd({ seg: seg(10, 14), next: null, duration: 200, requestedEnd: 999 });
    expect(plan.applied).toBe(200);
  });

  it('자기 시작보다 앞으로는 못 간다', () => {
    const plan = planSegmentEnd({ seg: seg(10, 14), next: null, duration: 200, requestedEnd: 5 });
    expect(plan.applied).toBeCloseTo(10 + MIN_SEGMENT_LEN, 5);
  });

  it('다음 줄이 딱 붙어 있어 자리가 없으면 null', () => {
    const plan = planSegmentEnd({ seg: seg(10, 14), next: seg(10.02, 10.03), duration: 200, requestedEnd: 12 });
    expect(plan).toBe(null);
  });
});

describe('planSegmentStart — 시작을 옮길 때 (앞뒤 대칭)', () => {
  it('앞 줄 끝보다 앞으로 가면 앞 줄을 당겨준다', () => {
    const plan = planSegmentStart({ seg: seg(15, 19), prev: seg(10, 14), requestedStart: 13 });
    expect(plan.applied).toBe(13);
    expect(plan.pullPrevEndTo).toBe(13);
  });

  it('앞 줄을 통째로 삼키지는 않는다', () => {
    const plan = planSegmentStart({ seg: seg(15, 19), prev: seg(10, 14), requestedStart: 0 });
    expect(plan.applied).toBeCloseTo(10 + MIN_SEGMENT_LEN, 5);
  });

  it('앞 줄을 안 넘으면 당기지 않는다', () => {
    const plan = planSegmentStart({ seg: seg(15, 19), prev: seg(10, 14), requestedStart: 14.5 });
    expect(plan.applied).toBe(14.5);
    expect(plan.pullPrevEndTo).toBe(null);
  });

  it('앞 줄이 없으면 0까지 자유롭다', () => {
    const plan = planSegmentStart({ seg: seg(15, 19), prev: null, requestedStart: -5 });
    expect(plan.applied).toBe(0);
  });

  it('자기 끝보다 뒤로는 못 간다', () => {
    const plan = planSegmentStart({ seg: seg(15, 19), prev: null, requestedStart: 25 });
    expect(plan.applied).toBeCloseTo(19 - MIN_SEGMENT_LEN, 5);
  });
});

describe('끝과 시작이 같은 규칙을 쓴다', () => {
  it('끝을 밀든 시작을 당기든 두 줄은 한 점에서 만난다', () => {
    // 어느 쪽에서 조작하든 결과가 같아야 사용자가 헷갈리지 않는다.
    const byEnd = planSegmentEnd({ seg: seg(10, 14), next: seg(15, 19), duration: 200, requestedEnd: 16 });
    const byStart = planSegmentStart({ seg: seg(15, 19), prev: seg(10, 14), requestedStart: 16 });
    expect(byEnd.applied).toBe(16);
    expect(byEnd.pushNextStartTo).toBe(16);
    expect(byStart.applied).toBe(16);
    // 시작을 16으로 옮기는 건 앞 줄 끝(14)보다 뒤라 당길 필요가 없다.
    expect(byStart.pullPrevEndTo).toBe(null);
  });
});

/**
 * 끝 지정(Shift+Enter)이 어느 줄을 대상으로 삼는가.
 *
 * 실제로 났던 사고 — 목록에서 줄을 클릭하면 `currentSyncIndex = 클릭한 줄`이
 * 되는데, 끝 지정은 늘 `currentSyncIndex - 1`을 봤다. 그래서 줄을 고르고
 * Shift+Enter를 누르면 **그 앞 줄**의 끝이 바뀌고, 고른 줄의 시작이 끌려왔다.
 * 두 경로가 같은 값(lastTappedIndex)을 보게 해서 없앤 버그다.
 */
describe('끝 지정 대상 고르기', () => {
  const hasText = (seg) => !!(seg.text || '').trim();

  /** markLineEnd가 쓰는 규칙과 같은 계산. */
  function resolveEndTarget(segments, { lastTappedIndex, currentSyncIndex }) {
    let idx = lastTappedIndex >= 0 ? lastTappedIndex : currentSyncIndex - 1;
    while (idx >= 0 && !hasText(segments[idx])) idx -= 1;
    return idx;
  }

  const segs = [
    { text: '0줄', start: 10, end: 14 },
    { text: '1줄', start: 15, end: 19 },
    { text: '2줄', start: 20, end: 24 },
  ];

  it('목록에서 클릭한 줄이 대상이다', () => {
    // 클릭은 currentSyncIndex와 lastTappedIndex를 같은 값으로 둔다.
    expect(resolveEndTarget(segs, { lastTappedIndex: 2, currentSyncIndex: 2 })).toBe(2);
  });

  it('Enter로 방금 찍은 줄이 대상이다', () => {
    // 찍으면 currentSyncIndex는 다음 줄로 넘어가고, lastTappedIndex는 찍은 줄에 남는다.
    expect(resolveEndTarget(segs, { lastTappedIndex: 1, currentSyncIndex: 2 })).toBe(1);
  });

  it('가사가 빈 줄은 건너뛰고 앞의 실제 줄로 물러난다', () => {
    const withBlank = [{ text: '첫줄', start: 10, end: 14 }, { text: '', start: 0, end: 0 }];
    expect(resolveEndTarget(withBlank, { lastTappedIndex: 1, currentSyncIndex: 2 })).toBe(0);
  });

  it('아무 줄도 안 골랐으면 대상이 없다', () => {
    expect(resolveEndTarget(segs, { lastTappedIndex: -1, currentSyncIndex: 0 })).toBe(-1);
  });

  it('옛 상태(lastTappedIndex 없음)에서는 예전 규칙으로 물러난다', () => {
    expect(resolveEndTarget(segs, { lastTappedIndex: -1, currentSyncIndex: 2 })).toBe(1);
  });
});
