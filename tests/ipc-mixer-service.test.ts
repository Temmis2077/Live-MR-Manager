import { describe, expect, it } from 'vitest';
import { createMixerService } from '../src/ipc/services/mixer.js';

describe('mixer IPC domain service', () => {
  it('keeps fader, mute, and solo changes in browser preview state', async () => {
    const service = createMixerService(false);
    await service.setTrackFader('vocal', 72);
    await service.setTrackMute('backing', true);
    await service.setTrackSolo('inst', true);
    expect(await service.getState()).toMatchObject({ vocalFader: 72, backingMuted: true, instSolo: true });
  });

  it('keeps routing, metronome, delay, and limiter changes consistent', async () => {
    const service = createMixerService(false);
    await service.setRoute('mr', 'vocal', true);
    await service.setMetronome(true, 132, 64);
    await service.setBusDelay('monitor', 18);
    await service.setLimiter(false);
    expect(await service.getState()).toMatchObject({
      mrRouteVocal: true, metroEnabled: true, metroBpm: 132,
      metroGain: 64, monDelayMs: 18, limiterEnabled: false,
    });
  });
});
