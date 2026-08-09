/**
 * player.js - Playback Logic and Progress Tracking
 */

import { state } from './state.js';
import { elements } from './ui/elements.js';
import { updateThumbnailOverlay, updatePlayButton, updateAiTogglesState } from './ui/components.js';
import { formatTime, showNotification, getThumbnailUrl } from './utils.js';
import {
  togglePlayback as apiTogglePlayback, playTrack as apiPlayTrack,
  setVolume, setPitch, setTempo, saveLibrary, seekTo, checkMrSeparated,
  stopPlayback as apiStopPlayback
} from './audio.js';
import { loadLyricsForTrack, loadLyricsAndMarkers } from './lyrics.js';
import { emit, invoke, convertFileSrc as bridgeConvertFileSrc } from './tauri-bridge.js';

function isYoutubePath(path) {
  if (!path || typeof path !== "string") return false;
  const p = path.trim().toLowerCase();
  return p.startsWith("http") && (p.includes("youtube.com") || p.includes("youtu.be"));
}

function songNeedsMetadataEnrichment(song) {
  if (!song) return false;
  const duration = (song.duration || "").trim();
  return !song.thumbnail?.trim() || !duration || duration === "0:00";
}

/** CSV 등 최소 정보만 있는 곡 — 재생 시 유튜브 메타데이터를 보강 (제목·아티스트는 유지) */
async function enrichSongMetadataIfNeeded(song) {
  if (!isYoutubePath(song?.path) || !songNeedsMetadataEnrichment(song)) return;

  try {
    const { getYoutubeMetadata, saveLibrary } = await import('./audio.js');
    const meta = await getYoutubeMetadata(song.path);
    if (!meta) return;

    if (!song.thumbnail?.trim() && meta.thumbnail) song.thumbnail = meta.thumbnail;
    const duration = (song.duration || "").trim();
    if ((!duration || duration === "0:00") && meta.duration) song.duration = meta.duration;
    if (!song.artist?.trim() && meta.artist) song.artist = meta.artist;
    if (!song.originalUrl?.trim() && !song.original_url?.trim()) {
      song.originalUrl = song.path;
      song.original_url = song.path;
    }

    await saveLibrary(state.songLibrary);

    if (state.currentTrack?.path !== song.path) return;

    if (elements.dockThumbImg && song.thumbnail) {
      elements.dockThumbImg.src = getThumbnailUrl(song.thumbnail, song);
    }
    const enrichedDurationMs = parseDurationToMs(song.duration);
    if (enrichedDurationMs > 0) {
      state.trackDurationMs = enrichedDurationMs;
      if (elements.timeTotal) elements.timeTotal.textContent = song.duration;
    }
    if (elements.dockArtist && song.artist) {
      elements.dockArtist.textContent = song.artist;
    }
    updateThumbnailOverlay();
    const { renderLibrary } = await import('./ui/library.js');
    renderLibrary();
  } catch (err) {
    console.warn("[Metadata] enrichment skipped:", err);
  }
}

function parseDurationToMs(duration) {
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    return Math.floor(duration * 1000);
  }
  if (typeof duration !== "string") return 0;

  const trimmed = duration.trim();
  if (!trimmed) return 0;

  const parts = trimmed.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p) || p < 0)) return 0;

  if (parts.length === 2) {
    const [mm, ss] = parts;
    return ((mm * 60) + ss) * 1000;
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = parts;
    return ((hh * 3600) + (mm * 60) + ss) * 1000;
  }

  return 0;
}

/**
 * Highlights a track without playing it (internal use)
 */
function highlightTrack(index) {
  if (index < 0 || index >= state.songLibrary.length) return;

  // Toggle Selection
  if (state.selectedTrackIndex === index) {
    state.selectedTrackIndex = -1;
  } else {
    state.selectedTrackIndex = index;
  }

  updateThumbnailOverlay();

  // Update AI toggles state for highlight
  const song = state.selectedTrackIndex !== -1 ? state.songLibrary[state.selectedTrackIndex] : null;
  updateAiTogglesState(song);
}

export async function stopPlayback() {
  try {
    await apiStopPlayback();
    state.isPlaying = false;
    state.isLoading = false;
    state.currentTrack = null;
    state.currentProgressMs = 0;
    state.targetProgressMs = 0;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    updateThumbnailOverlay();
    updatePlayButton();
    emit('playback-stop', {});
    invoke('update_overlay_state', {
      title: "",
      artist: "",
      thumbnail: "",
      isPlaying: false,
      songKey: state.currentTrack?.songKey || state.currentTrack?.song_key || "",
      bpm: Number(state.currentTrack?.bpm) || 0
    });
  } catch (error) {
    console.error("Stop playback failed:", error);
    throw error;
  }
}

export async function handlePlaybackToggle() {
  if (!state.currentTrack) {
    showNotification("재생할 곡이 선택되지 않았습니다.", "info");
    return;
  }
  try {
    const newIsPlaying = await apiTogglePlayback();
    state.isPlaying = newIsPlaying;
    state.isLoading = false;
    updateThumbnailOverlay();
    updatePlayButton();

    if (state.isPlaying) {
      if (state.currentTrack) {
        emit('track-change', {
          title: state.currentTrack.title,
          artist: state.currentTrack.artist,
          thumbnail: state.currentTrack.thumbnail
        });
        invoke('update_overlay_state', {
          title: state.currentTrack.title,
          artist: state.currentTrack.artist,
          thumbnail: state.currentTrack.thumbnail,
          isPlaying: true,
          songKey: state.currentTrack?.songKey || state.currentTrack?.song_key || "",
          bpm: Number(state.currentTrack?.bpm) || 0
        });
      }
      if (!state.rafId) {
        state.lastRafTime = performance.now();
        state.rafId = requestAnimationFrame(updateProgressBar);
      }
    } else {
      emit('playback-stop', {});
      invoke('update_overlay_state', {
        title: state.currentTrack?.title || "",
        artist: state.currentTrack?.artist || "",
        thumbnail: state.currentTrack?.thumbnail || "",
        isPlaying: false,
        songKey: state.currentTrack?.songKey || state.currentTrack?.song_key || "",
        bpm: Number(state.currentTrack?.bpm) || 0
      });
    }
  } catch (error) {
    console.error("Playback toggle failed:", error);
  }
}

export async function selectTrack(index) {
  // Increment sequence for every new request
  const mySequence = ++state.playbackSequence;

  // Guard against invalid index or empty library
  if (typeof index !== 'number' || index < 0 || index >= state.songLibrary.length) {
    console.error(`Invalid track index: ${index}`);
    state.isLoading = false;
    updateThumbnailOverlay();
    return;
  }

  const song = state.songLibrary[index];
  if (!song) {
    state.isLoading = false;
    updateThumbnailOverlay();
    return;
  }

  if (state.currentTrack && state.currentTrack.path === song.path) {
    if (state.isLoading) state.isLoading = false;
    // Always toggle (play/pause) if clicking the already current track
    handlePlaybackToggle();
    return;
  }

  console.log(`[UI] Selecting track: ${song.title}`);

  // CSV 등으로 최소 정보만 등록된 곡 — 재생과 병렬로 메타데이터 보강
  enrichSongMetadataIfNeeded(song);

  // Sync Selection Highlight immediately (Remove 2-step barrier)
  state.selectedTrackIndex = index;

  // Update State
  song.playCount = (song.playCount || 0) + 1;
  state.currentTrack = song;
  state.isPlaying = false;
  state.isLoading = true;
  state.targetProgressMs = 0;
  state.currentProgressMs = 0;

  // 가사 싱크 탭이 열려있는 동안은 재생곡이 바뀔 때마다 자동으로 따라가서 로드.
  // (탭 안의 "음원 선택" 모달로 고른 트랙은 이 경로를 안 타므로 서로 충돌하지 않음 —
  // 그건 alignment-viewer.js의 loadAudio()가 play_track을 playNow:false로 호출하는
  // 별도 편집용 로드라, 실제 재생 시작인 여기와는 분리되어 있음.)
  if (state.activeView === 'alignment') {
    import('./events/navigation.js').then(({ alignmentViewer }) => {
      if (alignmentViewer && alignmentViewer.state.currentPath !== song.path) {
        alignmentViewer.loadAudio(song.path);
        const nameEl = document.getElementById('selected-track-name');
        if (nameEl) nameEl.innerText = song.title || 'Unknown Title';
      }
    }).catch((err) => console.error('[Player] Failed to auto-follow alignment tab:', err));
  }

  // 새 곡의 가사가 도착하기 전까지 이전 곡의 가사·마커를 들고 있으면 안 된다.
  //
  // 가사 로드는 비동기라 곡이 바뀐 직후 수백 ms 동안 옛 데이터가 살아 있었고,
  // 그동안 syncLyricsWithTime이 새 곡의 재생 시간을 옛 가사에 대고 맞췄다 —
  // 오버레이와 라이브 가사창에 엉뚱한 줄이 떴다. 로드가 실패하면(.catch가
  // 없었다) 그 상태가 곡이 끝날 때까지 유지됐고, 옛 마커의 vocalStartSec이
  // 남아 있으면 isInInstrumental이 계속 참이라 오버레이가 아예 비어 보였다.
  state.currentLyrics = [];
  state.currentMarkers = { vocalStartSec: null, interludes: [] };
  state.currentLyricIndex = -1;
  import('./lyric-drawer.js').then((m) => m.updateLyrics?.([])).catch(() => {});

  // Load Lyrics for the selected track
  // Guarded by mySequence: if the user switches tracks again before this
  // resolves, applying it here would overwrite the newer track's lyrics
  // with the previous song's (a stale response arriving after a later one).
  loadLyricsAndMarkers(song.path, parseDurationToMs(song.duration) / 1000).then(({ segments, markers }) => {
    if (mySequence !== state.playbackSequence) return;
    state.currentLyrics = segments;
    // 전주·간주에서 오버레이를 비우려면 마커도 함께 들고 있어야 한다.
    state.currentMarkers = markers;
    state.currentLyricIndex = -1;
    // Trigger drawer update if it's initialized
    import('./lyric-drawer.js').then(m => {
      if (m.updateLyrics) m.updateLyrics(segments);
      if (m.syncLyricDrawerHeader) m.syncLyricDrawerHeader();
    });
  }).catch((err) => {
    console.error('[Player] 가사·마커 로드 실패:', err);
    // 위에서 이미 비워 뒀으므로 옛 가사가 남지는 않는다. 화면만 정리한다.
    if (mySequence !== state.playbackSequence) return;
    import('./lyric-drawer.js').then((m) => m.syncLyricDrawerHeader?.()).catch(() => {});
  });

  const durationHintMs = parseDurationToMs(song.duration);
  if (durationHintMs > 0) {
    state.trackDurationMs = durationHintMs;
  }

  // Sync UI immediately - dock metadata
  if (elements.dockTitle) elements.dockTitle.textContent = song.title;
  if (elements.dockArtist) elements.dockArtist.textContent = song.artist || "Unknown Artist";
  if (elements.dockThumbImg) {
    elements.dockThumbImg.src = getThumbnailUrl(song.thumbnail, song);
    elements.dockThumbImg.style.display = "block";
  }

  // Update dock progress bar immediately
  if (elements.timeTotal) elements.timeTotal.textContent = song.duration || "--:--";
  if (elements.timeCurrent) elements.timeCurrent.textContent = "0:00";
  if (elements.playbackBar) elements.playbackBar.value = 0;
  if (elements.progressFill) elements.progressFill.style.width = "0%";

  updateThumbnailOverlay();
  updatePlayButton();

  // MR이 있는 경우 보컬 토글을 자동으로 꺼짐으로 설정 (요구사항)
  // Guarded: a slow checkMrSeparated() for a track the user has already
  // navigated away from must not flip vocalEnabled for the now-current one.
  const mrSeparated = await checkMrSeparated(song.path);
  if (mySequence !== state.playbackSequence) return;
  if (mrSeparated) {
    state.vocalEnabled = false;
  }

  updateAiTogglesState(song);

  // Start progress bar animation immediately for loading state
  if (!state.rafId) {
    state.lastRafTime = performance.now();
    state.rafId = requestAnimationFrame(updateProgressBar);
  }

  if (elements.playbackBar) elements.playbackBar.value = 0;
  if (elements.progressFill) elements.progressFill.style.width = "0%";
  if (elements.timeCurrent) elements.timeCurrent.textContent = "0:00";
  if (elements.timeTotal) elements.timeTotal.textContent = song.duration || "--:--";

  // Apply Settings
  const p = song.pitch || 0;
  const t = song.tempo || 1.0;
  const v = song.volume || 80;

  if (elements.pitchSlider) {
    elements.pitchSlider.value = p;
    elements.pitchVal.textContent = p > 0 ? `+${p}` : p;
  }
  if (elements.tempoSlider) {
    elements.tempoSlider.value = t;
    elements.tempoVal.textContent = `${parseFloat(t).toFixed(2)}x`;
  }
  // Track volume should only sync with metadata modal slider, not master volume slider.
  const editVolSlider = document.getElementById("edit-volume");
  const editVolVal = document.getElementById("edit-volume-val");
  if (editVolSlider) editVolSlider.value = v;
  if (editVolVal) editVolVal.textContent = `${Math.round(v)}`;

  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }

  // Safety timeout: If it takes more than 30s (for slow YT downloads), force loading off
  let loadingTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    loadingTimeout = setTimeout(() => reject(new Error("Playback timed out after 30s")), 30000);
  });

  try {
    // Initial Sync: 피치, 템포 및 보컬 활성화 상태 강제 동기화
    await setPitch(p);
    await setTempo(t);
    const { toggleAiFeature } = await import('./audio.js');
    await toggleAiFeature("vocal", state.vocalEnabled);
    await setVolume(v);

    await Promise.race([
      apiPlayTrack(song.path, durationHintMs > 0 ? durationHintMs : state.trackDurationMs),
      timeoutPromise
    ]);

    state.isPlaying = true;
    console.log("[UI] Playback started successfully.");

    // 인트로 자동 건너뛰기: 가사 싱크 탭에서 지정해둔 마커 기준으로 자동
    // 탐색(유튜브 뮤비형 인트로 등). 보컬 시작 전에 간주(전주)가 마킹돼
    // 있으면 전주가 잘리지 않게 그 간주의 시작(음악 시작)으로만 점프한다.
    // 마커가 없는 곡(대다수)은 조회 결과가 null이라 평소처럼 처음부터 재생됨.
    // 사소한 지점(3초 미만)은 건너뛸 실익이 없어 무시.
    const introSkipEnabled = localStorage.getItem('introSkipEnabled') !== 'false';
    if (introSkipEnabled) {
      import('./lyrics.js').then(({ getIntroSkipTarget }) => getIntroSkipTarget(song.path)).then((targetSec) => {
        if (mySequence !== state.playbackSequence) return; // 트랙이 이미 바뀜
        if (typeof targetSec === 'number' && targetSec > 3) {
          seekTo(targetSec * 1000);
        }
      }).catch((err) => console.error('[Player] Intro-skip marker lookup failed:', err));
    }

    emit('track-change', {
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail
    });

    invoke('update_overlay_state', {
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail,
      isPlaying: true,
      songKey: state.currentTrack?.songKey || state.currentTrack?.song_key || "",
      bpm: Number(state.currentTrack?.bpm) || 0
    });

    state.lastRafTime = performance.now();
    if (!state.rafId) {
      state.rafId = requestAnimationFrame(updateProgressBar);
    }

    saveLibrary(state.songLibrary);
  } catch (err) {
    console.error("Playback failed:", err);
    state.isPlaying = false;
    const detail = typeof err === "string"
      ? err
      : (err?.message || err?.toString?.() || "알 수 없는 오류");
    showNotification(`재생에 실패했습니다: ${detail}`, "error");
  } finally {
    clearTimeout(loadingTimeout);
    // Only reset isLoading if this is still the latest request
    if (mySequence === state.playbackSequence) {
      state.isLoading = false;
      updateThumbnailOverlay();
      updatePlayButton();
    }
  }
}

/** 가사 줄 판정 함수. 프레임마다 동적 import 프라미스를 만들지 않도록
 *  한 번만 붙잡아 둔다(60fps로 도는 자리다). */
let lyricSync = null;
let lyricClock = null;
import('./lyric-drawer.js')
  .then((m) => {
    lyricSync = m.syncLyricsAtPosition;
    lyricClock = m.getPlaybackClockMs;
  })
  .catch(() => {});

export function updateProgressBar(timestamp) {
  if (!state.isPlaying && !state.isLoading) {
    state.rafId = null;
    return;
  }

  const delta = timestamp - state.lastRafTime;
  state.lastRafTime = timestamp;

  const diff = state.targetProgressMs - state.currentProgressMs;
  if (Math.abs(diff) > 2000) {
    state.currentProgressMs = state.targetProgressMs;
  } else {
    const tempo = (elements.tempoSlider) ? parseFloat(elements.tempoSlider.value) : 1.0;
    state.currentProgressMs += delta * tempo;

    // Catch forward/backward drift
    if (state.targetProgressMs > 0) {
      if (state.currentProgressMs > state.targetProgressMs + 500) state.currentProgressMs = state.targetProgressMs + 500;
      if (state.currentProgressMs < state.targetProgressMs - 500) state.currentProgressMs = state.targetProgressMs - 500;
    }
  }

  if (!state.isSeeking && elements.playbackBar) {
    let progressVal = (state.currentProgressMs / state.trackDurationMs) * 100;
    if (isNaN(progressVal) || !isFinite(progressVal)) progressVal = 0;
    if (progressVal > 100) progressVal = 100;

    elements.playbackBar.value = progressVal;
    elements.progressFill.style.width = `${progressVal}%`;
    elements.timeCurrent.textContent = formatTime(state.currentProgressMs / 1000);
    elements.timeTotal.textContent = formatTime(state.trackDurationMs / 1000);
  }

  // 가사 줄 판정을 여기서 돌린다.
  //
  // 예전에는 백엔드의 playback-progress(100ms 폴링)에만 물려 있어서 줄 전환이
  // 100ms 계단이었다 — 평균 50ms, 최악 100ms 늦게 바뀐다. currentProgressMs는
  // 바로 위에서 tempo까지 반영해 프레임 단위로 보간한 값이므로, 이걸 쓰면
  // 줄 전환이 프레임 정확도로 올라간다.
  //
  // 오버레이로 나가는 IPC는 늘지 않는다 — syncLyricsWithTime은 현재/다음 줄
  // 텍스트가 바뀔 때만 update_overlay_lyrics를 부른다(내부 dedupe).
  // 위치 패킷(update_overlay_progress)은 지금처럼 100ms 이벤트에서만 보낸다.
  // 가사 줄 판정도 오버레이와 같은 시계로 한다.
  //
  // currentProgressMs는 tempo로 더해 나가다 ±500ms를 벗어날 때만 되돌리는
  // 값이라, 오버레이 시계와 최대 0.5초까지 벌어진다 — 같은 계산을 써도 줄이
  // 바뀌는 순간이 두 화면에서 달랐다. 진행바·남은 시간은 지금처럼
  // currentProgressMs를 그대로 쓴다(사용자에게 보이는 재생 위치는 하나여야 한다).
  if (!state.isSeeking && lyricSync) {
    lyricSync(lyricClock ? (lyricClock() ?? state.currentProgressMs) : state.currentProgressMs);
  }

  if (state.isPlaying || state.isLoading) {
    state.rafId = requestAnimationFrame(updateProgressBar);
  }
}

export function handleNextTrack() {
  if (state.filteredTracks.length === 0) return;

  let currentIndex = state.filteredTracks.findIndex(s => s.path === (state.currentTrack?.path));
  let nextIndex = (currentIndex + 1) % state.filteredTracks.length;

  const nextTrack = state.filteredTracks[nextIndex];
  if (nextTrack) {
    selectTrack(nextTrack.originalIndex);
  }
}

export async function handlePrevTrack() {
  let currentIndex = state.filteredTracks.findIndex(s => s.path === (state.currentTrack?.path));
  let prevIndex = (currentIndex - 1 + state.filteredTracks.length) % state.filteredTracks.length;

  const prevTrack = state.filteredTracks[prevIndex];
  if (prevTrack) {
    selectTrack(prevTrack.originalIndex);
  }
}
