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
  bar.style.display = (state.librarySelectionMode && count > 0) ? 'flex' : 'none';
  if (countEl) countEl.textContent = `${count}개 선택됨`;
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
