/**
 * audio.js - Backend command wrappers for Audio Engine
 */

import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';
import { playbackService } from '../ipc/services/playback.js';
import { libraryService } from '../ipc/services/library.js';

export async function setVolume(volume) {
  try {
    // Explicitly send as number (f64 on backend)
    await invoke("set_volume", { volume: parseFloat(volume) });
  } catch (err) {
    console.error("Failed to set volume:", err);
  }
}

export async function setPitch(semitones) {
  try {
    await invoke("set_pitch", { semitones: parseFloat(semitones) });
  } catch (err) {
    console.error("Failed to set pitch:", err);
  }
}

export async function setTempo(ratio) {
  try {
    await invoke("set_tempo", { ratio: parseFloat(ratio) });
  } catch (err) {
    console.error("Failed to set tempo:", err);
  }
}

export async function togglePlayback() {
  try {
    return await playbackService.toggle();
  } catch (err) {
    console.error("Toggle playback failed:", err);
    showNotification("재생 제어 실패", "error");
    throw err;
  }
}

export async function stopPlayback() {
  try {
    await playbackService.stop();
  } catch (err) {
    console.error("Stop playback failed:", err);
    throw err;
  }
}

export async function seekTo(positionMs) {
  try {
    await playbackService.seek(positionMs);
  } catch (err) {
    console.error("Seek failed:", err);
  }
}

export async function playTrack(path, duration_ms = 0, playNow = true) {
  try {
    // play_track in backend emits events for progress/status
    await playbackService.play(path, duration_ms, playNow);
  } catch (err) {
    console.error("Play track failed:", err);
    throw err;
  }
}

export async function loadLibrary() {
  return await libraryService.load();
}

export async function saveLibrary(songs) {
  // Backend expects { songs: Vec<SongMetadata> }
  return await libraryService.save(songs);
}

export async function checkAiModelStatus() {
  try {
    const modelId = await invoke("get_model_settings");
    return await invoke("check_model_ready", { modelId: modelId });
  } catch (err) {
    console.error("AI Model check failed:", err);
    return false;
  }
}

export async function deleteSongFromDb(path) {
  try {
    await libraryService.delete(path);
  } catch (err) {
    console.error("Failed to delete song from DB:", err);
    throw err;
  }
}

export async function checkMrSeparated(path) {
  return await invoke("check_mr_separated", { path });
}

export async function deleteMr(path) {
  try {
    await invoke("delete_mr", { path });
  } catch (err) {
    console.error("Failed to delete MR:", err);
    throw err;
  }
}

export async function getYoutubeMetadata(url) {
  return await invoke("youtube_metadata_fetcher", { url });
}

export async function getAudioMetadata(path) {
  return await invoke("get_audio_metadata", { path });
}

export async function setVocalBalance(balance) {
  try {
    await invoke("set_vocal_balance", { balance: parseFloat(balance) });
  } catch (err) {
    console.error("Failed to set balance:", err);
  }
}
export async function startMrSeparation(path, modelId = null, harmonyModelId = null, options = {}) {
  // 분리와 정렬을 함께 요청한 모든 화면은 이 진입점을 사용한다. 정렬 예약을
  // 백엔드 작업보다 먼저 등록해야 아주 짧은 작업/기존 캐시 재사용 때 완료
  // 이벤트가 먼저 지나가 정렬이 영원히 시작되지 않는 경쟁 조건이 없다.
  let alignmentDeferred = false;
  if (options?.alignAfterSeparation === true) {
    const { ensureAlignmentModelsReady, deferAlignmentUntilSeparated } =
      await import('./alignment-queue.js');
    const ready = await ensureAlignmentModelsReady();
    if (ready) {
      deferAlignmentUntilSeparated(path);
      alignmentDeferred = true;
    }
  }
  // 1. 즉시 준비 상태 등록 (백엔드 이벤트 도달 전)
  const { state } = await import('./state.js');
  const { renderLibrary } = await import('./ui/library.js');
  // modelId를 함께 남긴다 — 앱 재시작 후 대기열을 복원할 때 같은 모델로
  // 다시 걸어야 하기 때문(백엔드 진행률 이벤트의 model은 표시용 파일명).
  const song = state.songLibrary.find((s) => s.path === path);
  state.activeTasks[path] = {
    percentage: 0, status: "Preparing", provider: "local", modelId: modelId || null,
    harmonyModelId: harmonyModelId || null,
    title: song?.title || "", thumbnail: song?.thumbnail || ""
  };
  renderLibrary(); // 배지 즉시 반영

  try {
    // modelId: 분리 방식 선택 모달에서 고른 곡별 모델 (null이면 전역 기본값)
    const result = await invoke("start_mr_separation", { path, modelId, harmonyModelId });
    return { result, alignmentDeferred };
  } catch (err) {
    // 실패 시 activeTasks 정리
    delete state.activeTasks[path];
    renderLibrary();
    if (alignmentDeferred && err !== "ALREADY_PROCESSING") {
      const { cancelDeferredAlignment } = await import('./alignment-queue.js');
      cancelDeferredAlignment(path);
    }
    if (err === "ALREADY_PROCESSING") {
      showNotification("이미 대기열에 있거나 처리 중인 곡입니다.", "warning");
      return;
    }
    console.error("Separation failed:", err);
    showNotification("MR 분리 실패: " + err, "error");
    throw err;
  }
}

export async function cancelSeparation(path) {
  // 재시도 대기 중이던 곡이면 예약된 타이머부터 취소한다 — 안 그러면
  // 취소해놓고도 백오프 시간이 지나면 되살아난다.
  try {
    const { clearSeparationRetry } = await import('./events/backend.js');
    clearSeparationRetry(path);
    const { state } = await import('./state.js');
    if (state.activeTasks[path]?.status === "RetryWaiting") {
      delete state.activeTasks[path];
      const { updateTaskUI } = await import('./ui/components.js');
      updateTaskUI();
    }
  } catch (_) {}
  try {
    return await invoke("cancel_separation", { path });
  } catch (err) {
    console.error("Cancel separation failed:", err);
  }
}

export async function toggleAiFeature(feature, enabled) {
  try {
    return await invoke("toggle_ai_feature", { feature, enabled });
  } catch (err) {
    console.error("Toggle AI feature failed:", err);
  }
}

export async function setMasterVolume(volume) {
  try {
    await invoke("set_master_volume", { volume: parseFloat(volume) });
  } catch (err) {
    console.error("Failed to set master volume:", err);
  }
}
