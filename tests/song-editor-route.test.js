import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

describe('shared song metadata editor route', () => {
  it('routes every song edit entry through the shared editor', () => {
    const contextMenu = read('src/js/ui/components.js');
    const inspector = read('src/js/ui/library-panels.js');
    const dock = read('src/js/events/controls/playback.js');

    for (const source of [contextMenu, inspector, dock]) {
      expect(source).toContain('openSongEditor');
      expect(source).not.toContain("import('./modals.js');\n        openEditModal");
    }
  });

  it('keeps metadata persistence in the full editor save handler', () => {
    const inspector = read('src/js/ui/library-panels.js');
    const modalEvents = read('src/js/events/modals.js');
    const libraryService = read('src/ipc/services/library.ts');

    expect(inspector).not.toContain("invoke('update_song_metadata'");
    expect(modalEvents).toContain('libraryService.update(updated)');
    expect(modalEvents).not.toContain("invoke('update_song_metadata'");
    expect(libraryService).toContain('commands.updateSongMetadata(song)');
    expect(modalEvents).toContain('refreshLibraryPanels()');
  });

  it('opens autofill results as an unsaved draft in the same editor', () => {
    const inspector = read('src/js/ui/library-panels.js');
    expect(inspector).toContain('openSongEditor(song, idx, { draft })');
    expect(inspector).toContain('확인한 뒤 저장해 주세요');
  });
});
