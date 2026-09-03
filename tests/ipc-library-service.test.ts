import { describe, expect, it } from 'vitest';
import type { SongMetadata } from '../src/generated/ipc.js';
import { createLibraryService } from '../src/ipc/services/library.js';

function song(path: string, title: string): SongMetadata {
  return {
    id: null, title, thumbnail: '', duration: '3:00', source: 'local', path,
    pitch: null, tempo: null, volume: null, artist: null, tags: null, genre: null,
    categories: null, playCount: null, dateAdded: null, isMr: null, isSeparated: null,
    hasLyrics: null, originalTitle: null, translatedTitle: null, curationCategory: null,
    bpm: null, difficulty: null, proficiency: null, karaokeUrl: null, coverUrl: null,
    originalUrl: null, lyricsLink: null, melomingSongId: null, melomingChannelId: null,
    melomingArtistId: null, melomingCategoryIds: null, syncStatus: null,
  };
}

describe('library IPC domain service', () => {
  it('keeps save, update, and delete consistent in browser preview', async () => {
    const service = createLibraryService(false);
    await service.save([song('a.wav', 'A')]);
    await service.update(song('a.wav', 'A edited'));
    expect(await service.load()).toMatchObject([{ path: 'a.wav', title: 'A edited' }]);
    await service.delete('a.wav');
    expect(await service.load()).toEqual([]);
  });

  it('returns stable taxonomy shapes in browser preview', async () => {
    const service = createLibraryService(false);
    expect(await service.getGenres()).toEqual([]);
    expect(await service.getCategories()).toEqual([]);
    expect(await service.pruneUnusedTaxonomy()).toEqual([0, 0]);
  });
});
