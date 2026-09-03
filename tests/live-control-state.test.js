import { describe, expect, it, vi } from 'vitest';
import { createLiveControlChannel } from '../src/js/live-control-state.js';

describe('live control channel', () => {
  it('updates immediately and confirms the latest value', async () => {
    const shown = [];
    const channel = createLiveControlChannel({ initialValue: 0, apply: vi.fn(), onOptimistic: v => shown.push(v) });
    await channel.set(5);
    expect(shown).toEqual([5]);
    expect(channel.state).toMatchObject({ confirmedValue: 5, pendingValue: null, error: null });
  });

  it('ignores an older response that finishes after the latest request', async () => {
    const resolvers = [];
    const channel = createLiveControlChannel({
      initialValue: 0,
      apply: value => new Promise(resolve => resolvers.push({ value, resolve })),
    });
    const first = channel.set(10);
    const second = channel.set(20);
    resolvers.find(x => x.value === 20).resolve();
    await second;
    resolvers.find(x => x.value === 10).resolve();
    await first;
    expect(channel.state.confirmedValue).toBe(20);
  });

  it('rolls back only the newest failed request', async () => {
    const rolledBack = [];
    const channel = createLiveControlChannel({
      initialValue: 50,
      apply: async () => { throw new Error('device lost'); },
      onRollback: value => rolledBack.push(value),
    });
    await channel.set(80);
    expect(rolledBack).toEqual([50]);
    expect(channel.value).toBe(50);
    expect(channel.state.error).toBeInstanceOf(Error);
  });

  it('coalesces drag input and flushes the final value', async () => {
    vi.useFakeTimers();
    const applied = [];
    const channel = createLiveControlChannel({ initialValue: 0, delayMs: 50, apply: async v => applied.push(v) });
    channel.set(10);
    channel.set(30);
    channel.set(70);
    await channel.flush();
    expect(applied).toEqual([70]);
    expect(channel.state.confirmedValue).toBe(70);
    vi.useRealTimers();
  });
});
