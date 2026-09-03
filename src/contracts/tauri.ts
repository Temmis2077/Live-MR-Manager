/**
 * Frontend-owned domain types.
 *
 * Rust command, event, DTO, and error types are generated in
 * `src/generated/ipc.ts`; do not duplicate them here.
 */
export type AppMode = 'live' | 'practice';
export type OutputBus = 'monitor' | 'capture';
export type TrackId = 'vocal' | 'lead' | 'backing' | 'inst';

export interface PlaybackProgressView {
  positionMs: number;
  durationMs: number;
}
