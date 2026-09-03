import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushEntry, rememberScroll, back, forward, canGoBack, canGoForward,
  current, reset, snapshot, MAX_ENTRIES,
} from '../src/js/nav-history.js';

describe('nav-history', () => {
  beforeEach(() => reset());

  it('시작할 때는 갈 곳이 없다', () => {
    expect(canGoBack()).toBe(false);
    expect(canGoForward()).toBe(false);
    expect(current()).toBe(null);
    expect(back()).toBe(null);
    expect(forward()).toBe(null);
  });

  it('한 번만 쌓았으면 뒤로 갈 수 없다', () => {
    pushEntry('library');
    expect(current().view).toBe('library');
    expect(canGoBack()).toBe(false);
  });

  it('뒤로/앞으로 이동한다', () => {
    pushEntry('library');
    pushEntry('alignment');

    expect(canGoBack()).toBe(true);
    expect(back().view).toBe('library');
    expect(canGoBack()).toBe(false);
    expect(canGoForward()).toBe(true);
    expect(forward().view).toBe('alignment');
    expect(canGoForward()).toBe(false);
  });

  it('같은 화면을 연속으로 밀면 무시한다', () => {
    pushEntry('library');
    pushEntry('library');
    expect(snapshot().entries).toHaveLength(1);
    expect(canGoBack()).toBe(false);
  });

  it('뒤로 간 뒤 새 화면으로 가면 앞 기록은 버려진다', () => {
    pushEntry('library');
    pushEntry('alignment');
    pushEntry('settings');
    back();
    back(); // library

    pushEntry('live');
    expect(canGoForward()).toBe(false);
    expect(snapshot().entries.map((e) => e.view)).toEqual(['library', 'live']);
  });

  it('화면마다 스크롤 위치를 따로 기억한다', () => {
    pushEntry('library');
    rememberScroll(840);
    pushEntry('alignment');
    rememberScroll(120);

    expect(back().scroll).toBe(840);
    expect(forward().scroll).toBe(120);
  });

  it('스크롤 값이 숫자가 아니거나 음수면 0으로 둔다', () => {
    pushEntry('library');
    rememberScroll(undefined);
    expect(current().scroll).toBe(0);
    rememberScroll(-30);
    expect(current().scroll).toBe(0);
  });

  it('상한을 넘으면 오래된 기록부터 버린다', () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i += 1) pushEntry(`view-${i}`);

    const { entries } = snapshot();
    expect(entries).toHaveLength(MAX_ENTRIES);
    // 가장 오래된 10개가 밀려나고 최근 것만 남는다.
    expect(entries[0].view).toBe('view-10');
    expect(current().view).toBe(`view-${MAX_ENTRIES + 9}`);
  });

  it('빈 화면 이름은 쌓지 않는다', () => {
    pushEntry('library');
    pushEntry('');
    pushEntry(null);
    expect(snapshot().entries).toHaveLength(1);
  });
});
