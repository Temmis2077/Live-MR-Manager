import { commands, events, type AppState, type PlaybackProgress, type PlaybackStatus } from '../../generated/ipc.js';
import { IpcError } from '../errors.js';
import { isTauriRuntime } from '../transport.js';
import { playbackMock } from '../mocks/playback.js';

type Unlisten = () => void;

export interface PlaybackService {
  play(path: string, durationMs?: number, playNow?: boolean): Promise<number>;
  toggle(): Promise<boolean>;
  stop(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  getState(): Promise<AppState>;
  onProgress(listener: (payload: PlaybackProgress) => void): Promise<Unlisten>;
  onStatus(listener: (payload: PlaybackStatus) => void): Promise<Unlisten>;
}

function unwrap<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: unknown }, code: string): T {
  if (result.status === 'error') throw new IpcError(result.error, code);
  return result.data;
}

export function createPlaybackService(runtime = isTauriRuntime()): PlaybackService {
  if (!runtime) return playbackMock;
  return {
    async play(path, durationMs = 0, playNow = true) {
      return unwrap(await commands.playTrack(path, Math.floor(durationMs), playNow), 'audio.playback.load_failed');
    },
    async toggle() { return unwrap(await commands.togglePlayback(), 'audio.playback.toggle_failed'); },
    async stop() { unwrap(await commands.stopPlayback(), 'audio.playback.stop_failed'); },
    async seek(positionMs) {
      unwrap(await commands.seekTo(Math.max(0, Math.floor(positionMs))), 'audio.playback.seek_failed');
    },
    async getState() { return unwrap(await commands.getPlaybackState(), 'audio.playback.state_failed'); },
    onProgress(listener) { return events.playbackProgress.listen((event) => listener(event.payload)); },
    onStatus(listener) { return events.playbackStatus.listen((event) => listener(event.payload)); },
  };
}

export const playbackService = createPlaybackService();
