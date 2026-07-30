/**
 * js/ui/library.js - Library Grid and Song Cards
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { invoke } from '../tauri-bridge.js';
import { getThumbnailUrl } from '../utils.js';
import { filterSongLibrary, getSongCategoryFromMetadata, isMelomingLinkedSong, getLyricSyncStatus } from '../library-filters.js';
import { updateCardStatusBadge, updateThumbnailOverlay, showSongContextMenu } from './components.js';

export function updateLibraryCount(count) {
  const countEl = document.getElementById("library-count");
  if (countEl) countEl.textContent = count;
}

/** User-edited categories take priority over auto curation metadata. */
export function getSongCategory(song) {
  return getSongCategoryFromMetadata(song);
}

/** Meloming pull/push로 연동된 곡인지 판별 */
export { isMelomingLinkedSong };

/** 추가일 표기 — 표에서 열 폭을 넘기지 않게 MM.DD로 짧게. */
function formatAddedDate(ts) {
  if (!ts) return '-';
  // 백엔드는 초 단위로 줄 수도 있어(10자리) ms로 보정한다.
  const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}.${dd}`;
}

/** 곡이 MR 분리를 마쳤는지 — 백엔드 필드가 여러 이름으로 올 수 있어 모두 본다. */
function isSeparated(song) {
  return !!(song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path);
}

/**
 * 스템 상태 칸 — 시안은 8스템(악기별)이지만 현재 앱의 분리는 보컬/반주 2스템이라
 * 실제 있는 만큼만 보여준다. 없는 스템을 채워 있는 척하지 않는다.
 * 색만으로 구분하지 않도록 각 칸에 글자(보/반)와 "n/2" 텍스트를 함께 둔다.
 */
function stemCellHtml(song) {
  const done = isSeparated(song);
  const task = (state.activeTasks || {})[song.path];
  const running = !!(task && task.status !== 'Finished');
  const cls = done ? 'done' : (running ? 'running' : 'none');
  const dots = [
    { ch: '보', label: '보컬' },
    { ch: '반', label: '반주(MR)' },
  ].map((s) => `<span class="stem-dot ${cls}" title="${s.label} 스템 ${done ? '있음' : (running ? '분리 중' : '없음')}">${s.ch}</span>`).join('');
  return `${dots}<span class="stem-count">${done ? '2/2' : (running ? '분리 중' : '0/2')}</span>`;
}

/** 표 모드 헤더 — 열 라벨. 정렬 가능한 열은 클릭으로 정렬을 바꾼다.
 *  그리드 **안쪽** 첫 요소로 넣는다 — 그리드의 좌우 패딩을 그대로 받아
 *  헤더와 행의 열 폭이 자동으로 일치한다(밖에 두면 패딩만큼 어긋난다). */
export function renderListHeader() {
  const grid = elements.songGrid;
  if (!grid) return;

  const header = document.createElement('div');
  header.id = 'library-list-header';
  header.className = 'library-list-header';
  header.innerHTML = `
    <div class="col col-info" data-sort="title" role="button" tabindex="0" title="제목순으로 정렬">곡 · 가수</div>
    <div class="col col-stems">스템 상태</div>
    <div class="col col-lyrics">가사</div>
    <div class="col col-duration">길이</div>
    <div class="col col-keybpm">키 / BPM</div>
    <div class="col col-added" data-sort="dateNew" role="button" tabindex="0" title="추가일순으로 정렬">추가일</div>
    <div class="col col-status">상태</div>
    <div class="col col-more"></div>
  `;
  grid.appendChild(header);

  // 헤더 클릭 정렬 — 기존 정렬 드롭다운(lib-sort-select)을 그대로 움직여
  // 정렬 로직·표시가 한 곳에서만 관리되게 한다.
  header.querySelectorAll('[data-sort]').forEach((el) => {
    const apply = () => {
      const sel = document.getElementById('lib-sort-select');
      if (!sel) return;
      sel.value = el.dataset.sort;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      renderLibrary();
    };
    el.addEventListener('click', apply);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
    });
  });
}

export function getFilteredSongs() {
  const filtered = filterSongLibrary(state.songLibrary, {
    query: elements.libSearchInput?.value || "",
    genreFilter: elements.libGenreFilter?.value || "all",
    categoryFilter: elements.libCategoryFilter?.value || "all",
    syncFilter: document.getElementById("lib-sync-filter")?.value || "all",
    sortBy: elements.libSortSelect?.value || "dateNew",
    currentTab: state.activeView || "library",
  });
  state.filteredTracks = filtered;
  return filtered;
}

export function renderLibrary() {
  if (!elements.songGrid) return;

  const filtered = getFilteredSongs();
  updateLibraryCount(filtered.length);

  // 좌측 보관함/태그 개수만 갱신한다 — 인스펙터는 여기서 다시 그리지 않는다
  // (재렌더가 잦아서, 사용자가 입력 중인 값이 날아가면 안 된다).
  import('./library-panels.js').then((m) => m.renderCollections()).catch(() => {});

  elements.songGrid.innerHTML = "";

  if (filtered.length === 0) {
    const emptyMessage = (state.activeView === "meloming")
      ? "멜로밍 연동 곡이 없습니다. 설정에서 노래책을 가져오거나 보내 보세요."
      : "검색 결과가 없습니다.";
    elements.songGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">
        ${emptyMessage}
      </div>`;
    return;
  }

  const count = filtered.length;
  invoke('remote_js_log', { msg: `[Library] Rendering ${count} cards.` }).catch(() => {});

  // 표 모드에서는 곡 행 앞에 열 헤더를 먼저 넣는다(곡이 있을 때만).
  renderListHeader();

  filtered.forEach(song => {
    addSongCard(song, song.originalIndex);
  });

  updateThumbnailOverlay();
}

export function addSongCard(song, index) {
  const card = document.createElement("article");
  // 보기 모드는 표 하나뿐이다 — 그리드·버튼 모드는 없앴다.
  card.className = 'song-card list-row';
  card.dataset.path = song.path;
  card.dataset.index = index;

  const thumbUrl = getThumbnailUrl(song.thumbnail, song);

  card.innerHTML = `
    <div class="thumbnail">
      <img src="${thumbUrl}" alt="${song.title}" style="width:100%; height:100%; object-fit:cover;">
      <div class="thumb-overlay">
        <svg class="icon-loading" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="3">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.2"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        <svg class="icon-play" viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <svg class="icon-pause" viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
          <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
        </svg>
      </div>
    </div>
    
    ${(() => {
      // 표 한 가지뿐 — 열 구성은 renderListHeader()의 헤더와 CSS 그리드를 공유한다.
      // 상태는 썸네일 위 배지가 아니라 각자의 열에서 보여준다.
      const sync = getLyricSyncStatus(song);
      const syncLabel = sync === 'synced' ? '싱크 완료' : (sync === 'unsynced' ? '가사만' : '없음');
      return `
        <div class="col col-info">
          <div class="song-name" title="${song.title || ''}">${song.title || '제목 정보 없음'}</div>
          <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}${song.genre ? ` · ${song.genre}` : ''}</div>
        </div>
        <div class="col col-stems">${stemCellHtml(song)}</div>
        <div class="col col-lyrics"><span class="lyric-cell ${sync}">${syncLabel}</span></div>
        <div class="col col-duration"><span class="duration-text">${song.duration || '--:--'}</span></div>
        <div class="col col-keybpm">${song.songKey || song.song_key || '-'} / ${song.bpm || '-'}</div>
        <div class="col col-added">${formatAddedDate(song.dateAdded ?? song.date_added)}</div>
        <div class="col col-status"><div class="status-badge-wrapper"></div></div>
        <div class="col col-more" title="더보기">⋯</div>
      `;
    })()}
  `;

  // Unified Status Badge (MR / 분리중 / 대기중)
  updateCardStatusBadge(song.path, card);

  // 선택 모드 체크박스 (3개 뷰 모드 공통 — CSS가 [data-selection-mode]로 게이팅).
  // 실제 <input> 대신 표시 전용 마커를 쓰고 클릭은 카드 전체가 받는다.
  const selectMarker = document.createElement('div');
  selectMarker.className = 'song-select-marker';
  if (state.selectedSongPaths && state.selectedSongPaths.has(song.path)) {
    card.classList.add('selected-for-batch');
  }
  card.prepend(selectMarker);

  // Integrated click handler: Play immediately on card or thumbnail click
  const handlePlayClick = async (e) => {
    // 0. 선택 모드에서는 재생 대신 선택 토글
    if (state.librarySelectionMode) {
      e.preventDefault();
      e.stopPropagation();
      const selected = state.selectedSongPaths;
      if (selected.has(song.path)) {
        selected.delete(song.path);
        card.classList.remove('selected-for-batch');
      } else {
        selected.add(song.path);
        card.classList.add('selected-for-batch');
      }
      import('../events/controls/library.js').then((m) => {
        if (m.updateSelectionBar) m.updateSelectionBar();
      });
      return;
    }

    // 1. If any modal is active, block playback from library cards
    const activeModal = document.querySelector(".modal-overlay.active");
    if (activeModal) {
      e.stopPropagation();
      return;
    }

    // 2. If context menu is active, just close it and stop further action
    if (elements.contextMenu && (elements.contextMenu.classList.contains("active") || elements.contextMenu.style.display === 'flex')) {
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    e.preventDefault();
    const { selectTrack } = await import('../player.js');
    selectTrack(index);
  };

  card.addEventListener("click", handlePlayClick);

  // 클릭한 곡을 오른쪽 인스펙터 대상으로 — 재생과 별개로 항상 갱신한다.
  card.addEventListener("click", () => {
    import('./library-panels.js')
      .then((m) => m.setInspectedSong(song.path))
      .catch(() => {});
  });

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    invoke('remote_js_log', { msg: `[Card] contextmenu triggered for path: ${song.path}` }).catch(() => {});
    showSongContextMenu(e, song, index);
  });

  // 표 모드의 ⋯ 버튼 — 재생하지 않고 우클릭과 같은 메뉴를 연다.
  const moreBtn = card.querySelector('.col-more');
  if (moreBtn) {
    moreBtn.setAttribute('role', 'button');
    moreBtn.setAttribute('tabindex', '0');
    moreBtn.setAttribute('aria-label', `${song.title || '이 곡'} 관리 메뉴 열기`);
    const openMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSongContextMenu(e, song, index);
    };
    moreBtn.addEventListener('click', openMenu);
    moreBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') openMenu(e);
    });
  }

  elements.songGrid.appendChild(card);
}


export async function performDeleteSong(index) {
  const song = state.songLibrary[index];
  if (!song) return;

  const { deleteSongFromDb } = await import('../audio.js');
  try {
    const path = song.path;
    state.songLibrary.splice(index, 1);
    await deleteSongFromDb(path);
    return true;
  } catch (err) {
    console.error("Deletion failed:", err);
    throw err;
  }
}

export async function deleteSong(index) {
  const song = state.songLibrary[index];
  if (!song) return;
  
  const { openConfirmModal } = await import('./modals.js');
  const { showNotification } = await import('../utils.js');

  openConfirmModal("곡 삭제", `'${song.title}' 곡을 삭제하시겠습니까?`, async () => {
    try {
      await performDeleteSong(index);
      const { refreshFilterDropdowns } = await import('./core.js');
      await refreshFilterDropdowns();
      renderLibrary();
      showNotification("곡이 삭제되었습니다.", "success");
    } catch (err) {
      showNotification("곡 삭제 중 오류가 발생했습니다.", "error");
    }
  });
}
