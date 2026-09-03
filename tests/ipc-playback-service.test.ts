import { describe, expect, it } from 'vitest';
import { createPlaybackService } from '../src/ipc/services/playback.js';

describe('playback IPC domain service', () => {
  it('preserves loaded-but-paused state in browser preview', async () => {
    const service = createPlaybackService(false);
    await service.play('practice.wav', 120_000, false);
    expect(await service.getState()).toMatchObject({ currentTrack: 'practice.wav', isPlaying: false });
  });

  it('keeps transport state consistent through toggle and stop', async () => {
    const service = createPlaybackService(false);
    await service.play('live.wav', 120_000, true);
    expect(await service.toggle()).toBe(false);
    await service.stop();
    expect(await service.getState()).toMatchObject({ currentTrack: null, isPlaying: false });
  });

  it('provides disposable no-op subscriptions in browser preview', async () => {
    const service = createPlaybackService(false);
    const unlisten = await service.onProgress(() => {});
    expect(unlisten).toBeTypeOf('function');
    unlisten();
  });
});
