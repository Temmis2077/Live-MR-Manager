/**
 * state.js - Centralized application state
 */

export const state = {
  songLibrary: [],
  currentTrack: null,
  isPlaying: false,
  isLoading: false,
  isAiModelReady: false,
  isSeparating: false,
  editingSongIndex: null,
  selectedTrackIndex: -1, // Currently highlighted but not playing
  // 보기 모드는 표 하나뿐이다 — 그리드·버튼 모드는 제거했다.
  viewMode: "list",

  // 라이브 '다음 곡' 큐 — 곡 경로 배열. 비어서 시작하고 사용자가 담는다
  // (라이브러리 전체를 자동으로 밀어 넣지 않는다).
  // 나중에 신청곡 연동이 붙어도 결국 이 배열에 들어온다.
  liveQueue: JSON.parse(localStorage.getItem("liveQueue") || "[]"),

  // 오버레이로 보낸 현재 줄의 구간·단어 타임. 라이브 본문의 진행도가 이 값을
  // 그대로 써서 두 화면이 구조적으로 어긋날 수 없게 한다(lyric-drawer가 채운다).
  overlayLyricWindow: null,
  // 현재 앱 실행 중 라이브 화면에서 실제로 재생한 곡. 이전 곡은 라이브러리
  // 필터가 아니라 이 이력을 역순으로 따라간다.
  livePlaybackHistory: [],
  themeMode: localStorage.getItem("themeMode") || "dark",
  masterVolume: (() => {
    const raw = parseFloat(localStorage.getItem("masterVolume") || "100");
    if (!Number.isFinite(raw)) return 100;
    return Math.max(0, Math.min(120, raw));
  })(),
  isMuted: false,
  prevVolume: 100,
  activeTasks: {}, // path -> { title, percentage, status }
  cancelledPaths: new Set(), // path blacklist for UI updates
  // AI 가사 정렬 배치 대기열 (분리의 activeTasks와 별개 — JS 주도 순차 처리,
  // alignment-queue.js가 소유). status: queued/processing/done/error/no-lyrics/cancelled
  alignmentQueue: [], // [{ path, title, thumbnail, status, percentage?, error? }]
  // 라이브러리 다중 선택 모드 (일괄 AI 정렬 요청용)
  librarySelectionMode: false,
  selectedSongPaths: new Set(),
  inspectedSongPath: null,
  libraryReadinessFilter: 'all',
  playbackSequence: 0, // Latest playback request ID to handle race conditions
  
  // Interpolation / Progress State
  targetProgressMs: 0,
  currentProgressMs: 0,
  trackDurationMs: 1,
  rafId: null,
  lastRafTime: 0,
  isSeeking: false,
  filteredTracks: [], // Current view's tracks { ...song, originalIndex }
  
  // Persistent AI Settings
  vocalEnabled: localStorage.getItem("vocalEnabled") === "true", // Default to false
  lyricsEnabled: localStorage.getItem("lyricsEnabled") === "true", // Default to false
  broadcastMode: localStorage.getItem("broadcastMode") === "true",
  mrCacheFormat: localStorage.getItem("mrCacheFormat") || "mp3",
  lastColumns: 0,
  
  // Real-time Lyrics
  currentLyrics: [],
  /** 현재 곡의 구간 마커 — 전주·간주에서 오버레이 가사를 비우는 데 쓴다.
   *  { vocalStartSec: number|null, interludes: [{start, end}] } */
  currentMarkers: { vocalStartSec: null, interludes: [] },
  currentLyricIndex: -1,
};

// --- Helper Functions for UI ---
import { invoke } from './tauri-bridge.js';

export async function getAllGenres() {
  try {
    const genres = await invoke('get_genres');
    // 결과가 비면 배열이 아닐 수 있다(개발용 목 백엔드·구버전 응답).
    // 예전에는 여기서 map이 터져 "장르 로드 실패" 스택이 콘솔을 채웠고,
    // 진짜 오류가 그 소음에 묻혔다.
    return Array.isArray(genres) ? genres.map(g => g.name) : [];
  } catch (err) {
    console.error('Failed to load genres:', err);
    return [];
  }
}

export async function getAllCategories() {
  try {
    const categories = await invoke('get_categories');
    return Array.isArray(categories) ? categories.map(c => c.name) : [];
  } catch (err) {
    console.error('Failed to load categories:', err);
    return [];
  }
}
