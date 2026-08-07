/**
 * 가사 경계 히트테스트 회귀 테스트.
 *
 * 가사 블럭이 맞닿아 있으면(앞.end === 뒤.start) 같은 x에 경계가 둘 겹친다.
 * 예전 코드는 모든 구간을 forEach로 훑으며 결과를 매번 덮어써서 항상 나중
 * 것(뒤 블럭의 start)이 이겼고, 앞 블럭의 끝은 영영 집을 수 없었다.
 * 사용자에게는 "둘 다 마우스로 조절이 안 된다"로 보였다.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** alignment-viewer.js에서 pickBoundary만 떼어 내 실행 가능한 함수로 만든다. */
function loadPickBoundary() {
  const src = fs.readFileSync(path.resolve('src/js/alignment-viewer.js'), 'utf-8');
  const start = src.indexOf('    pickBoundary(list, x, hitThreshold = 8) {');
  expect(start).toBeGreaterThan(-1);
  // 메서드 본문을 중괄호 균형으로 잘라 낸다.
  let depth = 0;
  let i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(bodyStart + 1, i);
  // this.timeToX 만 쓰므로 그것만 채워 준다.
  // eslint-disable-next-line no-new-func
  const fn = new Function('list', 'x', 'hitThreshold', `const self = this; ${body}`);
  // 1초 = 100px 로 두면 계산이 눈에 보인다.
  const ctx = { timeToX: (t) => t * 100 };
  return (list, x, threshold = 8) => fn.call(ctx, list, x, threshold);
}

const pickBoundary = loadPickBoundary();

describe('pickBoundary — 떨어져 있는 블럭', () => {
  const segs = [
    { start: 1, end: 2 },   // 100px ~ 200px
    { start: 3, end: 4 },   // 300px ~ 400px
  ];

  it('가까운 경계가 없으면 null', () => {
    expect(pickBoundary(segs, 250)).toBeNull();
  });

  it('각 경계를 정확히 집는다', () => {
    expect(pickBoundary(segs, 100)).toEqual({ index: 0, type: 'start' });
    expect(pickBoundary(segs, 200)).toEqual({ index: 0, type: 'end' });
    expect(pickBoundary(segs, 300)).toEqual({ index: 1, type: 'start' });
    expect(pickBoundary(segs, 400)).toEqual({ index: 1, type: 'end' });
  });

  it('임계값 안쪽이면 집고 바깥이면 놓친다', () => {
    expect(pickBoundary(segs, 207)).toEqual({ index: 0, type: 'end' });
    expect(pickBoundary(segs, 209)).toBeNull();
  });
});

describe('pickBoundary — 맞닿은 블럭 (재발 지점)', () => {
  // 앞 블럭의 끝과 뒤 블럭의 시작이 정확히 같은 자리(200px).
  const touching = [
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ];

  it('경계 왼쪽에서는 앞 블럭의 끝을 집는다', () => {
    expect(pickBoundary(touching, 196)).toEqual({ index: 0, type: 'end' });
  });

  it('경계 오른쪽에서는 뒤 블럭의 시작을 집는다', () => {
    expect(pickBoundary(touching, 204)).toEqual({ index: 1, type: 'start' });
  });

  it('앞 블럭의 끝이 도달 불가능해지지 않는다', () => {
    // 예전 버그: 뒤 블럭의 start가 항상 이겨서 이 기대가 깨졌다.
    const left = pickBoundary(touching, 195);
    expect(left).not.toEqual({ index: 1, type: 'start' });
    expect(left.type).toBe('end');
  });

  it('세 블럭이 연달아 붙어 있어도 각 경계를 나눠 집는다', () => {
    const three = [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ];
    expect(pickBoundary(three, 96)).toEqual({ index: 0, type: 'end' });
    expect(pickBoundary(three, 104)).toEqual({ index: 1, type: 'start' });
    expect(pickBoundary(three, 196)).toEqual({ index: 1, type: 'end' });
    expect(pickBoundary(three, 204)).toEqual({ index: 2, type: 'start' });
  });
});

describe('pickBoundary — 방어', () => {
  it('배열이 아니면 null', () => {
    expect(pickBoundary(null, 100)).toBeNull();
    expect(pickBoundary(undefined, 100)).toBeNull();
  });

  it('빈 목록이면 null', () => {
    expect(pickBoundary([], 100)).toBeNull();
  });
});
