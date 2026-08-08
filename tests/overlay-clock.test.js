/**
 * 오버레이 재생 위치 시계.
 *
 * 앱은 위치를 100ms 간격으로 보낸다. 그걸 그대로 그리면 진행바도 줄 안
 * 진행도도 100ms 계단이 된다. 이 시계가 패킷 사이를 메운다.
 *
 * 시간은 performance.now()를 가짜로 갈아 끼워 결정적으로 검사한다.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('src/js/overlay/shared.js'), 'utf-8');

let clockNow = 0;
const realPerf = globalThis.performance;

function makeClock() {
  const w = {};
  // shared.js는 (function(global){...})(window) 형태라 window를 주입한다.
  new Function('window', src)(w);
  return w.OverlayShared.createPositionClock();
}

beforeEach(() => {
  clockNow = 1000;
  globalThis.performance = { now: () => clockNow };
});

afterEach(() => {
  globalThis.performance = realPerf;
});

/** 벽시계를 ms만큼 흘린다. */
const advance = (ms) => { clockNow += ms; };

describe('위치 시계 — 기본', () => {
  it('정지 상태면 받은 값을 그대로 쓴다', () => {
    const c = makeClock();
    c.update(5000, 200000, false);
    expect(Math.round(c.now())).toBe(5000);
    advance(500);
    // 멈춰 있으면 시간이 흘러도 움직이지 않는다.
    expect(Math.round(c.now())).toBe(5000);
  });

  it('길이를 기억한다', () => {
    const c = makeClock();
    c.update(1000, 200000, false);
    expect(c.getDuration()).toBe(200000);
    // 0이 오면 무시한다(길이를 모르는 패킷에 덮이면 진행바가 사라진다).
    c.update(1100, 0, false);
    expect(c.getDuration()).toBe(200000);
  });

  it('재생 여부를 알려준다', () => {
    const c = makeClock();
    c.update(0, 1000, false);
    expect(c.isPlaying()).toBe(false);
    c.update(0, 1000, true);
    expect(c.isPlaying()).toBe(true);
  });
});

describe('위치 시계 — 패킷 사이를 메운다', () => {
  it('패킷이 없어도 시간이 흐르면 위치가 늘어난다', () => {
    const c = makeClock();
    c.update(5000, 200000, false);
    c.update(5000, 200000, true);   // 재생 시작 → 스냅
    c.now();                        // 틱 기준 시각 잡기
    advance(50);
    const mid = c.now();
    // 계단이 아니라 실제로 진행해야 한다.
    expect(mid).toBeGreaterThan(5000);
    expect(mid).toBeLessThan(5120);
  });

  it('프레임마다 단조 증가한다', () => {
    const c = makeClock();
    c.update(0, 200000, false);
    c.update(0, 200000, true);
    c.now();
    let prev = c.now();
    for (let i = 0; i < 30; i++) {
      advance(16);
      const v = c.now();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // 30프레임 × 16ms ≈ 480ms 진행
    expect(prev).toBeGreaterThan(300);
  });
});

describe('위치 시계 — 어긋남 처리', () => {
  it('큰 점프(탐색)는 즉시 맞춘다', () => {
    const c = makeClock();
    c.update(0, 200000, false);
    c.update(0, 200000, true);
    c.now();
    advance(100);
    c.now();
    c.update(120000, 200000, true);   // 사용자가 탐색
    expect(Math.round(c.now())).toBeGreaterThan(119000);
    expect(Math.round(c.now())).toBeLessThan(121000);
  });

  it('작은 오차는 튀지 않고 수렴한다', () => {
    const c = makeClock();
    c.update(10000, 200000, false);
    c.update(10000, 200000, true);
    c.now();
    advance(100);
    const before = c.now();
    // 실제보다 80ms 앞선 패킷 — 스냅 임계(400ms) 안쪽이다.
    c.update(10180, 200000, true);
    const after = c.now();
    // 한 프레임에 80ms를 통째로 점프하면 눈에 띈다.
    expect(Math.abs(after - before)).toBeLessThan(60);
  });

  it('정지했다가 다시 재생하면 그 위치로 맞춘다', () => {
    const c = makeClock();
    c.update(3000, 200000, true);
    c.now();
    advance(1000);
    c.now();
    c.update(3000, 200000, false);    // 정지
    expect(Math.round(c.now())).toBe(3000);
    c.update(3000, 200000, true);     // 다시 재생
    expect(Math.round(c.now())).toBe(3000);
  });

  it('곡 길이를 넘지 않는다', () => {
    const c = makeClock();
    c.update(9900, 10000, false);
    c.update(9900, 10000, true);
    c.now();
    advance(5000);
    expect(c.now()).toBeLessThanOrEqual(10000);
  });

  it('음수로 내려가지 않는다', () => {
    const c = makeClock();
    c.update(0, 10000, false);
    expect(c.now()).toBeGreaterThanOrEqual(0);
  });
});

describe('위치 시계 — 배속 추정', () => {
  it('배속이 걸려도 따라간다 (패킷에서 직접 추정)', () => {
    const c = makeClock();
    c.update(0, 200000, false);
    c.update(0, 200000, true);
    c.now();
    // 1.5배속: 벽시계 100ms마다 위치가 150ms씩 는다.
    for (let i = 1; i <= 12; i++) {
      advance(100);
      c.now();
      c.update(i * 150, 200000, true);
    }
    const at = c.now();
    advance(100);
    const later = c.now();
    // 한 패킷 주기 동안 100ms가 아니라 150ms에 가깝게 진행해야 한다.
    expect(later - at).toBeGreaterThan(120);
    expect(later - at).toBeLessThan(190);
  });
});
