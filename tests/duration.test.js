import { describe, expect, it } from 'vitest';
import { durationToSeconds } from '../src/js/duration.js';

describe('durationToSeconds', () => {
  it('mm:ss와 hh:mm:ss를 초로 바꾼다', () => {
    expect(durationToSeconds('3:47')).toBe(227);
    expect(durationToSeconds('0:59')).toBe(59);
    expect(durationToSeconds('1:02:03')).toBe(3723);
  });

  it('숫자는 그대로 초로 본다', () => {
    expect(durationToSeconds(227)).toBe(227);
    expect(durationToSeconds(227.5)).toBe(227.5);
  });

  it('해석할 수 없으면 값을 지어내지 않고 null을 준다', () => {
    // 여기서 0이나 NaN을 돌려주면 LRCLIB이 엉뚱한 길이 후보를 매칭한다.
    expect(durationToSeconds(null)).toBeNull();
    expect(durationToSeconds(undefined)).toBeNull();
    expect(durationToSeconds('')).toBeNull();
    expect(durationToSeconds('-')).toBeNull();
    expect(durationToSeconds('약 3분')).toBeNull();
    expect(durationToSeconds('3분 47초')).toBeNull();
    expect(durationToSeconds('abc')).toBeNull();
    expect(durationToSeconds(0)).toBeNull();
    expect(durationToSeconds(-5)).toBeNull();
    expect(durationToSeconds(NaN)).toBeNull();
  });

  it('시:분:초를 넘는 자릿수는 받지 않는다', () => {
    expect(durationToSeconds('1:2:3:4')).toBeNull();
  });

  it('앞뒤 공백은 무시한다', () => {
    expect(durationToSeconds('  3:47  ')).toBe(227);
  });
});
