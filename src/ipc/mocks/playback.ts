import type { AppState, PlaybackProgress, PlaybackStatus } from '../../generated/ipc.js';

const state: AppState = {
  currentTrack: null, pitch: 0, tempo: 1, volume: 100, vocalBalance: 50,
  vocalEnabled: true, lyricEnabled: true, isPlaying: false,
  vocalFader: 100, backingFader: 100, instFader: 100,
  vocalMuted: false, backingMuted: false, instMuted: false,
  vocalSolo: false, backingSolo: false, instSolo: false,
  monRouteVocal: true, monRouteBacking: true, monRouteInst: true, monRouteMetro: true,
  mrRouteVocal: false, mrRouteBacking: false, mrRouteInst: true, mrRouteMetro: false,
  metroEnabled: false, metroBpm: 0, metroGain: 50,
};

export const playbackMock = {
  async play(path: string, _durationMs = 0, playNow = true): Promise<number> {
    state.currentTrack = path;
    state.isPlaying = playNow;
    return 0;
  },
  async toggle(): Promise<boolean> {
    state.isPlaying = !state.isPlaying;
    return state.isPlaying;
  },
  async stop(): Promise<void> {
    state.currentTrack = null;
    state.isPlaying = false;
  },
  async seek(_positionMs: number): Promise<void> {},
  async getState(): Promise<AppState> { return { ...state }; },
  async onProgress(_listener: (payload: PlaybackProgress) => void): Promise<() => void> { return () => {}; },
  async onStatus(_listener: (payload: PlaybackStatus) => void): Promise<() => void> { return () => {}; },
};
