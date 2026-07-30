/**
 * js/ui/components.js - Shared UI Components & Status Updates
 * Cache Buster: 2026-04-19 12:10
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { getAppHandler } from '../app-context.js';
import { invoke } from '../tauri-bridge.js';
import { getThumbnailUrl } from '../utils.js';
import { extractYoutubeVideoId } from '../youtube-utils.js';

export function updateBroadcastTasksControlVisibility() {
  if (!elements.broadcastTasksControl) return;
  const isVisibleTab =
    state.activeView === "library" ||
    state.activeView === "youtube" ||
    state.activeView === "local" ||
    state.activeView === "tasks";
  const hasActiveTasks = Object.keys(state.activeTasks || {}).length > 0;
  elements.broadcastTasksControl.style.display = (isVisibleTab && hasActiveTasks) ? "block" : "none";
}

function isSeparatedSong(song) {
  if (!song) return false;
  return !!(song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path);
}

export function updateAiModelStatus(statusInput) {
  if (!elements.aiModelStatus) return;
  
  // Normalize status input
  const status = typeof statusInput === 'boolean' 
    ? { loaded: statusInput, downloading: false, progress: 0 } 
    : statusInput;

  elements.aiModelStatus.className = "ai-model-status";
  
  if (status.loaded) {
    elements.aiModelStatus.classList.add("loaded");
    elements.aiModelStatus.innerHTML = '<i class="fas fa-check-circle"></i> 분리 모델 로드 완료';
    if (elements.btnDownloadModel) elements.btnDownloadModel.style.display = "none";
    if (elements.btnDeleteModel) elements.btnDeleteModel.style.display = "inline-flex";
  } else if (status.downloading) {
    elements.aiModelStatus.classList.add("loading");
    elements.aiModelStatus.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 모델 다운로드 중... (${status.progress || 0}%)`;
    if (elements.btnDownloadModel) elements.btnDownloadModel.style.display = "none";
    if (elements.btnDeleteModel) elements.btnDeleteModel.style.display = "none";
  } else {
    elements.aiModelStatus.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 분리 모델 미설치';
    if (elements.btnDownloadModel) elements.btnDownloadModel.style.display = "inline-flex";
    if (elements.btnDeleteModel) elements.btnDeleteModel.style.display = "none";
  }

  if (elements.aiEngineProvider) {
    const isGPU = status.provider && (status.provider.includes("GPU") || status.provider.includes("CUDA") || status.provider.includes("DirectML"));
    elements.aiEngineProvider.textContent = status.provider || "CPU";
    elements.aiEngineProvider.className = "engine-provider " + (isGPU ? "cuda" : "cpu");
  }

  if (elements.cudaRecommendBanner) {
    const isGPU = status.provider && (status.provider.includes("GPU") || status.provider.includes("CUDA") || status.provider.includes("DirectML"));
    elements.cudaRecommendBanner.style.display = (status.cuda_available && !isGPU) ? "flex" : "none";
  }
}

/**
 * Generic keyed upsert of `.task-card` elements into a list container —
 * shared by the separation task list and the alignment queue list so both
 * keep the same diff/reorder behavior (no full innerHTML rebuild per tick).
 */
function upsertTaskCards(container, items, emptyHtml, createCard, updateCard) {
  if (!container) return;

  if (items.length === 0) {
    if (!container.querySelector('.no-tasks')) {
      container.innerHTML = `<div class="no-tasks">${emptyHtml}</div>`;
    }
    // Clear any stale cards alongside the placeholder.
    container.querySelectorAll('.task-card').forEach((c) => c.remove());
    return;
  }

  const existingCards = new Map(
    Array.from(container.querySelectorAll('.task-card')).map((card) => [card.dataset.path, card])
  );
  const nextPaths = new Set(items.map((t) => t.path));

  const emptyState = container.querySelector('.no-tasks');
  if (emptyState) emptyState.remove();

  existingCards.forEach((card, path) => {
    if (!nextPaths.has(path)) {
      card.remove();
      existingCards.delete(path);
    }
  });

  items.forEach((item, index) => {
    let card = existingCards.get(item.path);
    if (!card) {
      card = createCard(item);
      existingCards.set(item.path, card);
    }
    updateCard(card, item);
    const currentAtIndex = container.children[index];
    if (currentAtIndex !== card) {
      container.insertBefore(card, currentAtIndex || null);
    }
  });
}

function renderSeparationTasks() {
  const container = elements.activeTasksList;
  if (!container) return 0;

  const tasks = Object.entries(state.activeTasks).map(([path, data]) => {
    const song = state.songLibrary.find((s) => s.path === path);
    return {
      ...data,
      path,
      // separation-progress payload may not include rich song metadata, so hydrate from library.
      title: data.title || song?.title || "알 수 없는 곡",
      thumbnail: data.thumbnail || song?.thumbnail || "",
    };
  });

  const statusMap = {
    "Queued": "대기 중",
    "Preparing": "준비 중",
    "Starting": "시작 중",
    "Processing": "분리 중",
    "Finished": "완료",
    "Cancelled": "취소됨",
    "Error": "오류",
    "RetryWaiting": "재시도 대기 중"
  };

  const formatTaskViewModel = (task) => {
    const percent = Math.floor(task.percentage || 0);
    const thumbUrl = task.thumbnail ? getThumbnailUrl(task.thumbnail, task) : '';
    const pStr = (task.provider || "").toUpperCase();
    // 대기 중인 태스크는 실제 provider가 아직 정해지지 않아 placeholder("local"/
    // "SYSTEM"/"UNKNOWN"/"")로 들어온다. 이때 CPU로 단정하면 작업 시작 시 GPU로
    // 바뀌어 보이는 오해가 생기므로, provider가 확정되기 전엔 "대기"로 표시한다.
    const providerKnown = pStr !== "" && !["LOCAL", "SYSTEM", "UNKNOWN"].includes(pStr);
    const isGPU = providerKnown && (pStr.includes("GPU") || pStr.includes("CUDA") || pStr.includes("DIRECTML") || pStr.includes("TENSORRT"));
    const providerLabel = providerKnown ? (isGPU ? "GPU" : "CPU") : "대기";
    let displayStatus = statusMap[task.status] || task.status || '대기 중';
    // 다운로드 실패 후 백오프 대기 — 몇 번째 시도이고 얼마 뒤인지 같이 보여준다.
    if (task.status === "RetryWaiting") {
      const d = Number(task.retryDelayMs || 0);
      const when = d >= 60000 ? `${Math.round(d / 60000)}분 후` : `${Math.round(d / 1000)}초 후`;
      displayStatus = `재시도 대기 중 (${task.retryAttempt}/${task.retryMax} · ${when})`;
    }
    return { percent, thumbUrl, isGPU, providerLabel, displayStatus };
  };

  const createTaskCard = (task) => {
    const vm = formatTaskViewModel(task);
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.path = task.path;
    card.innerHTML = `
      <div class="task-header-info">
        <div class="task-icon">
          ${vm.thumbUrl ? `<img src="${vm.thumbUrl}" class="task-thumb-img">` : '<i class="fas fa-magic"></i>'}
        </div>
        <div class="task-main-details">
          <div class="task-title"></div>
          <div class="task-status-row">
            <span class="task-status-text"></span>
            <span class="task-percentage"></span>
          </div>
        </div>
        <div class="task-actions">
          <div class="task-provider-badge"></div>
          <button class="btn-task-cancel">취소</button>
        </div>
      </div>
      <div class="task-progress-container">
        <div class="task-progress-bar"></div>
      </div>
    `;

    const cancelBtn = card.querySelector('.btn-task-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const cancelTask = getAppHandler('cancelTask');
        if (typeof cancelTask === 'function') {
          cancelTask(card.dataset.path);
        }
      });
    }

    return card;
  };

  const updateTaskCard = (card, task) => {
    const vm = formatTaskViewModel(task);
    card.dataset.path = task.path;

    const icon = card.querySelector('.task-icon');
    if (icon) {
      const prevThumb = card.dataset.thumbUrl || '';
      if (prevThumb !== vm.thumbUrl) {
        icon.innerHTML = vm.thumbUrl ? `<img src="${vm.thumbUrl}" class="task-thumb-img">` : '<i class="fas fa-magic"></i>';
        card.dataset.thumbUrl = vm.thumbUrl;
      }
    }
    const title = card.querySelector('.task-title');
    if (title) title.textContent = task.title;
    const status = card.querySelector('.task-status-text');
    if (status) status.textContent = vm.displayStatus;
    const percentage = card.querySelector('.task-percentage');
    if (percentage) percentage.textContent = `${vm.percent}%`;

    const badge = card.querySelector('.task-provider-badge');
    if (badge) {
      badge.textContent = vm.providerLabel;
      badge.classList.toggle('provider-gpu', vm.isGPU);
    }

    const progressBar = card.querySelector('.task-progress-bar');
    if (progressBar) {
      progressBar.style.width = `${vm.percent}%`;
    }
  };

  upsertTaskCards(container, tasks, '현재 진행 중인 분리 작업이 없습니다.', createTaskCard, updateTaskCard);
  return tasks.length;
}

function renderAlignmentQueue() {
  const container = elements.alignmentTasksList;
  if (!container) return 0;

  const items = state.alignmentQueue || [];

  // "대기열 전체 지우기" — 항목이 있을 때만 노출, 클릭 시 처리 중 취소 + 전체 제거
  const actionsBar = document.getElementById('alignment-queue-actions');
  if (actionsBar) {
    actionsBar.style.display = items.length > 0 ? 'flex' : 'none';
    const clearBtn = document.getElementById('alignment-clear-all');
    if (clearBtn && !clearBtn._wired) {
      clearBtn._wired = true;
      clearBtn.onclick = async () => {
        const hasProcessing = (state.alignmentQueue || []).some((i) => i.status === 'processing');
        if (hasProcessing && !confirm('처리 중인 정렬이 있습니다. 취소하고 대기열을 모두 지울까요?')) return;
        const { clearAlignmentQueue } = await import('../alignment-queue.js');
        await clearAlignmentQueue();
      };
    }
  }

  const statusMap = {
    'queued': '대기 중',
    'processing': '정렬 중',
    'done': '완료',
    'error': '오류',
    'no-lyrics': '가사 없음',
    'cancelled': '취소됨',
  };

  const createCard = (item) => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.path = item.path;
    const thumbUrl = item.thumbnail ? getThumbnailUrl(item.thumbnail, item) : '';
    card.innerHTML = `
      <div class="task-header-info">
        <div class="task-icon">
          ${thumbUrl ? `<img src="${thumbUrl}" class="task-thumb-img">` : '<i class="fas fa-align-left"></i>'}
        </div>
        <div class="task-main-details">
          <div class="task-title"></div>
          <div class="task-status-row">
            <span class="task-status-text"></span>
            <span class="task-percentage"></span>
          </div>
        </div>
        <div class="task-actions">
          <button class="btn-task-cancel">취소</button>
        </div>
      </div>
      <div class="task-progress-container">
        <div class="task-progress-bar"></div>
      </div>
    `;
    const cancelBtn = card.querySelector('.btn-task-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        import('../alignment-queue.js').then(({ cancelAlignmentQueueItem }) => {
          cancelAlignmentQueueItem(card.dataset.path);
        });
      });
    }
    return card;
  };

  const updateCard = (card, item) => {
    card.dataset.path = item.path;
    const title = card.querySelector('.task-title');
    if (title) title.textContent = item.title || item.path;

    // 처리 중이면서 아직 실제 추론 진행률이 안 온 준비 단계('preparing')는
    // 0%가 아니라 "준비 중(모델 로드 중)"으로 표시 — 모델 로드에 수 초 걸릴 수 있음.
    const isPreparing = item.status === 'processing' && item.phase === 'preparing';

    const status = card.querySelector('.task-status-text');
    if (status) {
      let text = statusMap[item.status] || item.status;
      if (isPreparing) text = '준비 중 (모델 로드)';
      // 랩/혼합(듀얼 모델) 모드: 몇 번째 패스인지 표기 (예: "정렬 중 (1/2)")
      if (item.status === 'processing' && !isPreparing && item.passLabel) text = `정렬 중 (${item.passLabel})`;
      if (item.status === 'error' && item.error) text = `오류: ${item.error}`;
      if (item.status === 'done' && item.note) text = `완료 (${item.note})`;
      status.textContent = text;
      status.classList.toggle('task-status-error', item.status === 'error');
    }

    const percentage = card.querySelector('.task-percentage');
    if (percentage) {
      // 준비 중에는 퍼센트를 숨기고(0% 오해 방지), 정렬 단계에서만 %표시.
      percentage.textContent = (item.status === 'processing' && !isPreparing)
        ? `${Math.floor(item.percentage || 0)}%` : '';
    }

    const progressBar = card.querySelector('.task-progress-bar');
    if (progressBar) {
      const pct = item.status === 'done' ? 100 : (item.status === 'processing' ? Math.floor(item.percentage || 0) : 0);
      progressBar.style.width = `${pct}%`;
      // 준비 중에는 불확정 진행 표시(자체 애니메이션)로 "멈춘 게 아님"을 알림.
      progressBar.classList.toggle('indeterminate', isPreparing);
    }

    // 종결 상태(완료/오류/가사 없음/취소)에서는 "취소"가 아니라 목록 제거 액션.
    const cancelBtn = card.querySelector('.btn-task-cancel');
    if (cancelBtn) {
      const finished = ['done', 'error', 'no-lyrics', 'cancelled'].includes(item.status);
      cancelBtn.textContent = finished ? '지우기' : '취소';
    }
  };

  upsertTaskCards(
    container,
    items,
    '대기 중인 정렬 작업이 없습니다. 라이브러리에서 곡을 선택해 "AI 정렬 요청"을 눌러보세요.',
    createCard,
    updateCard
  );
  // 활성(대기/진행) 항목만 배지 카운트에 반영 — 완료·오류 잔여물로 배지가 계속 떠 있지 않게.
  return items.filter((i) => i.status === 'queued' || i.status === 'processing').length;
}

export function updateTaskUI() {
  if (!elements.taskBadge) return;

  const separationCount = renderSeparationTasks();
  const alignmentActiveCount = renderAlignmentQueue();

  // 99를 넘으면 "99+"로 캡 — 자릿수가 늘어 배지가 셰브론을 밀어내지 않게.
  const formatCount = (n) => (n > 99 ? '99+' : String(n));
  const sepBadge = document.getElementById('separation-section-count');
  if (sepBadge) sepBadge.textContent = formatCount(separationCount);
  const alignBadge = document.getElementById('alignment-section-count');
  if (alignBadge) alignBadge.textContent = formatCount((state.alignmentQueue || []).length);

  const total = separationCount + alignmentActiveCount;
  elements.taskBadge.textContent = total;
  elements.taskBadge.style.display = total > 0 ? "flex" : "none";

  updateBroadcastTasksControlVisibility();
}

/** AI 프로세싱 탭의 카테고리 섹션 접기/펴기 — localStorage에 섹션별로 저장. */
export function initTaskSectionToggles() {
  document.querySelectorAll('#tasks-page .task-section').forEach((section) => {
    const key = `taskSectionCollapsed:${section.dataset.section}`;
    if (localStorage.getItem(key) === 'true') section.classList.add('collapsed');
    const toggle = section.querySelector('.section-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const collapsed = section.classList.toggle('collapsed');
        localStorage.setItem(key, String(collapsed));
      });
    }
  });
}

export function updateAiTogglesState(song = null) {
  if (!elements.toggleVocal) return;

  // If no song provided, find from state
  const targetSong = song || (state.selectedTrackIndex !== -1 ? state.songLibrary[state.selectedTrackIndex] : state.currentTrack);

  // Requirement: Enable ONLY if separated MR exists.
  // Accept both camel/snake flags and URL variants (youtu.be / youtube.com).
  let hasSeparatedMr = isSeparatedSong(targetSong);
  if (!hasSeparatedMr && targetSong?.path) {
    const targetId = extractYoutubeVideoId(targetSong.path);
    if (targetId) {
      hasSeparatedMr = state.songLibrary.some((s) => {
        if (!isSeparatedSong(s)) return false;
        return extractYoutubeVideoId(s.path) === targetId;
      });
    }
  }
  const canToggleVocal = !!hasSeparatedMr;

  elements.toggleVocal.checked = state.vocalEnabled;
  elements.toggleVocal.disabled = !canToggleVocal;

  const vocalItem = elements.toggleVocal.closest('.vocal-item');
  if (vocalItem) {
    vocalItem.classList.toggle('disabled', !canToggleVocal);
  }

  // If disabled, ensure balance popover is closed
  if (!canToggleVocal) {
    const popover = document.getElementById("popover-vocal-balance");
    if (popover) popover.classList.remove("active");
  }

  if (elements.toggleLyric) {
    const hasLyrics = !!(targetSong && targetSong.hasLyrics);
    elements.toggleLyric.checked = state.lyricsEnabled;
    elements.toggleLyric.disabled = false; // Always enabled for user guidance

    const lyricItem = elements.toggleLyric.closest('.ai-item');
    if (lyricItem) {
      lyricItem.classList.remove('disabled');
      lyricItem.title = hasLyrics ? "AI 가사 싱크 활성" : "가사 싱크를 생성해 보세요!";
    }
  }
}

export function updatePlayButton() {
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.classList.toggle("is-playing", state.isPlaying);
  }
}

export function showSongContextMenu(e, song, originalIndex) {
  if (!elements.contextMenu) {
    const errorMsg = "[Context Menu] Element not found in elements object.";
    console.error(errorMsg);
    invoke('remote_js_log', { msg: errorMsg }).catch(() => {});
    return;
  }
  state.editingSongIndex = originalIndex;

  const menuWidth = 160;
  const menuHeight = 240;
  let x = e.clientX;
  let y = e.clientY;
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const logMsg = `[Context Menu] Triggered for index ${originalIndex} at (${x}, ${y})`;
  console.log(logMsg);
  invoke('remote_js_log', { msg: logMsg }).catch(() => {});

  if (x + menuWidth > winW) x = winW - menuWidth - 10;
  if (y + menuHeight > winH) y = winH - menuHeight - 10;
  if (x < 10) x = 10;
  if (y < 10) y = 10;

  elements.contextMenu.style.top = `${y}px`;
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.display = 'flex';
  elements.contextMenu.classList.add("active");

  const menuSeparate = document.getElementById("menu-separate");
  const menuDeleteMr = document.getElementById("menu-delete-mr");
  const menuPlay = document.getElementById("menu-play");
  const menuLyricsView = document.getElementById("menu-lyrics-view");
  const menuEdit = document.getElementById("menu-edit");
  const menuDelete = document.getElementById("menu-delete");
  const inputSeparator = document.getElementById("menu-input-separator");
  const menuUndo = document.getElementById("menu-undo");
  const menuRedo = document.getElementById("menu-redo");
  const menuCut = document.getElementById("menu-cut");
  const menuCopy = document.getElementById("menu-copy");
  const menuPaste = document.getElementById("menu-paste");
  const menuSelectAll = document.getElementById("menu-select-all");

  // Song context: show song actions, hide text-input actions.
  [menuSeparate, menuDeleteMr, menuEdit, menuDelete].forEach((el) => {
    if (el) el.style.display = "block";
  });
  // 재생/가사 보기는 기본 숨김 — 카드 클릭/드로어로 대체 가능해 메뉴를
  // 단순하게 유지. 설정 > 재생에서 다시 켤 수 있음.
  if (menuPlay) menuPlay.style.display = localStorage.getItem('ctxMenuPlayEnabled') === 'true' ? "block" : "none";
  if (menuLyricsView) menuLyricsView.style.display = localStorage.getItem('ctxMenuLyricsViewEnabled') === 'true' ? "block" : "none";
  [inputSeparator, menuUndo, menuRedo, menuCut, menuCopy, menuPaste, menuSelectAll].forEach((el) => {
    if (el) el.style.display = "none";
  });

  invoke('remote_js_log', { msg: `[Context Menu Init] menuPlay=${!!menuPlay}, menuLyricsView=${!!menuLyricsView}, menuEdit=${!!menuEdit}, menuDelete=${!!menuDelete}, menuSeparate=${!!menuSeparate}, menuDeleteMr=${!!menuDeleteMr}` }).catch(() => {});

  if (menuDeleteMr) menuDeleteMr.style.display = "none";
  if (menuSeparate) {
    menuSeparate.style.display = "none";
    menuSeparate.classList.remove("disabled");
  }

  // Update: Using dynamic import for audio.js
  const menuTargetId = song.path;
  import('../audio.js').then(({ checkMrSeparated, deleteMr }) => {
    invoke('remote_js_log', { msg: `[MR Check] Starting MR check for path: ${song.path}` }).catch(() => {});
    checkMrSeparated(song.path).then(isSeparated => {
      const separatedFlag = !!(song.isSeparated || song.is_separated || isSeparated);
      // Distinguish "original instrumental(MR)" from "AI-separated".
      const isManualMr = !!(song.isMr || song.is_mr) && !separatedFlag;
      invoke('remote_js_log', { msg: `[MR Check] Completed. isSeparated=${isSeparated}` }).catch(() => {});
      // Race condition check: make sure the menu is still for the same song
      if (state.editingSongIndex !== originalIndex) {
        invoke('remote_js_log', { msg: `[MR Check] Race condition detected. Skipping.` }).catch(() => {});
        return;
      }

      if (menuDeleteMr) {
        invoke('remote_js_log', { msg: `[MR Delete Init] Setting display=${isSeparated ? "block" : "none"}` }).catch(() => {});
        menuDeleteMr.style.display = isSeparated ? "block" : "none";
        menuDeleteMr.onclick = async () => {
          invoke('remote_js_log', { msg: `[MR Delete Click] Attempting to delete MR for: ${song.path}` }).catch(() => {});
          elements.contextMenu.classList.remove("active");
          elements.contextMenu.style.display = 'none';
          try {
            const { stopPlayback } = await import('../player.js');
            await stopPlayback();
            await deleteMr(song.path);
            clearMrPresenceCache(song.path);
            invoke('remote_js_log', { msg: `[MR Delete] Successfully deleted MR` }).catch(() => {});
            
            // Update local state to reflect deletion
            const songInLib = state.songLibrary.find(s => s.path === song.path);
            if (songInLib) {
              songInLib.isSeparated = false;
              songInLib.is_separated = false;
              songInLib.isMr = false;
              songInLib.is_mr = false;
              songInLib.mr_path = null;
            }

            // Re-render library after deletion
            const { renderLibrary } = await import('./library.js');
            renderLibrary();
          } catch (err) {
            invoke('remote_js_log', { msg: `[MR Delete Error] ${err.message}` }).catch(() => {});
            console.error("MR Delete failed:", err);
          }
        };
      } else {
        invoke('remote_js_log', { msg: `[MR Delete Init] menuDeleteMr is null!` }).catch(() => {});
      }

      if (menuSeparate) {
        if (state.activeTasks[song.path]) {
          invoke('remote_js_log', { msg: `[MR Separate] Task in progress, showing cancel option` }).catch(() => {});
          menuSeparate.style.display = "block";
          menuSeparate.textContent = "분리 취소";
          if (isManualMr) {
            menuSeparate.classList.add("disabled");
            menuSeparate.onclick = null;
          } else {
            menuSeparate.classList.remove("disabled");
            menuSeparate.onclick = () => {
              invoke('remote_js_log', { msg: `[MR Separate Cancel] Cancelling separation` }).catch(() => {});
              elements.contextMenu.classList.remove("active");
              elements.contextMenu.style.display = 'none';
              // audio.js handles cancel_separation
              import('../audio.js').then(({ cancelSeparation }) => {
                  cancelSeparation(song.path);
              });
            };
          }
        } else {
          menuSeparate.style.display = isSeparated ? "none" : "block";
          menuSeparate.textContent = "MR 분리";
          if (isManualMr) {
            menuSeparate.style.display = "block";
            menuSeparate.classList.add("disabled");
            menuSeparate.onclick = null;
          } else {
            menuSeparate.classList.remove("disabled");
            menuSeparate.onclick = async () => {
              invoke('remote_js_log', { msg: `[MR Separate] Opening mode picker` }).catch(() => {});
              elements.contextMenu.classList.remove("active");
              elements.contextMenu.style.display = 'none';
              try {
                // 바로 분리하지 않고 속도/품질(모델) 선택 모달을 먼저 띄운다.
                const { openSeparationModeModal } = await import('../separation-mode-modal.js');
                openSeparationModeModal(song);
              } catch (err) {
                invoke('remote_js_log', { msg: `[MR Separate Error] ${err.message}` }).catch(() => {});
                console.error("Separation trigger failed:", err);
              }
            };
          }
        }
      } else {
        invoke('remote_js_log', { msg: `[MR Separate Init] menuSeparate is null!` }).catch(() => {});
      }
    });
  }).catch(err => {
    invoke('remote_js_log', { msg: `[Audio Import Error] ${err.message}` }).catch(() => {});
  });

  if (menuPlay) {
    const isCurrent = state.currentTrack && state.currentTrack.path === song.path;
    menuPlay.textContent = (isCurrent && state.isPlaying) ? "일시정지" : "재생";

    menuPlay.onclick = async () => {
      invoke('remote_js_log', { msg: `[Menu Play] Clicked for index ${originalIndex}` }).catch(() => {});
      const { selectTrack, handlePlaybackToggle } = await import('../player.js');
      if (isCurrent) {
        await handlePlaybackToggle();
      } else {
        await selectTrack(originalIndex);
      }
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu Play Init] menuPlay is null!` }).catch(() => {});
  }

  if (menuLyricsView) {
    menuLyricsView.onclick = () => {
      invoke('remote_js_log', { msg: `[Menu LyricsView] Clicked for index ${originalIndex}` }).catch(() => {});
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
      const openLyricDrawer = getAppHandler('openLyricDrawer');
      if (typeof openLyricDrawer === "function") {
        openLyricDrawer();
      } else {
        document.body.classList.add("drawer-open");
      }
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu LyricsView Init] menuLyricsView is null!` }).catch(() => {});
  }

  if (menuEdit) {
    invoke('remote_js_log', { msg: `[Menu Edit Init] Setting onclick handler` }).catch(() => {});
    menuEdit.onclick = async () => {
      invoke('remote_js_log', { msg: `[Menu Edit] Clicked for index ${originalIndex}` }).catch(() => {});
      try {
        const { openEditModal } = await import('./modals.js');
        openEditModal(song, originalIndex);
      } catch (err) {
        invoke('remote_js_log', { msg: `[Menu Edit Error] ${err.message}` }).catch(() => {});
        console.error("[Menu-Edit] Import or call failed:", err);
      }
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu Edit Init] menuEdit is null!` }).catch(() => {});
  }

  if (menuDelete) {
    invoke('remote_js_log', { msg: `[Menu Delete Init] Setting onclick handler` }).catch(() => {});
    menuDelete.onclick = async () => {
      invoke('remote_js_log', { msg: `[Menu Delete] Clicked for index ${originalIndex}` }).catch(() => {});
      try {
        const { deleteSong } = await import('./library.js');
        await deleteSong(originalIndex);
      } catch (err) {
        invoke('remote_js_log', { msg: `[Menu Delete Error] ${err.message}` }).catch(() => {});
        console.error("[Menu-Delete] Import or call failed:", err);
      }
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu Delete Init] menuDelete is null!` }).catch(() => {});
  }
}
const mrPresenceChecked = new Set();

/** 라이브러리 정보에 MR 표시가 없을 때 실제 파일 존재를 뒤늦게 확인한다.
 *  있으면 곡 정보를 갱신하고 배지를 다시 그린다(없으면 그대로 둔다). */
function probeMrPresence(path, song, targetCard) {
  invoke("check_mr_separated", { path })
    .then((separated) => {
      if (!separated) return;
      song.isSeparated = true;
      song.is_separated = true;
      updateCardStatusBadge(path, targetCard);
    })
    .catch(() => {});
}

export function updateCardStatusBadge(path, card = null) {
  const targetCard = card || Array.from(document.querySelectorAll('.song-card')).find(el => el.dataset.path === path);
  if (!targetCard) return;

  const mode = state.viewMode || "grid";
  let parent;
  
  if (mode === "grid") {
    parent = targetCard.querySelector(".thumbnail");
  } else {
    // List and Button modes use the wrapper inside info area
    parent = targetCard.querySelector(".status-badge-wrapper");
  }
  
  if (!parent) return;

  // Clear existing status badges
  const existingBadges = parent.querySelectorAll(".status-badge");
  existingBadges.forEach(b => b.remove());

  // Find song in library for info
  const song = state.songLibrary.find(s => s.path === path);
  
  const badge = document.createElement("div");
  badge.className = "status-badge";

  const activeTask = state.activeTasks[path];
  if (activeTask && activeTask.status !== "Finished") {
    const status = (activeTask.status || "").toLowerCase();
    const isWaiting = status.includes("queued") ||
      status.includes("pending") ||
      status.includes("starting") ||
      status.includes("preparing");

    badge.classList.add(isWaiting ? "pending" : "processing");
    badge.textContent = isWaiting ? "대기중" : "분리중";
  } else if (song && (song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path)) {
    badge.classList.add("mr");
    badge.textContent = "MR";
  } else if (song && !mrPresenceChecked.has(path) && mode !== "list") {
    mrPresenceChecked.add(path);
    probeMrPresence(path, song, targetCard);
    return;
  } else if (mode === "list") {
    // 표 모드는 결과를 기다리지 않고 먼저 '원곡만'을 표시한다 — 기다리면 MR이
    // 없는 곡의 상태 칸이 영구히 빈 칸으로 남는다(probe가 false면 재렌더가 없으므로).
    if (song && !mrPresenceChecked.has(path)) {
      mrPresenceChecked.add(path);
      probeMrPresence(path, song, targetCard);
    }
    // 표 모드에는 '상태' 열이 있어 빈 칸으로 두면 미완성처럼 보인다.
    // 아직 분리하지 않은 곡은 조용한 톤으로 사실만 알린다.
    // (그리드·버튼 모드는 배지를 장식처럼 모든 카드에 반복하지 않도록 그대로 비운다.)
    badge.classList.add("none");
    badge.textContent = "원곡만";
  } else {
    return; // No badge to show
  }

  parent.appendChild(badge);
}

/** Call after MR delete so cards can re-probe cache on next render. */
export function clearMrPresenceCache(path) {
  if (path) mrPresenceChecked.delete(path);
  else mrPresenceChecked.clear();
}

export function updateThumbnailOverlay() {
  const cards = document.querySelectorAll(".song-card");
  cards.forEach(card => {
    const path = card.dataset.path;
    const cardIndex = parseInt(card.dataset.index);
    const isCurrent = state.currentTrack && state.currentTrack.path === path;
    const isPlaying = isCurrent && state.isPlaying;
    const isSelected = state.selectedTrackIndex === cardIndex;
    
    const overlay = card.querySelector(".thumb-overlay");
    if (overlay) {
      overlay.classList.toggle("active", isCurrent);
      overlay.classList.toggle("playing", isPlaying);
      // If this is the currently loading track, show loading state
      const isCurrentlyLoading = isCurrent && state.isLoading;
      overlay.classList.toggle("loading", isCurrentlyLoading);
    }
    
    card.classList.toggle("active", isCurrent);
    card.classList.toggle("selected", isSelected);
  });

  // Also update dock thumb overlay
  if (elements.thumbOverlay) {
    const isCurrent = !!state.currentTrack;
    elements.thumbOverlay.classList.toggle("active", isCurrent);
    elements.thumbOverlay.classList.toggle("playing", isCurrent && state.isPlaying);
    elements.thumbOverlay.classList.toggle("loading", isCurrent && state.isLoading);
  }
}

export async function refreshGpuPackStatus() {
  if (!elements.gpuPackStatus) return;
  try {
    const s = await invoke("get_gpu_pack_status");
    const installed = !!s.installed;
    const installing = !!s.installing;
    elements.gpuPackStatus.textContent = installing ? "설치 중…" : (installed ? "설치됨" : "미설치");
    elements.gpuPackStatus.className = "ai-status-badge " + (installed ? "status-online" : "status-offline");
    if (elements.gpuPackDetail) {
      elements.gpuPackDetail.textContent = installed
        ? s.dir
        : (s.missing && s.missing.length
            ? `빠진 파일 ${s.missing.length}개 (${s.missing.slice(0, 3).join(", ")}${s.missing.length > 3 ? " 외" : ""}) — 위치: ${s.dir}`
            : s.dir);
    }
    // 설치되어 있으면 다운로드 버튼을 "재설치"로, 아니면 "다운로드"로.
    if (elements.btnInstallGpuPack && !installing) {
      elements.btnInstallGpuPack.textContent = installed ? "재설치" : "다운로드";
      elements.btnInstallGpuPack.hidden = false;
    }
    // 다른 창에서 설치가 진행 중인 상태로 재진입한 경우 진행 UI 복원.
    if (installing) {
      if (elements.gpuPackProgress) elements.gpuPackProgress.hidden = false;
      if (elements.btnInstallGpuPack) elements.btnInstallGpuPack.hidden = true;
      if (elements.btnCancelGpuPack) elements.btnCancelGpuPack.hidden = false;
    }
  } catch (err) {
    elements.gpuPackStatus.textContent = "확인 실패";
  }
}

export function updateGpuStatus(provider) {
  if (elements.aiEngineProvider) {
    const pStr = (provider || "").toUpperCase();
    const isGPU = pStr.includes("GPU") || pStr.includes("CUDA") || pStr.includes("DIRECTML");
    elements.aiEngineProvider.textContent = provider || "CPU";
    elements.aiEngineProvider.className = "engine-provider " + (isGPU ? "cuda" : "cpu");
  }
}
