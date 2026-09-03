import { commands, type MixState } from '../../generated/ipc.js';
import { IpcError } from '../errors.js';
import { isTauriRuntime } from '../transport.js';
import { mixerMock } from '../mocks/mixer.js';

function unwrap<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: unknown }, code: string): T {
  if (result.status === 'error') throw new IpcError(result.error, code);
  return result.data;
}

export function createMixerService(runtime = isTauriRuntime()) {
  if (!runtime) return mixerMock;
  return {
    async getState(): Promise<MixState> { return unwrap(await commands.getMixState(), 'audio.mix.state_failed'); },
    async setTrackFader(track: string, percent: number) { unwrap(await commands.setTrackFader(track, percent), 'audio.mix.fader_failed'); },
    async setTrackMute(track: string, muted: boolean) { unwrap(await commands.setTrackMute(track, muted), 'audio.mix.mute_failed'); },
    async setTrackSolo(track: string, soloed: boolean) { unwrap(await commands.setTrackSolo(track, soloed), 'audio.mix.solo_failed'); },
    async setRoute(channel: string, source: string, enabled: boolean) { unwrap(await commands.setChannelRoute(channel, source, enabled), 'audio.route.update_failed'); },
    async setMetronome(enabled: boolean, bpm: number, gain: number) { unwrap(await commands.setMetronome(enabled, bpm, gain), 'audio.metronome.update_failed'); },
    async setBusDelay(bus: string, delayMs: number) { unwrap(await commands.setBusDelay(bus, delayMs), 'audio.bus.delay_failed'); },
    async setLimiter(enabled: boolean) { unwrap(await commands.setLimiter(enabled), 'audio.limiter.update_failed'); },
  };
}

export const mixerService = createMixerService();
