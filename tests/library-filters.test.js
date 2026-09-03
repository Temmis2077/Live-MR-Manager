import { describe, expect, it } from 'vitest';
import { filterSongLibrary, getLyricSyncStatus, getSongReadiness } from '../src/js/library-filters.js';

const sampleSongs = [
  { title: 'Alpha', artist: 'A', source: 'youtube', genre: 'POP', dateAdded: 2, playCount: 1, path: 'a', lyricSyncStatus: 'synced' },
  { title: 'Beta', artist: 'B', source: 'local', genre: 'Ballad', dateAdded: 1, playCount: 5, path: 'b', lyricSyncStatus: 'unsynced' },
  { title: 'Gamma', artist: 'C', source: 'meloming', melomingSongId: 9, genre: 'POP', dateAdded: 3, playCount: 2, path: 'c', lyricSyncStatus: 'none' },
];

describe('filterSongLibrary', () => {
  it('filters by tab', () => {
    const youtubeOnly = filterSongLibrary(sampleSongs, { currentTab: 'youtube' });
    expect(youtubeOnly).toHaveLength(1);
    expect(youtubeOnly[0].title).toBe('Alpha');
  });

  it('filters by search query', () => {
    const result = filterSongLibrary(sampleSongs, { query: 'beta' });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Beta');
  });

  it('sorts by play count', () => {
    const result = filterSongLibrary(sampleSongs, { sortBy: 'plays' });
    expect(result[0].title).toBe('Beta');
  });

  it('filters by lyric sync status', () => {
    expect(filterSongLibrary(sampleSongs, { syncFilter: 'synced' }).map(s => s.title)).toEqual(['Alpha']);
    expect(filterSongLibrary(sampleSongs, { syncFilter: 'unsynced' }).map(s => s.title)).toEqual(['Beta']);
    expect(filterSongLibrary(sampleSongs, { syncFilter: 'none' }).map(s => s.title)).toEqual(['Gamma']);
    expect(filterSongLibrary(sampleSongs, { syncFilter: 'all' })).toHaveLength(3);
  });
});

describe('library readiness', () => {
  const readySong = { path: 'ready', title: '곡', artist: '가수', isSeparated: true, lyricSyncStatus: 'synced' };

  it('derives readiness and the next required action without stored fields', () => {
    expect(getSongReadiness(readySong)).toMatchObject({ status: 'ready', completed: 3, nextAction: 'play' });
    expect(getSongReadiness({ ...readySong, isSeparated: false })).toMatchObject({ status: 'needs-work', nextAction: 'separate' });
    expect(getSongReadiness({ ...readySong, lyricSyncStatus: 'none' })).toMatchObject({ nextAction: 'fetch-lyrics' });
    expect(getSongReadiness({ ...readySong, artist: '' })).toMatchObject({ nextAction: 'edit-info', missingInfo: ['가수'] });
  });

  it('prioritizes processing and error task states', () => {
    expect(getSongReadiness(readySong, { activeTasks: { ready: { status: 'Running' } } })).toMatchObject({ status: 'processing' });
    expect(getSongReadiness(readySong, { activeTasks: { ready: { status: 'Error' } } })).toMatchObject({ status: 'error' });
  });

  it('filters and sorts by readiness', () => {
    const songs = [readySong, { ...readySong, path: 'missing', isSeparated: false }];
    expect(filterSongLibrary(songs, { readinessFilter: 'mr-missing' }).map((s) => s.path)).toEqual(['missing']);
    expect(filterSongLibrary(songs, { sortBy: 'workNeeded' }).map((s) => s.path)).toEqual(['missing', 'ready']);
  });
});

describe('getLyricSyncStatus', () => {
  it('prefers explicit status field', () => {
    expect(getLyricSyncStatus({ lyricSyncStatus: 'synced' })).toBe('synced');
    expect(getLyricSyncStatus({ lyric_sync_status: 'unsynced' })).toBe('unsynced');
  });
  it('falls back to hasLyrics when status is absent', () => {
    expect(getLyricSyncStatus({ hasLyrics: true })).toBe('unsynced');
    expect(getLyricSyncStatus({ hasLyrics: false })).toBe('none');
    expect(getLyricSyncStatus(null)).toBe('none');
  });
});
