/**
 * js/events/backend.js - Tauri Backend Event Listeners
 */
import { listen } from '../tauri-bridge.js';
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { updateTaskUI, updateAiModelStatus, updateCardStatusBadge, updateAiTogglesState } from '../ui/components.js';
import { renderLibrary } from '../ui/library.js';
import { showNotification } from '../utils.js';
import { invoke } from '../tauri-bridge.js';
import { youtubePathsMatch } from '../youtube-utils.js';
let backendListenersInitialized = false;
let taskUiUpdateScheduled = false;

function formatSeparationFailure(statusText) {
  const raw = String(statusText || "").trim();
  if (!raw) return "분리 실패: 원인을 확인할 수 없습니다.";
  if (raw.includes("모델 로딩 시간 초과")) {
    return `${raw}. 잠시 후 재시도하거나 앱 재시작/모델 재다운로드를 권장합니다.`;
  }
  if (raw.includes("모델 초기화 재시도 대기 중")) {
    return `${raw}. 대기 후 다시 시도해 주세요.`;
  }
  if (raw.includes("YouTube 오디오")) {
    return `${raw}. 네트워크 상태 또는 URL 접근 가능 여부를 확인해 주세요.`;
  }
  return `분리 실패: ${raw}`;
}

function pathMatches(a, b) {
  return youtubePathsMatch(a, b);
}

// ── 다운로드 실패 자동 재시도 ────────────────────────────────────────
// 유튜브 403(Forbidden) 등은 대개 일시적이라(잠시 후 같은 URL이 정상 동작)
// 곧바로 실패로 끝내지 말고 점점 간격을 늘려가며 다시 시도한다. 재시도는
// start_mr_separation을 다시 부르는 방식이라 자연히 대기열 맨 뒤로 밀리고,
// 다른 곡이 없으면 그 곡만 백오프 간격으로 재시도된다.
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000, 900_000]; // 30초 → 2분 → 5분 → 15분
const retryTimers = new Map(); // path -> timeout id
const retryAttempts = new Map(); // path -> 지금까지 시도 횟수

/** 재시도로 풀릴 가능성이 있는(일시적) 실패인지 — 주로 유튜브 다운로드 문제. */
function isRetryableSeparationError(statusText) {
  const s = String(statusText || "");
  return s.includes("YouTube 오디오")
    || s.includes("403")
    || s.includes("Forbidden")
    || s.includes("unable to download")
    || s.includes("Unable to download")
    || s.includes("timed out")
    || s.includes("Temporary failure")
    || s.includes("Connection");
}

export function clearSeparationRetry(path) {
  const t = retryTimers.get(path);
  if (t) clearTimeout(t);
  retryTimers.delete(path);
  retryAttempts.delete(path);
}

/** 실패한 분리를 백오프 후 다시 큐에 넣는다. 재시도를 예약했으면 true. */
function scheduleSeparationRetry(path, statusText) {
  const attempt = retryAttempts.get(path) || 0;
  if (attempt >= RETRY_DELAYS_MS.length) return false;

  const delay = RETRY_DELAYS_MS[attempt];
  const nextAttempt = attempt + 1;
  retryAttempts.set(path, nextAttempt);

  const song = state.songLibrary.find((s) => pathMatches(s.path, path));
  const prev = state.activeTasks[path] || {};
  // 대기 중임을 카드로 계속 보여준다(사라졌다가 나중에 튀어나오면 혼란).
  state.activeTasks[path] = {
    ...prev,
    percentage: 0,
    status: "RetryWaiting",
    retryAttempt: nextAttempt,
    retryMax: RETRY_DELAYS_MS.length,
    retryDelayMs: delay,
    title: prev.title || song?.title || "",
    thumbnail: prev.thumbnail || song?.thumbnail || ""
  };

  const timer = setTimeout(async () => {
    retryTimers.delete(path);
    // 사용자가 그 사이 취소했거나 이미 분리됐으면 재시도하지 않는다.
    if (!state.activeTasks[path] || state.activeTasks[path].status !== "RetryWaiting") return;
    try {
      const done = await invoke("check_mr_separated", { path });
      if (done) { delete state.activeTasks[path]; scheduleTaskUiUpdate(); return; }
    } catch (_) {}
    const { startMrSeparation } = await import('../audio.js');
    startMrSeparation(path, state.activeTasks[path]?.modelId || null)
      .catch((err) => console.warn("[Retry] resume failed:", path, err));
  }, delay);
  retryTimers.set(path, timer);

  const mins = Math.round(delay / 60000);
  const when = delay < 60000 ? `${Math.round(delay / 1000)}초` : `${mins}분`;
  showNotification(
    `${formatSeparationFailure(statusText)} — ${when} 후 자동으로 다시 시도합니다 (${nextAttempt}/${RETRY_DELAYS_MS.length}).`,
    "warning"
  );
  return true;
}

function scheduleTaskUiUpdate() {
  if (taskUiUpdateScheduled) return;
  taskUiUpdateScheduled = true;
  requestAnimationFrame(() => {
    taskUiUpdateScheduled = false;
    updateTaskUI();
  });
}

// 분리 대기열 스냅샷 — 앱을 껐다 켜도(또는 F5) 걸어둔 분리가 남아 있게 한다.
// 분리는 곡당 수 분씩 걸려 도중에 앱을 끄거나 PC를 재시작하는 일이 흔하다.
// (이 상수가 없어 저장/복원이 조용히 실패하고 있었다 — try/catch가 삼킴.)
const ACTIVE_TASKS_SNAPSHOT_KEY = 'separationQueueV1';

function persistActiveTasksSnapshot() {
  try {
    const snapshot = {};
    Object.entries(state.activeTasks || {}).forEach(([path, task]) => {
      snapshot[path] = {
        percentage: Number(task?.percentage || 0),
        status: String(task?.status || "Processing"),
        provider: String(task?.provider || "UNKNOWN"),
        model: String(task?.model || ""),
        // 재시작 후 같은 모델로 다시 걸기 위해 요청 시점의 모델 id를 함께 저장
        // (model은 백엔드가 보내는 표시용 파일명이라 재요청에 쓸 수 없다.)
        modelId: task?.modelId || null,
        title: String(task?.title || ""),
        thumbnail: String(task?.thumbnail || "")
      };
    });
    if (Object.keys(snapshot).length === 0) localStorage.removeItem(ACTIVE_TASKS_SNAPSHOT_KEY);
    else localStorage.setItem(ACTIVE_TASKS_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn("[Backend] persist separation snapshot failed:", err);
  }
}

function readActiveTasksSnapshot() {
  try {
    const raw = localStorage.getItem(ACTIVE_TASKS_SNAPSHOT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

export async function setupBackendListeners() {
  if (backendListenersInitialized) return;
  backendListenersInitialized = true;

  // Playback Progress Update
  await listen('playback-progress', (event) => {
    if (!state.isSeeking) {
      // Rust struct may serialize to CamelCase or snake_case depending on serde config.
      const positionMs = event.payload.positionMs ?? event.payload.position_ms ?? 0;
      const durationMs = event.payload.durationMs ?? event.payload.duration_ms ?? 0;

      state.targetProgressMs = positionMs;
      // Ensure duration is always updated if available
      if (durationMs > 0 || !state.trackDurationMs) {
        state.trackDurationMs = durationMs;
      }
    }
  });

  // Playback Status & Auto-Next
  await listen('playback-status', async (event) => {
    const { status, message } = event.payload;
    const s = (status || "").toLowerCase();

    // 1. Loading state
    if (["loading", "downloading", "decoding", "pending"].includes(s)) {
      state.isLoading = true;
    } else {
      state.isLoading = false;
    }

    // 2. Playback state
    if (s === "playing") {
      state.isPlaying = true;
      // Self-heal overlay state sync in case a prior invoke was dropped.
      invoke('update_overlay_state', {
        title: state.currentTrack?.title || "",
        artist: state.currentTrack?.artist || "",
        thumbnail: state.currentTrack?.thumbnail || "",
        isPlaying: true,
        songKey: state.currentTrack?.songKey || state.currentTrack?.song_key || "",
        bpm: Number(state.currentTrack?.bpm) || 0
      }).catch(() => {});
      const { updateProgressBar } = await import('../player.js');
      if (!state.rafId) {
        state.lastRafTime = performance.now();
        state.rafId = requestAnimationFrame(updateProgressBar);
      }
    } else if (["finished", "error", "paused", "stopped"].includes(s)) {
      // Ignore finished/paused during seek to prevent snapback
      if (state.isSeeking && (s === "finished" || s === "paused")) return;

      state.isPlaying = false;
      state.rafId = null;

      if (s === "finished") {
        state.currentProgressMs = 0;
        state.targetProgressMs = 0;

        // Reload track in paused state at 0:00 so it can be replayed
        const { playTrack } = await import('../audio.js');
        await playTrack(state.currentTrack.path, state.trackDurationMs, false);

        // Force UI reset to 0:00
        const { elements } = await import('../ui/elements.js');
        if (elements.playbackBar) elements.playbackBar.value = 0;
        if (elements.progressFill) elements.progressFill.style.width = "0%";
        if (elements.timeCurrent) elements.timeCurrent.textContent = "0:00";

        const { syncPlaybackUI } = await import('../ui/playback-sync.js');
        syncPlaybackUI();
      }
      if (s === "error" && message) {
        showNotification(`재생 오류: ${message}`, "error");
      }

      // Sync overlay state on stop/finish/error
      const { invoke } = await import('../tauri-bridge.js');
      invoke('update_overlay_state', {
        title: state.currentTrack?.title || "",
        artist: state.currentTrack?.artist || "",
        thumbnail: state.currentTrack?.thumbnail || "",
        isPlaying: false,
        songKey: state.currentTrack?.songKey || state.currentTrack?.song_key || "",
        bpm: Number(state.currentTrack?.bpm) || 0
      }).catch(err => console.error("Overlay sync failed:", err));
    }

    // 3. Status Message in Dock (Removed text as per user request)
    const { elements } = await import('../ui/elements.js');
    if (elements.statusMsg) {
      elements.statusMsg.textContent = "";
    }

    const { syncPlaybackUI } = await import('../ui/playback-sync.js');
    syncPlaybackUI();
  });

  // MR Separation Progress (Unified Listener)
  await listen('separation-progress', (event) => {
    const { path, percentage, status, provider, model } = event.payload;
    const s = (status || "").toLowerCase();
    const isFinished = s === "finished";
    const isCancelled = s === "cancelled" || s.includes("cancel");
    const isError = s === "error" || s.startsWith("error:");

    // 일시적 다운로드 실패는 끝으로 보지 않고 백오프 후 다시 큐에 넣는다.
    if (isError && isRetryableSeparationError(status)) {
      if (scheduleSeparationRetry(path, status)) {
        persistActiveTasksSnapshot();
        scheduleTaskUiUpdate();
        updateCardStatusBadge(path);
        return;
      }
      // 재시도 횟수를 모두 소진 — 아래 일반 오류 처리로 진행
    }

    if (isFinished || isCancelled || isError) {
      clearSeparationRetry(path);
      delete state.activeTasks[path];

      if (isFinished) {
        showNotification("MR 분리가 완료되었습니다.", "success");
        // Update local state flag (exact path + equivalent YouTube URL variants).
        state.songLibrary.forEach((song) => {
          if (!pathMatches(song.path, path)) return;
          song.isSeparated = true;
          song.is_separated = true;
          song.isMr = true;
          song.is_mr = true;
        });

        // 분리 완료 후 키/BPM 자동 분석 — 분석은 분리된 반주(inst)를 쓰므로
        // 이 시점이 가장 정확. 이미 값이 있으면 건드리지 않는다.
        const analyzed = state.songLibrary.find((song) => pathMatches(song.path, path));
        if (analyzed && !(analyzed.songKey || analyzed.song_key) && !analyzed.bpm) {
          invoke('analyze_key_bpm', { path: analyzed.path }).then(async (res) => {
            if (!res) return;
            if (res.key) { analyzed.songKey = res.key; analyzed.song_key = res.key; }
            if (res.bpm != null && Number.isFinite(res.bpm)) analyzed.bpm = Math.round(res.bpm);
            if (res.key || res.bpm) {
              const { saveLibrary } = await import('../audio.js');
              await saveLibrary(state.songLibrary);
              renderLibrary();
            }
          }).catch((err) => console.warn('[KeyBpm] auto analyze failed:', err));
        }
        if (state.currentTrack && pathMatches(state.currentTrack.path, path)) {
          state.currentTrack.isSeparated = true;
          state.currentTrack.is_separated = true;
          state.currentTrack.isMr = true;
          state.currentTrack.is_mr = true;
          updateAiTogglesState(state.currentTrack);
        }
      } else if (isError) {
        showNotification(formatSeparationFailure(status), "error");
      }

      // 노래 추가에서 "분리 후 정렬"로 미뤄둔 곡이면 이제 정렬 대기열에 등록
      // (완료뿐 아니라 오류/취소로 끝나도 — 가사는 저장돼 있고 원본으로도
      // 정렬은 가능하므로 요청을 버리지 않는다).
      import('../alignment-queue.js')
        .then((m) => m.onSeparationTerminated(path, pathMatches))
        .catch(() => {});

      // Refresh library badges for all termination states (finished, cancelled, error)
      renderLibrary();
    } else {
      // Update or Add Task
      state.activeTasks[path] = {
        ...state.activeTasks[path],
        percentage,
        status,
        provider,
        model
      };
    }

    persistActiveTasksSnapshot();
    scheduleTaskUiUpdate();

    // Also update the badge on the library card if it's visible
    updateCardStatusBadge(path);
  });

  // AI Model Status Updates
  await listen('ai_model_status_update', (event) => {
    updateAiModelStatus(event.payload);
  });

  // Model download percentage updates for settings button
  await listen('model-download-progress', (event) => {
    const percentage = Math.round(event.payload);
    if (elements.btnDownloadModel) {
      elements.btnDownloadModel.disabled = true;
      elements.btnDownloadModel.textContent = `다운로드 중 (${percentage}%)`;
      if (percentage >= 100) {
        setTimeout(() => {
          if (elements.btnDownloadModel) {
            elements.btnDownloadModel.disabled = false;
            elements.btnDownloadModel.textContent = "모델 다운로드";
          }
        }, 1500);
      }
    }
  });

  // File Drag & Drop support — 즉시 추가 대신 "노래 추가" 원스톱 모달을
  // 파일이 미리 채워진 상태로 연다(곡 정보/MR 분리/가사 정렬까지 한 번에).
  await listen("tauri://drag-drop", async (event) => {
    const paths = event.payload.paths;
    if (!paths || paths.length === 0) return;
    const audioPaths = paths.filter((path) =>
      ["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma"].includes(path.split('.').pop().toLowerCase())
    );
    if (audioPaths.length === 0) return;
    const { openAddSongModal } = await import('../ui/add-song-modal.js');
    openAddSongModal(audioPaths);
  });

  // 분리 대기열 복원 — 두 경우를 모두 다룬다:
  //  1) F5 새로고침: 백엔드는 살아 있어 get_active_separations가 경로를 준다
  //     → 카드만 복원(진행률은 곧 오는 이벤트가 채움).
  //  2) 앱 재시작: 백엔드 메모리가 비어 있어 목록이 없다 → 저장해둔 항목을
  //     같은 모델로 다시 큐에 넣어 이어서 처리한다(이미 분리된 곡은 건너뜀).
  try {
    const activePaths = await invoke("get_active_separations");
    const running = Array.isArray(activePaths) ? activePaths.filter(Boolean) : [];
    const snapshot = readActiveTasksSnapshot();

    running.forEach((path) => {
      if (state.activeTasks[path]) return;
      const song = state.songLibrary.find((s) => s.path === path);
      const saved = snapshot[path] || {};
      state.activeTasks[path] = {
        percentage: Number(saved.percentage || 0),
        status: String(saved.status || "Processing"),
        provider: String(saved.provider || "UNKNOWN"),
        model: String(saved.model || ""),
        modelId: saved.modelId || null,
        title: song?.title || saved.title || "알 수 없는 곡",
        thumbnail: song?.thumbnail || saved.thumbnail || ""
      };
    });

    // 저장돼 있는데 백엔드가 돌고 있지 않은 항목 = 지난 실행에서 끊긴 작업
    const leftovers = Object.keys(snapshot).filter((p) => p && !running.includes(p));
    for (const path of leftovers) {
      try {
        const alreadyDone = await invoke("check_mr_separated", { path });
        if (alreadyDone) continue; // 끊기기 전에 완료된 곡 — 다시 돌릴 필요 없음
      } catch (_) { /* 확인 실패 시엔 아래에서 재시도 */ }
      const saved = snapshot[path] || {};
      const { startMrSeparation } = await import('../audio.js');
      startMrSeparation(path, saved.modelId || null).catch((err) => {
        console.warn("[Backend] Failed to resume separation:", path, err);
      });
    }

    if (running.length > 0 || leftovers.length > 0) {
      persistActiveTasksSnapshot();
      scheduleTaskUiUpdate();
      running.forEach((path) => updateCardStatusBadge(path));
      if (leftovers.length > 0) {
        showNotification(`이전에 진행 중이던 MR 분리 ${leftovers.length}곡을 이어서 처리합니다.`, "info");
      }
    }
  } catch (err) {
    console.warn("[Backend] Failed to recover separation queue:", err);
  }

  // 정렬 대기열도 같은 이유로 복원 + 이어서 처리
  try {
    const { restoreAlignmentQueue } = await import('../alignment-queue.js');
    const restored = restoreAlignmentQueue();
    if (restored > 0) {
      showNotification(`이전에 대기 중이던 AI 가사 정렬 ${restored}곡을 이어서 처리합니다.`, "info");
    }
  } catch (err) {
    console.warn("[Backend] Failed to restore alignment queue:", err);
  }
}
