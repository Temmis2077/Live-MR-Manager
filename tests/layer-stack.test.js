import { describe, it, expect } from 'vitest';
import {
  pruneStack, topOf, hasLive, removeHandle, wasTop,
} from '../src/js/ui/layer-stack-core.js';

/**
 * 이 테스트가 생긴 이유 — 레이어를 올린 쪽이 pop을 빠뜨리면(같은 패널을 두 번
 * 열어 앞 핸들을 잃는 등) 스택이 영영 비지 않았고, `hasOpenLayer()`를 가드로
 * 쓰는 가사 싱크 편집기의 **키가 통째로 죽었다**(Space·Enter·Ctrl+Z 전부).
 * 화면에는 아무 표시가 없어 원인을 찾기 어려운 종류의 사고였다.
 */

/** 실제 구현은 DOM 상태를 보지만, 규칙만 볼 때는 표식 하나면 된다. */
const isAlive = (h) => h.alive !== false;
const layer = (id, alive = true) => ({ id, alive });

describe('pruneStack', () => {
  it('화면에서 사라진 레이어를 걷어낸다', () => {
    const stack = [layer('a'), layer('leaked', false), layer('b')];
    const { stack: next, dropped } = pruneStack(stack, isAlive);
    expect(next.map((h) => h.id)).toEqual(['a', 'b']);
    expect(dropped.map((h) => h.id)).toEqual(['leaked']);
  });

  it('걷어낼 게 없으면 원래 배열을 그대로 준다', () => {
    const stack = [layer('a'), layer('b')];
    const { stack: next, dropped } = pruneStack(stack, isAlive);
    expect(next).toBe(stack);
    expect(dropped).toEqual([]);
  });

  it('전부 샜으면 빈 스택이 된다', () => {
    const { stack: next } = pruneStack([layer('x', false), layer('y', false)], isAlive);
    expect(next).toEqual([]);
  });

  it('빈 스택도 안전하다', () => {
    expect(pruneStack([], isAlive).stack).toEqual([]);
  });
});

describe('topOf / hasLive', () => {
  it('가장 위의 살아 있는 레이어를 고른다', () => {
    const stack = [layer('a'), layer('b')];
    expect(topOf(stack, isAlive).id).toBe('b');
    expect(hasLive(stack, isAlive)).toBe(true);
  });

  it('샌 레이어는 건너뛰고 그 아래 진짜를 고른다', () => {
    // 안전망이 없으면 Escape가 이미 닫힌 것에게 가서 아무 일도 일어나지 않는다.
    const stack = [layer('real'), layer('leaked', false)];
    expect(topOf(stack, isAlive).id).toBe('real');
  });

  it('샌 것만 남았으면 떠 있는 게 없다고 본다 — 이게 회귀의 핵심', () => {
    const stack = [layer('leaked', false)];
    expect(hasLive(stack, isAlive)).toBe(false);
    expect(topOf(stack, isAlive)).toBe(null);
  });

  it('보이는 레이어는 그대로 막는다 — 안전망이 과하면 원래 버그가 돌아온다', () => {
    expect(hasLive([layer('modal')], isAlive)).toBe(true);
  });

  it('빈 스택이면 null', () => {
    expect(topOf([], isAlive)).toBe(null);
    expect(hasLive([], isAlive)).toBe(false);
  });
});

describe('removeHandle', () => {
  it('핸들을 빼고 뺀 자리를 알려준다', () => {
    const a = layer('a');
    const b = layer('b');
    const { stack, removedIndex } = removeHandle([a, b], a);
    expect(stack).toEqual([b]);
    expect(removedIndex).toBe(0);
  });

  it('스택에 없는 핸들이면 아무것도 바꾸지 않는다', () => {
    const stack = [layer('a')];
    const res = removeHandle(stack, layer('other'));
    expect(res.stack).toBe(stack);
    expect(res.removedIndex).toBe(-1);
  });

  it('같은 핸들을 두 번 빼도 아래가 안 밀린다', () => {
    const a = layer('a');
    const b = layer('b');
    const first = removeHandle([a, b], b);
    const second = removeHandle(first.stack, b);
    expect(second.stack.map((h) => h.id)).toEqual(['a']);
    expect(second.removedIndex).toBe(-1);
  });

  it('중간 레이어를 빼도 순서가 유지된다', () => {
    const [a, b, c] = [layer('a'), layer('b'), layer('c')];
    const { stack } = removeHandle([a, b, c], b);
    expect(stack.map((h) => h.id)).toEqual(['a', 'c']);
  });
});

describe('wasTop — 포커스를 되돌릴지 판단', () => {
  it('최상단을 뺐으면 되돌린다', () => {
    // [a, b]에서 b(index 1)를 빼면 남은 길이 1 → 최상단이었다.
    expect(wasTop(1, 1)).toBe(true);
  });

  it('아래쪽을 뺐으면 되돌리지 않는다 — 위 레이어의 초점을 빼앗으면 안 된다', () => {
    // [a, b]에서 a(index 0)를 빼면 남은 길이 1 → 최상단이 아니었다.
    expect(wasTop(0, 1)).toBe(false);
  });
});
