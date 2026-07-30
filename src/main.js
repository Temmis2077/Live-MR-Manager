/**
 * main.js - Entry point for OSW (Open Stem Wave)
 */

import { state } from './js/state.js';
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
const THEME_OPTIONS = new Set(['dark', 'light', 'pink', 'sky']);

function normalizeTheme(value) {
  return THEME_OPTIONS.has(value) ? value : 'dark';
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

function syncThemeDropdown(theme) {
  const hiddenInput = document.getElementById('theme-mode-select');
  const dropdown = document.getElementById('theme-mode-dropdown');
  if (!hiddenInput || !dropdown) return;

  hiddenInput.value = theme;
  const selectedText = dropdown.querySelector('.selected-text');
  const options = dropdown.querySelectorAll('.option-item');
  options.forEach((opt) => {
    const selected = opt.dataset.value === theme;
    opt.classList.toggle('selected', selected);
    if (selected && selectedText) {
      selectedText.textContent = opt.textContent;
    }
  });
}

function initTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  const appliedTheme = applyTheme(stored || state.themeMode || 'dark', { persist: true });
  syncThemeDropdown(appliedTheme);
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
  // 0. Initialize Metadata Context (Dictionary)
  try {
    await invoke('init_metadata_context');
    await invoke('sync_dictionary_to_db');
    console.log("[App] Metadata context initialized and synced to DB.");
  } catch (err) {
    console.error("[App] Initial metadata sync failed:", err);
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

  try {
    const { initSettingsTabs } = await import('./js/events/settings-tabs.js');
    initSettingsTabs();
  } catch (err) {}

  try {
    const { initAppModeControls } = await import('./js/events/app-mode-ui.js');
    initAppModeControls();
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

  // 트랙 믹서(페이더·음소거/솔로·메트로놈·채널 라우팅·지연 보정)는 개발용
  // 최소 UI였어서 이번 릴리즈에서는 화면에서 뺐다. 백엔드 기능은 그대로 살아
  // 있고 안전한 기본값으로 동작한다(리미터 켜짐, MR 채널 꺼짐, 메트로놈 꺼짐).
  // 제대로 된 믹서 UI를 만들 때 src/js/track-mixer.js를 다시 연결하면 된다.

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
