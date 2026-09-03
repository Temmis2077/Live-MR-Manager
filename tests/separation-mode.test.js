import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
describe('advanced harmony separation model routing', () => {
  it('keeps karaoke models out of the first-pass selector', async () => {
    globalThis.window = {};
    const { partitionSeparationModels } = await import('../src/js/separation-mode-modal.js');
    const models = [
      { id: 'kim', isCustom: false },
      { id: 'custom_vocal', isCustom: true, presetKey: 'melband_roformer' },
      { id: 'custom_harmony', isCustom: true, presetKey: 'melband_roformer_karaoke' },
    ];
    const split = partitionSeparationModels(models);
    expect(split.baseModels.map((m) => m.id)).toEqual(['custom_vocal']);
    expect(split.harmonyModels.map((m) => m.id)).toEqual(['custom_harmony']);
  });

  it('does not treat the advanced selector panel as an immediate model button', async () => {
    globalThis.window = {};
    const { immediateSeparationModelId } = await import('../src/js/separation-mode-modal.js');
    expect(immediateSeparationModelId({ dataset: {} })).toBeNull();
    expect(immediateSeparationModelId({ dataset: { modelId: 'kim' } })).toBe('kim');
  });

  it('routes library inspector and batch requests through the model picker', () => {
    const inspector = readFileSync('src/js/ui/library-panels.js', 'utf8');
    const libraryControls = readFileSync('src/js/events/controls/library.js', 'utf8');
    expect(inspector).toContain('openSeparationModeModal(song)');
    expect(inspector).not.toContain('startMrSeparation(song.path, null)');
    expect(libraryControls).toContain('openSeparationModeModal(songs[0]');
    expect(libraryControls).toContain('startMrSeparation(song.path, modelId, harmonyModelId)');
    expect(libraryControls).not.toContain('startMrSeparation(p, null)');
  });

  it('offers harmony separation while adding songs and forwards the selected model', () => {
    const addSong = readFileSync('src/js/ui/add-song-modal.js', 'utf8');
    expect(addSong).toContain('id="addsong-harmony-check"');
    expect(addSong).toContain('id="addsong-harmony-model"');
    expect(addSong).toContain('partitionSeparationModels(allModels)');
    expect(addSong).toContain('startMrSeparation(m.path, modelId, harmonyModelId, {');
    expect(addSong).toContain('alignAfterSeparation: alignThisSong');
  });

  it('registers post-separation alignment before invoking the shared backend path', () => {
    const audio = readFileSync('src/js/audio.js', 'utf8');
    const deferAt = audio.indexOf('deferAlignmentUntilSeparated(path)');
    const invokeAt = audio.indexOf('invoke("start_mr_separation"');
    expect(deferAt).toBeGreaterThan(-1);
    expect(invokeAt).toBeGreaterThan(deferAt);
  });

  it('refreshes the open lyric editor from the unified separation completion event', () => {
    const backend = readFileSync('src/js/events/backend.js', 'utf8');
    const viewer = readFileSync('src/js/alignment-viewer.js', 'utf8');
    expect(backend).toContain("CustomEvent('separation-stems-changed'");
    expect(viewer).toContain("window.addEventListener('separation-stems-changed'");
    expect(viewer).toContain('refreshCurrentStemAnalysis()');
  });

  it('does not silently start a default model when the picker UI is missing', () => {
    const modal = readFileSync('src/js/separation-mode-modal.js', 'utf8');
    expect(modal).toContain('모델 선택창을 열 수 없어 MR 분리를 시작하지 않았습니다.');
    expect(modal).not.toContain("startMrSeparation(song.path));\n        showNotification('분리 방식 선택 UI");
  });
});
