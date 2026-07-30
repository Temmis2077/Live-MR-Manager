/**
 * Library view mode, filters, and global click listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';

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

function exitSelectionMode() {
  state.librarySelectionMode = false;
  state.selectedSongPaths.clear();
  const btn = document.getElementById('library-select-mode');
  if (btn) btn.classList.remove('active');
  if (elements.viewport) elements.viewport.removeAttribute('data-selection-mode');
  document.querySelectorAll('.song-card.selected-for-batch').forEach((c) => c.classList.remove('selected-for-batch'));
  updateSelectionBar();
}

function initSelectionMode() {
  const toggleBtn = document.getElementById('library-select-mode');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      if (state.librarySelectionMode) {
        exitSelectionMode();
        return;
      }
      state.librarySelectionMode = true;
      state.selectedSongPaths.clear();
      toggleBtn.classList.add('active');
      if (elements.viewport) elements.viewport.setAttribute('data-selection-mode', 'true');
      updateSelectionBar();
    };
  }

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
      const { startMrSeparation } = await import('../../audio.js');
      const { showNotification } = await import('../../utils.js');
      for (const p of paths) {
        try { await startMrSeparation(p, null); } catch (_) { /* 개별 실패는 알림이 뜬다 */ }
      }
      exitSelectionMode();
      showNotification(`${paths.length}곡을 MR 분리 대기열에 넣었습니다.`, 'success');
      const { callAppHandler } = await import('../../app-context.js');
      callAppHandler('switchToTab', 'tasks');
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
        for (const p of paths) {
          const idx = state.songLibrary.findIndex((s) => s.path === p);
          if (idx < 0) continue;
          try { await performDeleteSong(idx); done++; } catch (_) {}
        }
        exitSelectionMode();
        renderLibrary();
        showNotification(`${done}곡을 삭제했습니다.`, 'success');
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
        showNotification(`${added}곡을 AI 정렬 대기열에 추가했습니다.`, 'success');
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

  const { invoke } = await import('../../tauri-bridge.js');
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

    state.songLibrary[idx] = song;
    updates.push(invoke('update_song_metadata', { song }));
  }

  try {
    await Promise.all(updates);
  } catch (err) {
    showNotification('일괄 수정에 실패했습니다: ' + err, 'error');
    return;
  }

  // 화면 갱신은 저장과 분리한다 — 갱신이 삐끗해도 '실패했다'고 알리면 안 된다.
  const { renderLibrary } = await import('../../ui/library.js');
  renderLibrary();
  import('../../ui/core.js').then((m) => m.refreshFilterDropdowns()).catch(() => {});
  import('../../ui/library-panels.js').then((m) => m.renderCollections()).catch(() => {});
  showNotification(`${updates.length}곡을 수정했습니다.`, 'success');
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
        elements.contextMenu.classList.remove("active");
        elements.contextMenu.style.display = 'none';
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

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const activeModal = document.querySelector(".modal-overlay.active");
      if (activeModal) activeModal.classList.remove("active");

      if (elements.contextMenu && elements.contextMenu.classList.contains("active")) {
        elements.contextMenu.classList.remove("active");
        elements.contextMenu.style.display = 'none';
      }
    }
  });

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

  if (updateViewMode) updateViewMode();
}
