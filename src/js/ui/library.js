/**
 * js/ui/library.js - Library Grid and Song Cards
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { invoke } from '../tauri-bridge.js';
import { getThumbnailUrl } from '../utils.js';
import { filterSongLibrary, getSongCategoryFromMetadata, isMelomingLinkedSong, getLyricSyncStatus, getSongReadiness } from '../library-filters.js';
import { updateThumbnailOverlay, showSongContextMenu, closeContextMenu } from './components.js';

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
  // 첫 칸(52px)은 행의 썸네일 열과 같은 자리다. 표에서 선택 열이 오는 곳이라
  // '여러 곡 선택'을 여기 둔다 — 선택 모드에 들어가면 바로 아래 행들에 체크
  // 표시가 뜨므로 무엇을 고르는 버튼인지가 위치만으로 읽힌다.
  header.innerHTML = `
    <button type="button" class="col-select-toggle" id="library-select-mode"
            title="여러 곡 선택 (일괄 작업)" aria-label="여러 곡 선택" aria-pressed="false">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 11 12 14 22 4"></polyline>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
      </svg>
    </button>
    <div class="col col-info" data-sort="title" role="button" tabindex="0" title="제목순으로 정렬">곡 · 가수</div>
    <div class="col col-stems">MR</div>
    <div class="col col-lyrics">가사</div>
    <div class="col col-info-status">정보</div>
    <div class="col col-duration">길이</div>
    <div class="col col-status" data-sort="workNeeded" role="button" tabindex="0" title="작업 필요 우선으로 정렬">준비 상태</div>
    <div class="col col-more"></div>
  `;
  grid.appendChild(header);

  // 헤더는 렌더마다 새로 만들어지므로 선택 모드 중이었다면 눌림 표시를 되살린다.
  if (state.librarySelectionMode) {
    const toggle = header.querySelector('#library-select-mode');
    toggle?.classList.add('active');
    toggle?.setAttribute('aria-pressed', 'true');
  }

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
    readinessFilter: document.getElementById("lib-readiness-filter")?.value || state.libraryReadinessFilter || "all",
    readinessContext: { activeTasks: state.activeTasks, alignmentQueue: state.alignmentQueue },
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
  renderActiveLibraryFilters();

  // 좌측 보관함/태그 개수만 갱신한다 — 인스펙터는 여기서 다시 그리지 않는다
  // (재렌더가 잦아서, 사용자가 입력 중인 값이 날아가면 안 된다).
  import('./library-panels.js').then((m) => m.renderCollections()).catch(() => {});

  elements.songGrid.innerHTML = "";

  if (filtered.length === 0) {
    const libraryEmpty = (state.songLibrary || []).length === 0;

    // 라이브러리가 통째로 비었다 = 대개 첫 사용자다. 여기가 새 사용자가 반드시
    // 지나가는 유일한 지점이라, "곡 추가" 버튼 하나만 두는 대신 시작 가이드를
    // 편다(곡이 생기면 저절로 사라진다).
    if (libraryEmpty && state.activeView !== "meloming") {
      import('./onboarding-ui.js')
        .then((m) => m.renderLibraryStartGuide(elements.songGrid))
        .catch((err) => console.error('[Library] start guide failed:', err));
      return;
    }

    const emptyMessage = (state.activeView === "meloming")
      ? "멜로밍 연동 곡이 없습니다. 설정에서 노래책을 가져오거나 보내 보세요."
      : "검색 결과가 없습니다.";
    elements.songGrid.innerHTML = `
      <div class="empty-state library-empty-state">
        <strong>${emptyMessage}</strong>
        <span>검색어나 준비 상태, 왼쪽 탐색 조건을 바꿔보세요.</span>
        <div><button type="button" class="empty-action primary" data-action="add">곡 추가</button><button type="button" class="empty-action" data-action="reset">필터 초기화</button></div>
      </div>`;
    elements.songGrid.querySelector('[data-action="add"]')?.addEventListener('click', () => {
      import('./add-song-modal.js').then(({ openAddSongModal }) => openAddSongModal());
    });
    elements.songGrid.querySelector('[data-action="reset"]')?.addEventListener('click', () => resetLibraryFilters());
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

export function renderActiveLibraryFilters() {
  const bar = document.getElementById('library-active-filters');
  if (!bar) return;
  const filters = [];
  const query = elements.libSearchInput?.value?.trim();
  const category = elements.libCategoryFilter?.value;
  const genre = elements.libGenreFilter?.value;
  const readiness = document.getElementById('lib-readiness-filter')?.value || 'all';
  const readinessLabels = { 'needs-work': '작업 필요', 'mr-missing': 'MR 없음', 'lyrics-missing': '가사 없음', 'info-missing': '정보 부족', processing: '처리 중' };
  if (query) filters.push({ key: 'query', label: `검색: ${query}` });
  if (category && category !== 'all') filters.push({ key: 'category', label: `보관함: ${category === 'none' ? '미분류' : category}` });
  if (genre && genre !== 'all') filters.push({ key: 'genre', label: `장르: ${genre === 'none' ? '미분류' : genre}` });
  if (readiness !== 'all') filters.push({ key: 'readiness', label: readinessLabels[readiness] || readiness });
  if (!filters.length) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = `<span class="active-filter-label">적용 중</span>${filters.map((f) => `<button type="button" class="active-filter-chip" data-filter-key="${f.key}">${f.label} ×</button>`).join('')}<button type="button" class="active-filter-reset">모두 초기화</button>`;
  bar.querySelectorAll('[data-filter-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.filterKey;
      if (key === 'query' && elements.libSearchInput) elements.libSearchInput.value = '';
      if (key === 'category' && elements.libCategoryFilter) elements.libCategoryFilter.value = 'all';
      if (key === 'genre' && elements.libGenreFilter) elements.libGenreFilter.value = 'all';
      if (key === 'readiness') {
        document.getElementById('lib-readiness-filter').value = 'all';
        state.libraryReadinessFilter = 'all';
        document.querySelectorAll('.readiness-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.readiness === 'all'));
      }
      renderLibrary();
    });
  });
  bar.querySelector('.active-filter-reset')?.addEventListener('click', resetLibraryFilters);
}

export function addSongCard(song, index) {
  const card = document.createElement("article");
  // 보기 모드는 표 하나뿐이다 — 그리드·버튼 모드는 없앴다.
  card.className = 'song-card list-row';
  card.dataset.path = song.path;
  card.dataset.index = index;
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${song.title || '제목 정보 없음'} · 선택하여 준비 상태 확인`);

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
      const readiness = getSongReadiness(song, { activeTasks: state.activeTasks, alignmentQueue: state.alignmentQueue });
      const syncLabel = sync === 'synced' ? '싱크 완료' : (sync === 'unsynced' ? '가사만' : '없음');
      return `
        <div class="col col-info">
          <div class="song-name" title="${song.title || ''}">${song.title || '제목 정보 없음'}</div>
          <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}${song.genre ? ` · ${song.genre}` : ''}</div>
        </div>
        <div class="col col-stems">${stemCellHtml(song)}</div>
        <div class="col col-lyrics"><span class="lyric-cell ${sync}">${syncLabel}</span></div>
        <div class="col col-info-status"><span class="info-cell ${readiness.infoReady ? 'ready' : 'missing'}">${readiness.infoReady ? '완료' : readiness.missingInfo.join('·')}</span></div>
        <div class="col col-duration"><span class="duration-text">${song.duration || '--:--'}</span></div>
        <div class="col col-status"><span class="readiness-status ${readiness.status}">${readiness.statusLabel}</span></div>
        <div class="col col-more" title="더보기">⋯</div>
      `;
    })()}
  `;

  if (state.inspectedSongPath === song.path) card.classList.add('inspected');

  // 선택 모드 체크박스 (3개 뷰 모드 공통 — CSS가 [data-selection-mode]로 게이팅).
  // 실제 <input> 대신 표시 전용 마커를 쓰고 클릭은 카드 전체가 받는다.
  const selectMarker = document.createElement('div');
  selectMarker.className = 'song-select-marker';
  if (state.selectedSongPaths && state.selectedSongPaths.has(song.path)) {
    card.classList.add('selected-for-batch');
  }
  card.prepend(selectMarker);

  const selectOrToggle = async (e) => {
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

    // 1. If any modal is active, block selection from library cards
    const activeModal = document.querySelector(".modal-overlay.active");
    if (activeModal) {
      e.stopPropagation();
      return;
    }

    // 2. If context menu is active, just close it and stop further action
    if (elements.contextMenu && (elements.contextMenu.classList.contains("active") || elements.contextMenu.style.display === 'flex')) {
      closeContextMenu();
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    e.preventDefault();
    import('./library-panels.js').then((m) => {
      if (m.setInspectedSong(song.path) === false) return;
      document.querySelectorAll('.song-card.inspected').forEach((el) => el.classList.remove('inspected'));
      card.classList.add('inspected');
    }).catch(() => {});
  };

  card.addEventListener("click", selectOrToggle);

  const playSong = async (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    const { selectTrack } = await import('../player.js');
    selectTrack(index);
  };
  card.querySelector('.thumbnail')?.addEventListener('click', playSong);
  card.addEventListener('dblclick', playSong);

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

export function resetLibraryFilters() {
  if (elements.libSearchInput) elements.libSearchInput.value = '';
  for (const [id, value] of [['lib-category-filter', 'all'], ['lib-genre-filter', 'all'], ['lib-sync-filter', 'all'], ['lib-readiness-filter', 'all']]) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
  state.libraryReadinessFilter = 'all';
  document.querySelectorAll('.readiness-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.readiness === 'all'));
  renderLibrary();
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
