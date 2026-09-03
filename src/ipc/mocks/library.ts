import type { Category, Genre, SongMetadata } from '../../generated/ipc.js';

let songs: SongMetadata[] = [];
const genres: Genre[] = [];
const categories: Category[] = [];

export const libraryMock = {
  async load(): Promise<SongMetadata[]> { return songs.map((song) => ({ ...song })); },
  async save(next: SongMetadata[]): Promise<void> { songs = next.map((song) => ({ ...song })); },
  async update(song: SongMetadata): Promise<void> {
    const index = songs.findIndex((candidate) => candidate.path === song.path);
    if (index >= 0) songs[index] = { ...song };
    else songs.push({ ...song });
  },
  async delete(path: string): Promise<void> { songs = songs.filter((song) => song.path !== path); },
  async getGenres(): Promise<Genre[]> { return genres.map((genre) => ({ ...genre })); },
  async getCategories(): Promise<Category[]> { return categories.map((category) => ({ ...category })); },
  async pruneUnusedTaxonomy(): Promise<[number, number]> { return [0, 0]; },
};
