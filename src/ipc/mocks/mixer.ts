import type { MixState } from '../../generated/ipc.js';

const state: MixState = {
  vocalFader: 100, backingFader: 100, instFader: 100,
  vocalMuted: false, backingMuted: false, instMuted: false,
  vocalSolo: false, backingSolo: false, instSolo: false,
  monRouteVocal: true, monRouteBacking: true, monRouteInst: true, monRouteMetro: true,
  mrRouteVocal: false, mrRouteBacking: false, mrRouteInst: true, mrRouteMetro: false,
  metroEnabled: false, metroBpm: 120, metroGain: 80, mrDevice: '',
  monDelayMs: 0, monEstLatencyMs: 0, mrDelayMs: 0, mrEstLatencyMs: 0,
  limiterEnabled: true, vocalBalance: 50, vocalEnabled: true,
  masterVolume: 100, pitch: 0, tempo: 1, backingAvailable: true,
};

const routeKey = (channel: string, source: string) => {
  const prefix = channel === 'monitor' ? 'mon' : channel;
  return `${prefix}Route${source[0].toUpperCase()}${source.slice(1)}` as keyof MixState;
};

export const mixerMock = {
  async getState(): Promise<MixState> { return { ...state }; },
  async setTrackFader(track: string, percent: number) { state[`${track === 'lead' ? 'vocal' : track}Fader` as keyof MixState] = percent as never; },
  async setTrackMute(track: string, muted: boolean) { state[`${track === 'lead' ? 'vocal' : track}Muted` as keyof MixState] = muted as never; },
  async setTrackSolo(track: string, soloed: boolean) { state[`${track === 'lead' ? 'vocal' : track}Solo` as keyof MixState] = soloed as never; },
  async setRoute(channel: string, source: string, enabled: boolean) { state[routeKey(channel, source)] = enabled as never; },
  async setMetronome(enabled: boolean, bpm: number, gain: number) { state.metroEnabled = enabled; state.metroBpm = bpm; state.metroGain = gain; },
  async setBusDelay(bus: string, delayMs: number) { if (bus === 'monitor') state.monDelayMs = delayMs; else state.mrDelayMs = delayMs; },
  async setLimiter(enabled: boolean) { state.limiterEnabled = enabled; },
};
