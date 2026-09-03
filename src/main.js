/**
 * main.js - Entry point for OSW (Open Stem Wave)
 */

import { state } from './js/state.js';
import { libraryService } from './ipc/services/library.js';
import { 
  initDomReferences, renderLibrary,
  refreshFilterDropdowns, updateSortDropdown, updateAiModelStatus, 
  updateAiTogglesState, updateGpuStatus, refreshGpuPackStatus, setupGridResizeObserver, initSortable, elements
} from './js/ui/index.js';
import { initAllEvents, switchTab } from './js/events/index.js';
import { loadLibrary, checkAiModelStatus, cancelSeparation, setMasterVolume } from './js/audio.js';
import { showNotification } from './js/utils.js';
import { initUpdateChecker } from './js/update-check.js';
import { registerAppHandler } from './js/app-context.js';

import { invoke, appWindow, toggleWindowMaximize } from './js/tauri-bridge.js';

const THEME_STORAGE_KEY = 'themeMode';

function normalizeTheme(_value) {
  // v1 backups may still contain light/pink/sky. Red Orbit is intentionally
  // a single instrument theme, so every legacy value migrates to dark.
  return 'dark';
}

function applyPlatformClass() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const isWindows = /Win/i.test(platform) || /Windows/i.test(ua);
  document.documentElement.classList.toggle("platform-windows", isWindows);
}

export function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = normalizeTheme(theme);
  document.documentElement.setAttribute('data-theme', nextTheme);
  state.themeMode = nextTheme;
  if (persist) {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }
  return nextTheme;
}

function initTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(stored || state.themeMode || 'dark', { persist: true });
}

// Register app handlers (replaces window.* globals for cross-module calls)
registerAppHandler('switchToTab', switchTab);
registerAppHandler('applyAppTheme', applyTheme);
registerAppHandler('cancelTask', cancelSeparation);

// Register permanent error listeners to bridge JS errors to terminal IMMEDIATELY
window.addEventListener('error', (event) => {
  console.error("[Fatal Error]", event.error || event.message);
  invoke('remote_js_log', { msg: `[JS Error] ${event.message} at ${event.filename}:${event.lineno}` }).catch(() => {});
});
window.addEventListener('unhandledrejection', (event) => {
  console.error("[Fatal Promise Error]", event.reason);
  invoke('remote_js_log', { msg: `[JS Unhandled Promise] ${event.reason ? event.reason.toString() : 'Unknown'}` }).catch(() => {});
});

console.log("[JS] main.js loaded and executing...");

async function initApp() {
  console.log("[App] Initializing...");
  applyPlatformClass();
  initTheme();

  // 0. Setup custom titlebar immediately (Don't wait for backend)
  setupTitlebar();

  // Fix manual input font/layout shift is handled in overlay-settings.css
  // 0. 번역 사전 로드.
  //    sync_dictionary_to_db는 여기서 부르지 않는다 — 사전 '관리' UI를 없애면서
  //    명령 등록에서도 뺐기 때문에(lib.rs 참고), 부르면 매 실행마다 실패 로그만
  //    남았다. 자동 번역이 읽는 사전은 init_metadata_context가 올린다.
  try {
    await invoke('init_metadata_context');
    console.log("[App] Metadata context initialized.");
  } catch (err) {
    console.error("[App] Metadata context init failed:", err);
  }
  
  // 1. Initialize DOM references
  initDomReferences();
  
  // 2. Load Data
  try {
    const savedLibrary = await loadLibrary();
    state.songLibrary = savedLibrary || [];
    console.log(`[App] Loaded ${state.songLibrary.length} songs.`);

    // 장르/카테고리 표준 재매핑 — 예전 값(소문자 kpop/ballad, 자동수집 '록'
    // 등)을 새 기준으로 한 번만 정리한다(docs/GENRE_CATEGORY_STANDARD.md).
    //
    // V2: V1이 돈 뒤에도 표준 밖 값이 남아 있었다. REMAP에 없는 값은
    // classifyOne이 '커스텀'으로 그대로 보존해서, 장르 목록에 락발라드·
    // 시티팝·신스팝·사운드트랙이, 카테고리에 '기본'·'민요'가 떠돌았다.
    // 그 값들을 REMAP에 넣고 서브장르 개념을 추가했으므로 한 번 더 돈다.
    if (localStorage.getItem("taxonomyMigratedV2") !== "true") {
      const { migrateLibraryTaxonomy } = await import('./js/taxonomy.js');
      const changed = migrateLibraryTaxonomy(state.songLibrary);
      if (changed > 0) {
        const { saveLibrary } = await import('./js/audio.js');
        await saveLibrary(state.songLibrary);
        console.log(`[App] Taxonomy migrated: ${changed} songs`);
      }
      // 재매핑으로 아무도 안 쓰게 된 장르·카테고리 행을 지운다
      // (옛 영문 슬러그 jpop/rock/ballad, 중복된 록·인디 록·포크 등).
      try {
        const [g, c] = await libraryService.pruneUnusedTaxonomy();
        if (g || c) console.log(`[App] Pruned unused taxonomy: genres ${g}, categories ${c}`);
      } catch (err) {
        console.warn('[App] taxonomy prune skipped:', err);
      }

      localStorage.setItem("taxonomyMigratedV2", "true");
      localStorage.removeItem("taxonomyMigratedV1");
    }
  } catch (err) {
    console.error("Failed to load library:", err);
  }

  // 3. Initialize Event Listeners
  try {
    initAllEvents();
  } catch (err) {
    console.error("Failed to initialize events:", err);
  }

  // 3-1. 앱 전역 단축키와 마우스 뒤로/앞으로 버튼.
  // 화면 전용 단축키(음원 관리 등)는 initAllEvents 안에서 이미 등록됐다 —
  // 그 뒤에 불러야 도움말 목록이 비지 않는다.
  try {
    const { initGlobalShortcuts, initMouseNavigation } = await import('./js/events/global-shortcuts.js');
    initGlobalShortcuts();
    initMouseNavigation();
  } catch (err) {
    console.error("Failed to initialize shortcuts:", err);
  }

  // 4. Set Initial UI State
  try {
    const initialTab = "library";
    switchTab(initialTab);
    
    await refreshFilterDropdowns();
    updateSortDropdown();
  } catch (err) {
    console.error("Failed to set initial UI state:", err);
  }
  
  // 5. Initialize View Mode UI
  try {
    if (elements.songGrid) {
      elements.songGrid.classList.toggle("list-view", state.viewMode === "list");
      elements.songGrid.style.display = (state.viewMode === "list") ? "flex" : "grid";
    }
  } catch (err) {}

  // 6. Check AI Model & GPU
  try {
    state.isAiModelReady = await checkAiModelStatus();
    updateAiModelStatus(state.isAiModelReady);
    const gpuStatus = await invoke("get_gpu_recommendation");
    updateGpuStatus(gpuStatus);
  } catch (err) {}

  // 릴리즈에서 감출 섹션을 먼저 확정한 뒤 탭을 만든다 — 탭은 "보일 섹션이
  // 하나도 없는 탭"을 감추려고 그 결과를 읽는다.
  try {
    const { initAppModeControls } = await import('./js/events/app-mode-ui.js');
    initAppModeControls();
  } catch (err) {}

  try {
    const { initSettingsTabs } = await import('./js/events/settings-tabs.js');
    initSettingsTabs();
  } catch (err) {}

  try {
    const { initGpuPackControls } = await import('./js/gpu-pack.js');
    initGpuPackControls();
    await refreshGpuPackStatus();
    elements.btnOpenGpuPack?.addEventListener("click", async () => {
      try {
        await invoke("open_gpu_pack_dir");
        await refreshGpuPackStatus();
      } catch (err) {}
    });
  } catch (err) {}

  try {
    const { initOutputDeviceControls, refreshOutputDevices } = await import('./js/audio-devices.js');
    initOutputDeviceControls();
    await refreshOutputDevices();
  } catch (err) {}

  try {
    const { initTrackMixer, refreshMixerState } = await import('./js/track-mixer.js');
    initTrackMixer();
    await refreshMixerState();
  } catch (err) {
    console.warn('[Mixer] 초기화 실패:', err);
  }

  try {
    const { initDereverbControls, refreshDereverbStatus } = await import('./js/dereverb.js');
    initDereverbControls();
    await refreshDereverbStatus();
  } catch (err) {}

  // 7. Initial volume sync
  try {
    if (elements.volSlider) {
      const min = Number.parseFloat(elements.volSlider.min || "0");
      const max = Number.parseFloat(elements.volSlider.max || "120");
      const normalized = Math.max(min, Math.min(max, Number(state.masterVolume)));
      state.masterVolume = normalized;
      elements.volSlider.value = normalized;
      if (elements.volSliderVal) elements.volSliderVal.textContent = `${normalized}%`;
    }
    await setMasterVolume(state.masterVolume);
  } catch (err) {}

  // 8. Setup Smooth Grid Resize & DragDrop
  try {
    setupGridResizeObserver();
    initSortable();
  } catch (err) {}

  // 9. Initialize Lyric Drawer (Last, to prevent blocking)
  try {
    import('./js/lyric-drawer.js').then(({ initLyricDrawer }) => {
      initLyricDrawer();
    }).catch(err => console.error("Lyric Drawer init failed:", err));
  } catch (err) {}

  // 10. Final UI Sync
  try {
    updateAiTogglesState(null);
  } catch (err) {}

  // 11. 첫 실행 환영 화면.
  //     라이브러리가 비어 있고 아직 본 적 없을 때만 뜬다 — 이전 버전에서
  //     데이터를 가져온 사람은 곡이 이미 있으므로 방해하지 않는다.
  //     초기화가 다 끝난 뒤에 띄운다(모델 확인·장치 조회 중에 모달이 떠서
  //     그 뒤 토스트가 모달 뒤로 깔리는 일이 없게).
  try {
    const { shouldShowWelcome } = await import('./js/onboarding.js');
    if (shouldShowWelcome({ songCount: state.songLibrary.length })) {
      const { openGuide } = await import('./js/ui/onboarding-ui.js');
      await openGuide({ welcome: true });
    }
  } catch (err) {
    console.error("[App] Welcome guide failed:", err);
  }

  console.log("[App] Initialization Complete.");
}

function setupTitlebar() {
  console.log("[Titlebar] Setting up event listeners...");

  document.querySelectorAll("[data-tauri-drag-region]").forEach((el) => {
    el.addEventListener("mousedown", async (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".titlebar-button")) return;
      try {
        if (event.detail === 2) {
          await toggleWindowMaximize();
        } else {
          await appWindow.startDragging();
        }
      } catch (error) {
        console.error("[Titlebar] drag/maximize failed:", error);
      }
    });
  });

  document.getElementById('titlebar-minimize')?.addEventListener('click', async () => {
    console.log("[Titlebar] Minimize clicked");
    try { await appWindow.minimize(); } catch (e) { console.error(e); }
  });

  document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
    console.log("[Titlebar] Maximize/Restore clicked");
    try { await toggleWindowMaximize(); } catch (e) { console.error(e); }
  });

  document.getElementById('titlebar-close')?.addEventListener('click', async () => {
    console.log("[Titlebar] Close clicked");
    try { await appWindow.close(); } catch (e) { console.error(e); }
  });
}

function blockNativeContextMenu() {
  // Keep app-like UX by suppressing the browser's default right-click menu.
  // Custom in-app context menus still work because we only prevent default.
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
}

// Start
window.addEventListener("DOMContentLoaded", async () => {
  blockNativeContextMenu();
  initUpdateChecker();
  await initApp();
});

// state exposed only in browser mock mode for debugging
if (!window.__TAURI__) {
  window.state = state;
}
