/**
 * 곡 정보 편집기의 단일 진입점.
 *
 * 표 우클릭, 우측 인스펙터, 플레이어 메뉴가 모두 같은 곡을 같은 전체
 * 메타데이터 모달에서 편집하도록 한다. index 힌트가 오래된 경우에도 path로
 * 다시 찾아 다른 곡이 수정되는 일을 막는다.
 */
import { state } from '../state.js';
import { showNotification } from '../utils.js';

export async function openSongEditor(songOrPath, indexHint = -1, { draft = null } = {}) {
  const path = typeof songOrPath === 'string' ? songOrPath : songOrPath?.path;
  let index = Number.isInteger(indexHint) ? indexHint : -1;

  if (!path) {
    showNotification('편집할 곡을 찾을 수 없습니다.', 'error');
    return false;
  }
  if (index < 0 || state.songLibrary[index]?.path !== path) {
    index = (state.songLibrary || []).findIndex((song) => song.path === path);
  }
  if (index < 0) {
    showNotification('라이브러리에서 곡을 찾을 수 없습니다.', 'error');
    return false;
  }

  const { openEditModal } = await import('./modals.js');
  openEditModal(draft ? { ...state.songLibrary[index], ...draft, path } : state.songLibrary[index], index);
  return true;
}
