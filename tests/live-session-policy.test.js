import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (relativePath) => readFileSync(
  fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
  'utf8',
);

describe('라이브 MR 세션 정책', () => {
  it('대기열은 저장소에서 복원하거나 저장하지 않는다', () => {
    const stateSource = source('src/js/state.js');
    const liveSource = source('src/js/live-screen.js');

    expect(stateSource).toMatch(/liveQueue:\s*\[\]/);
    expect(`${stateSource}\n${liveSource}`).not.toMatch(
      /localStorage\.(?:getItem|setItem)\(["']liveQueue["']/,
    );
  });

  it('곡 종료 이벤트는 다음 대기곡을 자동 실행하지 않는다', () => {
    const backendSource = source('src/js/events/backend.js');
    expect(backendSource).not.toContain('playNextFromLiveQueue');
    expect(backendSource).toContain('await playTrack(state.currentTrack.path, state.trackDurationMs, false)');
  });

  it('이전 곡 이력을 제공하지 않고 현재 곡 처음부터로 안내한다', () => {
    const liveSource = source('src/js/live-screen.js');
    const htmlSource = source('src/index.html');
    expect(liveSource).not.toContain('playPreviousLiveTrack');
    expect(liveSource).not.toContain('livePlaybackHistory');
    expect(htmlSource).toContain('title="현재 곡 처음부터"');
  });
});
