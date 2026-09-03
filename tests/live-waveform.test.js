import { describe, expect, it, vi } from 'vitest';
import { createWaveformRepository, isCurrentWaveformRequest } from '../src/js/live-waveform.js';

describe('live waveform repository', () => {
  it('shares an in-flight request and then serves the cache', async () => {
    let resolve;
    const backend = vi.fn(() => new Promise((done) => { resolve = done; }));
    const repo = createWaveformRepository(backend);
    const first = repo.load('a.wav');
    const second = repo.load('a.wav');
    await Promise.resolve();
    expect(backend).toHaveBeenCalledTimes(1);
    resolve({ points: [[0, 1]], duration_sec: 1 });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await repo.load('a.wav');
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('accepts results only for the exact current sequence and path', () => {
    expect(isCurrentWaveformRequest(2, 2, 'b.wav', 'b.wav')).toBe(true);
    expect(isCurrentWaveformRequest(1, 2, 'a.wav', 'b.wav')).toBe(false);
    expect(isCurrentWaveformRequest(2, 2, 'a.wav', 'b.wav')).toBe(false);
  });

  it('prefetch failure stays isolated from the live UI', async () => {
    const repo = createWaveformRepository(() => Promise.reject(new Error('decode failed')));
    await expect(repo.prefetch('bad.wav')).resolves.toBeNull();
  });
});
