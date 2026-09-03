/**
 * Library view mode, filters, and global click listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';
import { register } from '../../shortcuts.js';
import { libraryService } from '../../../ipc/services/library.js';

// 보기 모드 전환은 없앴다 — 표 한 가지만 쓴다. 선택 모드만 남는다.
export function initViewMode() {
  initSelectionMode();
}

/** 선택 바(N개 선택됨 + 일괄 작업 버튼) 표시/카운트 갱신. 카드 클릭 토글
 *  (ui/library.js)에서도 호출된다. */
export function updateSelectionBar() {
  const bar = document.getElementById('library-selection-bar');
  const countEl = document.getElementById('library-selection-count');
  if (!bar) return;
  const count = state.selectedSongPaths ? state.selectedSongPaths.size : 0;
  // 선택 모드에 들어가면 아직 고른 곡이 없어도 바를 보여 준다 — '보이는 곡
  // 모두 선택'이 그 안에 있어서, 안 보이면 시작할 수가 없다.
  bar.style.display = state.librarySelectionMode ? 'flex' : 'none';
  if (countEl) countEl.textContent = `${count}개 선택됨`;

  const apply = document.getElementById('btn-selection-apply');
  if (apply) apply.disabled = count === 0;
  ['btn-selection-align', 'btn-selection-separate', 'btn-selection-delete'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = count === 0;
  });
}

/** 일괄 지정 드롭다운을 표준 목록 + 라이브러리에 실제로 쓰인 값으로 채운다. */
async function fillBulkSelects() {
  const { GENRES, SUBGENRES, CATEGORIES } = await import('../../taxonomy.js');
  const catSel = document.getElementById('bulk-category');
  const genSel = document.getElementById('bulk-genre');

  if (catSel && catSel.options.length <= 1) {
    catSel.insertAdjacentHTML('beforeend',
      '<option value="__clear__">— 비우기 —</option>'
      + CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join(''));
  }
  if (genSel && genSel.options.length <= 1) {
    // 대장르 아래에 서브장르를 들여쓴다(락 › 락발라드).
    const opts = GENRES.map((g) => {
      const subs = (SUBGENRES[g] || []).map((s) => `<option value="${s}">　› ${s}</option>`).join('');
      return `<option value="${g}">${g}</option>${subs}`;
    }).join('');
    genSel.insertAdjacentHTML('beforeend', '<option value="__clear__">— 비우기 —</option>' + opts);
  }
}

/** 선택 모드 버튼의 눌림 표시. 버튼이 표 헤더 안에 있어 매 렌더마다 새로 생긴다. */
function markSelectModeButton(on) {
  const btn = document.getElementById('library-select-mode');
  if (!btn) return;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function exitSelectionMode() {
  state.librarySelectionMode = false;
  state.selectedSongPaths.clear();
  markSelectModeButton(false);
  if (elements.viewport) elements.viewport.removeAttribute('data-selection-mode');
  document.querySelectorAll('.song-card.selected-for-batch').forEach((c) => c.classList.remove('selected-for-batch'));
  updateSelectionBar();
}

function initSelectionMode() {
  // '여러 곡 선택'은 표 헤더의 선택 열에 있고, 헤더는 renderLibrary가 돌 때마다
  // 통째로 다시 그려진다. 버튼에 직접 onclick을 걸면 첫 렌더 이후 사라지므로
  // 문서 단위 위임으로 받는다.
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('#library-select-mode')) return;
    if (state.librarySelectionMode) {
      exitSelectionMode();
      return;
    }
    state.librarySelectionMode = true;
    state.selectedSongPaths.clear();
    markSelectModeButton(true);
    if (elements.viewport) elements.viewport.setAttribute('data-selection-mode', 'true');
    updateSelectionBar();
  });

  const clearBtn = document.getElementById('btn-selection-clear');
  if (clearBtn) clearBtn.onclick = () => exitSelectionMode();

  fillBulkSelects();

  // 지금 표에 보이는(필터가 걸린) 곡만 모두 선택 — 라이브러리 전체가 아니다.
  const allBtn = document.getElementById('btn-selection-all');
  if (allBtn) {
    allBtn.onclick = async () => {
      const { getFilteredSongs } = await import('../../ui/library.js');
      const visible = getFilteredSongs();
      const allSelected = visible.length > 0 && visible.every((s) => state.selectedSongPaths.has(s.path));
      if (allSelected) state.selectedSongPaths.clear();
      else visible.forEach((s) => state.selectedSongPaths.add(s.path));
      document.querySelectorAll('.song-card').forEach((c) => {
        c.classList.toggle('selected-for-batch', state.selectedSongPaths.has(c.dataset.path));
      });
      allBtn.textContent = allSelected ? '보이는 곡 모두 선택' : '선택 모두 풀기';
      updateSelectionBar();
    };
  }

  // 일괄 적용 — 보관함/장르/태그를 선택한 곡들에 한 번에 반영.
  const applyBtn = document.getElementById('btn-selection-apply');
  if (applyBtn) applyBtn.onclick = () => applyBulkEdit();

  const sepBtn = document.getElementById('btn-selection-separate');
  if (sepBtn) {
    sepBtn.onclick = async () => {
      const paths = Array.from(state.selectedSongPaths);
      if (paths.length === 0) return;
      const songs = [];
      let skippedBeforeStart = 0;
      for (const p of paths) {
        const song = state.songLibrary.find((s) => s.path === p);
        if (!song) { skippedBeforeStart++; continue; }
        if (song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path) { skippedBeforeStart++; continue; }
        songs.push(song);
      }
      const { showNotification } = await import('../../utils.js');
      if (songs.length === 0) {
        showNotification(`분리할 곡이 없습니다 · ${skippedBeforeStart}곡 건너뜀`, 'info');
        return;
      }

      const { openSeparationModeModal } = await import('../../separation-mode-modal.js');
      openSeparationModeModal(songs[0], {
        prompt: `선택한 ${songs.length}곡에 사용할 분리 모델을 선택해 주세요.`,
        onStart: async (modelId, harmonyModelId) => {
          const { startMrSeparation } = await import('../../audio.js');
          let done = 0;
          let failed = 0;
          for (const song of songs) {
            try { await startMrSeparation(song.path, modelId, harmonyModelId); done++; } catch (_) { failed++; }
          }
          exitSelectionMode();
          showNotification(`MR 분리: ${done}곡 시작 · ${skippedBeforeStart}곡 건너뜀 · ${failed}곡 실패`, failed ? 'info' : 'success');
          const { callAppHandler } = await import('../../app-context.js');
          callAppHandler('switchToTab', 'tasks');
        },
      });
    };
  }

  const delBtn = document.getElementById('btn-selection-delete');
  if (delBtn) {
    delBtn.onclick = async () => {
      const paths = Array.from(state.selectedSongPaths);
      if (paths.length === 0) return;
      const { openConfirmModal } = await import('../../ui/modals.js');
      openConfirmModal('곡 삭제', `선택한 ${paths.length}곡을 목록에서 삭제할까요?`, async () => {
        const { performDeleteSong, renderLibrary } = await import('../../ui/library.js');
        const { showNotification } = await import('../../utils.js');
        // 인덱스가 삭제마다 밀리므로 경로로 매번 다시 찾는다.
        let done = 0;
        let skipped = 0;
        let failed = 0;
        for (const p of paths) {
          const idx = state.songLibrary.findIndex((s) => s.path === p);
          if (idx < 0) { skipped++; continue; }
          try { await performDeleteSong(idx); done++; } catch (_) { failed++; }
        }
        exitSelectionMode();
        renderLibrary();
        showNotification(`삭제: ${done}곡 완료 · ${skipped}곡 건너뜀 · ${failed}곡 실패`, failed ? 'info' : 'success');
      });
    };
  }

  const alignBtn = document.getElementById('btn-selection-align');
  if (alignBtn) {
    alignBtn.onclick = async () => {
      const paths = Array.from(state.selectedSongPaths);
      if (paths.length === 0) return;
      const { enqueueAlignment, ensureAlignmentModelsReady } = await import('../../alignment-queue.js');
      const { showNotification } = await import('../../utils.js');
      // 대기열에 걸기 전에 정렬 모델을 확인·다운로드(없으면 조용히 실패하는 걸 방지).
      const ready = await ensureAlignmentModelsReady();
      if (!ready) {
        showNotification('정렬 모델이 없어 정렬을 시작하지 않았습니다. 가사 싱크 탭에서 모델을 받은 뒤 다시 시도하세요.', 'info');
        return;
      }
      const added = enqueueAlignment(paths);
      exitSelectionMode();
      if (added > 0) {
        showNotification(`가사 정렬: ${added}곡 추가 · ${paths.length - added}곡 건너뜀`, 'success');
      } else {
        showNotification('선택한 곡이 모두 이미 대기열에 있습니다.', 'info');
      }
      // 진행 상황을 바로 볼 수 있게 AI 프로세싱 탭으로 이동
      const { callAppHandler } = await import('../../app-context.js');
      callAppHandler('switchToTab', 'tasks');
    };
  }
}

/**
 * 선택한 곡들에 보관함·장르·태그를 한 번에 반영한다.
 *
 * 예전에는 '곡 정보 관리자' 모달을 따로 열어야 했다. 표에서 고른 채로 바로
 * 고칠 수 있으면 창을 오갈 이유가 없다.
 *
 * 비워 둔 칸은 건드리지 않는다("그대로 두기") — 일괄 편집에서 가장 흔한 사고가
 * 안 건드리려던 값이 빈 값으로 덮이는 것이다. 지우려면 '— 비우기 —'를 고른다.
 */
async function applyBulkEdit() {
  const paths = Array.from(state.selectedSongPaths || []);
  if (paths.length === 0) return;

  const { showNotification } = await import('../../utils.js');

  const catVal = document.getElementById('bulk-category')?.value || '';
  const genVal = document.getElementById('bulk-genre')?.value || '';
  const tagRaw = (document.getElementById('bulk-tags')?.value || '').trim();
  const tagMode = document.getElementById('bulk-tag-mode')?.value || 'add';
  const tags = tagRaw.split(',').map((t) => t.trim()).filter(Boolean);

  if (!catVal && !genVal && tags.length === 0) {
    showNotification('바꿀 값을 하나 이상 골라 주세요.', 'info');
    return;
  }

  const updates = [];
  for (const p of paths) {
    const idx = state.songLibrary.findIndex((s) => s.path === p);
    if (idx < 0) continue;
    const song = { ...state.songLibrary[idx] };

    if (catVal) {
      const next = catVal === '__clear__' ? [] : [catVal];
      song.categories = next;
      song.curationCategory = next[0] || null;
      song.curation_category = song.curationCategory;
    }
    if (genVal) {
      song.genre = genVal === '__clear__' ? undefined : genVal;
    }
    if (tags.length > 0) {
      const cur = Array.isArray(song.tags) ? song.tags : [];
      if (tagMode === 'replace') song.tags = [...tags];
      else if (tagMode === 'remove') song.tags = cur.filter((t) => !tags.includes(t));
      else song.tags = [...new Set([...cur, ...tags])];
    }

    updates.push({ idx, song, request: libraryService.update(song) });
  }

  const results = await Promise.allSettled(updates.map((u) => u.request));
  let done = 0;
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      state.songLibrary[updates[i].idx] = updates[i].song;
      done++;
    } else failed++;
  });

  // 화면 갱신은 저장과 분리한다 — 갱신이 삐끗해도 '실패했다'고 알리면 안 된다.
  const { renderLibrary } = await import('../../ui/library.js');
  renderLibrary();
  import('../../ui/core.js').then((m) => m.refreshFilterDropdowns()).catch(() => {});
  import('../../ui/library-panels.js').then((m) => m.renderCollections()).catch(() => {});
  showNotification(`정보 정리: ${done}곡 완료 · ${paths.length - updates.length}곡 건너뜀 · ${failed}곡 실패`, failed ? 'info' : 'success');
}

/** 표 모드 하나만 남았지만, 목록 컨테이너의 클래스·표시는 여전히 맞춰 줘야
 *  한다(다른 탭에서 돌아올 때 display가 none으로 남아 있을 수 있다). */
export function createViewModeUpdater() {
  const applyListMode = () => {
    state.viewMode = "list";
    if (elements.viewport) elements.viewport.setAttribute("data-view-mode", "list");
    if (elements.songGrid) {
      elements.songGrid.classList.remove("grid-mode", "button-mode");
      elements.songGrid.classList.add("list-mode");
      elements.songGrid.style.display = "flex";
    }
    import('../../ui/library.js').then(({ renderLibrary }) => renderLibrary());
  };

  initViewMode();
  return applyListMode;
}

export function initLibraryListeners(updateViewMode) {
  document.addEventListener("click", (e) => {
    if (elements.contextMenu && (elements.contextMenu.classList.contains("active") || elements.contextMenu.style.display === 'flex')) {
      if (!e.target.closest("#context-menu")) {
        import('../../ui/components.js').then((m) => m.closeContextMenu());
      }
    }

    const customSelect = e.target.closest(".custom-select");
    if (customSelect) {
      const optionItem = e.target.closest(".option-item");
      if (optionItem) {
        const value = optionItem.dataset.value;
        const hiddenInput = customSelect.querySelector("input[type='hidden']");
        const selectedText = customSelect.querySelector(".selected-text");

        if (hiddenInput) {
          hiddenInput.value = value;
          hiddenInput.dispatchEvent(new Event("input"));
          hiddenInput.dispatchEvent(new Event("change"));
        }

        if (selectedText) {
          selectedText.textContent = optionItem.textContent;
        }

        customSelect.querySelectorAll(".option-item").forEach(opt => opt.classList.remove("selected"));
        optionItem.classList.add("selected");
        customSelect.classList.remove("active");
      } else {
        const isCurrentlyActive = customSelect.classList.contains("active");
        document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
        if (!isCurrentlyActive) {
          customSelect.classList.add("active");
        }
      }
    } else {
      document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
    }

    const vocalItem = e.target.closest(".vocal-item");
    if (!vocalItem) {
      const popover = document.getElementById("popover-vocal-balance");
      if (popover) popover.classList.remove("active");
    }

    // 컨트롤바 현재 곡 메뉴(⋮)도 바깥 클릭 시 닫기
    if (!e.target.closest(".dock-more")) {
      const morePopover = document.getElementById("dock-more-popover");
      if (morePopover) morePopover.classList.remove("active");
    }

    const card = e.target.closest(".song-card");
    const dock = e.target.closest(".control-dock");
    const modal = e.target.closest(".modal-content");

    if (!card && !dock && !modal && !customSelect) {
      if (state.selectedTrackIndex !== -1) {
        state.selectedTrackIndex = -1;
        import('../../ui/components.js').then(({ updateThumbnailOverlay }) => updateThumbnailOverlay());
      }
    }
  });

  // 음원 관리 화면 단축키는 js/shortcuts.js 레지스트리로 옮겼다.
  // 예전에는 여기 Escape 처리가 `.modal-overlay.active`를 통째로 지워서
  // 각 모달의 닫기 함수를 건너뛰었다 — 이제 ui/layer-stack.js가 최상단
  // 레이어 하나만, 그 모달이 정해 둔 경로로 닫는다.
  registerLibraryShortcuts();

  const renderLibraryDeferred = () => {
    import('../../ui/library.js').then(({ renderLibrary }) => renderLibrary());
  };

  if (elements.libSearchInput) {
    elements.libSearchInput.addEventListener("input", renderLibraryDeferred);
  }
  if (elements.libGenreFilter) {
    elements.libGenreFilter.addEventListener("change", renderLibraryDeferred);
  }
  if (elements.libCategoryFilter) {
    elements.libCategoryFilter.addEventListener("change", renderLibraryDeferred);
  }
  if (elements.libSortSelect) {
    elements.libSortSelect.addEventListener("change", renderLibraryDeferred);
  }
  const libSyncFilter = document.getElementById("lib-sync-filter");
  if (libSyncFilter) {
    libSyncFilter.addEventListener("change", renderLibraryDeferred);
  }
  const readinessInput = document.getElementById('lib-readiness-filter');
  document.querySelectorAll('.readiness-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const value = chip.dataset.readiness || 'all';
      state.libraryReadinessFilter = value;
      if (readinessInput) readinessInput.value = value;
      document.querySelectorAll('.readiness-chip').forEach((item) => item.classList.toggle('active', item === chip));
      renderLibraryDeferred();
    });
  });

  if (updateViewMode) updateViewMode();
}

/**
 * 음원 관리 화면의 키보드 조작.
 *
 * 동작은 예전 keydown 블록 그대로다 — 달라진 건 등록 위치뿐이다. 이제
 * 어떤 키가 있는지 단축키 도움말(?)에 자동으로 나오고, 입력창 안인지 /
 * 모달이 떠 있는지 판정은 shortcuts.js가 한 곳에서 처리한다.
 */
function registerLibraryShortcuts() {
  const visibleTracks = () => state.filteredTracks || [];

  const moveInspected = (delta) => {
    const visible = visibleTracks();
    if (!visible.length) return;
    const current = visible.findIndex((song) => song.path === state.inspectedSongPath);
    const next = current < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, current + delta));
    import('../../ui/library-panels.js').then((m) => {
      if (m.setInspectedSong(visible[next].path) === false) return;
      document.querySelectorAll('.song-card').forEach((row) => row.classList.toggle('inspected', row.dataset.path === visible[next].path));
      document.querySelector(`.song-card[data-path="${CSS.escape(visible[next].path)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };

  register({
    combo: 'ArrowDown', scope: 'library', group: 'library', repeatable: true,
    label: '다음 곡 선택', handler: () => moveInspected(1),
  });
  register({
    combo: 'ArrowUp', scope: 'library', group: 'library', repeatable: true,
    label: '이전 곡 선택', handler: () => moveInspected(-1),
  });

  register({
    combo: 'Space', scope: 'library', group: 'library',
    label: '선택한 곡 재생',
    handler: () => {
      if (!state.inspectedSongPath) return;
      const visible = visibleTracks();
      const song = visible.find((item) => item.path === state.inspectedSongPath)
        || state.songLibrary.find((item) => item.path === state.inspectedSongPath);
      if (!song) return;
      const idx = state.songLibrary.findIndex((item) => item.path === song.path);
      import('../../player.js').then((m) => m.selectTrack(idx));
    },
  });

  register({
    combo: 'Enter', scope: 'library', group: 'library',
    label: '추천 작업 실행 (MR 분리 · 가사 싱크 등)',
    // 실행할 버튼이 없으면 기본 동작을 막지 않는다.
    preventDefault: false,
    handler: (e) => {
      if (!state.inspectedSongPath) return;
      const nextAction = document.getElementById('insp-next-action');
      if (nextAction && !nextAction.disabled) {
        e.preventDefault();
        nextAction.click();
      }
    },
  });

  register({
    combo: 'Ctrl+A', scope: 'library', group: 'library',
    label: '보이는 곡 모두 선택',
    handler: () => {
      const visible = visibleTracks();
      if (!visible.length) return;
      state.librarySelectionMode = true;
      visible.forEach((song) => state.selectedSongPaths.add(song.path));
      markSelectModeButton(true);
      elements.viewport?.setAttribute('data-selection-mode', 'true');
      document.querySelectorAll('.song-card').forEach((row) => row.classList.toggle('selected-for-batch', state.selectedSongPaths.has(row.dataset.path)));
      updateSelectionBar();
    },
  });
}
