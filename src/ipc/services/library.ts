import { commands, type Category, type Genre, type SongMetadata } from '../../generated/ipc.js';
import { IpcError } from '../errors.js';
import { isTauriRuntime } from '../transport.js';
import { libraryMock } from '../mocks/library.js';

function unwrap<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: unknown }, code: string): T {
  if (result.status === 'error') throw new IpcError(result.error, code);
  return result.data;
}

export function createLibraryService(runtime = isTauriRuntime()) {
  if (!runtime) return libraryMock;
  return {
    async load(): Promise<SongMetadata[]> { return unwrap(await commands.loadLibrary(), 'library.load_failed'); },
    async save(songs: SongMetadata[]): Promise<void> { unwrap(await commands.saveLibrary(songs), 'library.save_failed'); },
    async update(song: SongMetadata): Promise<void> { unwrap(await commands.updateSongMetadata(song), 'library.song.update_failed'); },
    async delete(path: string): Promise<void> { unwrap(await commands.deleteSong(path), 'library.song.delete_failed'); },
    async getGenres(): Promise<Genre[]> { return unwrap(await commands.getGenres(), 'library.genres.load_failed'); },
    async getCategories(): Promise<Category[]> { return unwrap(await commands.getCategories(), 'library.categories.load_failed'); },
    async pruneUnusedTaxonomy(): Promise<[number, number]> { return unwrap(await commands.pruneUnusedTaxonomy(), 'library.taxonomy.prune_failed'); },
  };
}

export const libraryService = createLibraryService();
