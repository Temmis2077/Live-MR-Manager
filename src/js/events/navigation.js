/**
 * js/events/navigation.js - Sidebar Navigation & Tabs
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { renderLibrary } from '../ui/library.js';
import { getAllWindows, WebviewWindow, emit } from '../tauri-bridge.js';
import { updateBroadcastTasksControlVisibility } from '../ui/components.js';

export function initNavigation() {
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const tabId = item.id.replace("nav-", "");
      // "노래 추가"는 탭이 아니라 원스톱 추가 모달을 연다.
      if (tabId === "add-song") {
        import('../ui/add-song-modal.js').then(({ openAddSongModal }) => openAddSongModal());
        return;
      }
      // "가사 창"은 탭이 아니라 별도 가사 호버창을 연다.
      if (tabId === "lyrics-window") {
        import('../tauri-bridge.js').then(({ invoke }) => invoke('open_lyrics_window'))
          .catch((err) => {
            console.error('[LyricsWindow] open failed:', err);
            import('../utils.js').then(m => m.showNotification('가사 창을 열지 못했습니다: ' + err, 'error'));
          });
        return;
      }
      if (tabId === "overlay") {
        switchTab("overlay");
        return;
      }
      if (tabId) switchTab(tabId);
    });
  });

  const navOverlay = document.getElementById("nav-overlay");
  const btnCopyOverlayUrl = document.getElementById("btn-copy-overlay-url");

  if (navOverlay) {
    navOverlay.addEventListener("click", () => switchTab("overlay"));
  }

  if (btnCopyOverlayUrl) {
    btnCopyOverlayUrl.addEventListener("click", () => {
      const displayEl = document.getElementById("overlay-url-display");
      const url = (displayEl && displayEl.textContent) ? displayEl.textContent : "http://localhost:14202/overlay-info";
      navigator.clipboard.writeText(url).then(() => {
        import('../utils.js').then(u => u.showNotification("URL이 클립보드에 복사되었습니다.", "success"));
      });
    });
  }
}

export function switchTab(tabId) {
  state.activeView = tabId;

  if (elements.viewTitle) elements.viewTitle.textContent = getTabTitle(tabId);

  // Sync viewport data-view attribute for CSS selectors
  if (elements.viewport) {
    elements.viewport.setAttribute("data-view", tabId === "alignment" ? "alignment-viewer" : tabId);
  }

  if (elements.viewSubtitle) {
    const subtitle = getTabSubtitle(tabId);
    elements.viewSubtitle.textContent = subtitle;
    elements.viewSubtitle.style.display = subtitle ? "block" : "none";
  }

  document.querySelectorAll(".nav-item").forEach(i => {
    i.classList.toggle("active", i.id === `nav-${tabId}`);
  });

  // 유튜브/내 파일 탭은 라이브러리에 합병됨 — 곡 추가는 사이드바 "노래 추가"로.
  const isMusicTab = (tabId === "library" || tabId === "meloming");
  if (elements.libraryControls) elements.libraryControls.style.display = isMusicTab ? "flex" : "none";
  if (elements.viewControls) elements.viewControls.style.display = isMusicTab ? "flex" : "none";
  updateBroadcastTasksControlVisibility();

  if (elements.settingsPage) elements.settingsPage.style.display = tabId === "settings" ? "block" : "none";

  // 라이브(공연 리모컨) — 보일 때만 갱신 루프를 돌린다.
  if (elements.livePage) {
    const isLive = tabId === "live";
    elements.livePage.style.display = isLive ? "flex" : "none";
    import('../live-screen.js')
      .then((m) => (isLive ? m.showLiveScreen() : m.hideLiveScreen()))
      .catch((err) => console.error('[Live] screen module failed:', err));
  }
  if (elements.tasksPage) elements.tasksPage.style.display = tabId === "tasks" ? "block" : "none";
  if (elements.overlayPage) elements.overlayPage.style.display = tabId === "overlay" ? "block" : "none";

  // Lyric Drawer control: Only show on music tabs
  if (elements.lyricDrawerTrigger) {
    elements.lyricDrawerTrigger.style.display = isMusicTab ? "flex" : "none";
  }
  // Close drawer if moving to a non-music (system) tab
  if (!isMusicTab && document.body.classList.contains('drawer-open')) {
    document.body.classList.remove('drawer-open');
  }

  if (elements.songGrid) {
    const isFlexMode = (state.viewMode === "list");
    // Use !important to override CSS !important when hiding
    if (isMusicTab) {
      elements.songGrid.style.removeProperty("display");
      elements.songGrid.style.display = isFlexMode ? "flex" : "grid";
    } else {
      elements.songGrid.style.setProperty("display", "none", "important");
    }

    elements.songGrid.classList.toggle("list-mode", state.viewMode === "list");
    elements.songGrid.classList.toggle("button-view", state.viewMode === "button");

    if (elements.viewport) {
      elements.viewport.setAttribute("data-view-mode", state.viewMode);
    }
    if (isMusicTab) renderLibrary();
  }

  const alignmentPage = document.getElementById("alignment-page");
  if (tabId === "alignment") {
    elements.viewport?.classList.add("alignment-mode");
    if (alignmentPage) alignmentPage.style.display = "block";
    // Initialize alignment viewer if needed
    initAlignmentViewer().then(() => {
      if (alignmentViewer) {
        alignmentViewer.resize();

        // 재생 중인 곡을 항상 따라간다 — 라이브러리에서 곡을 재생한 뒤 탭에
        // 들어와도 그 곡이 로드되게(이전에는 뷰어가 비어있을 때만 1회 로드라
        // 다른 곡이 남아 있었음). 재생곡이 없으면 기존 로드 상태 유지.
        if (state.currentTrack && alignmentViewer.state.currentPath !== state.currentTrack.path) {
          alignmentViewer.loadAudio(state.currentTrack.path);
          // Sync UI display name immediately
          const nameEl = document.getElementById('selected-track-name');
          if (nameEl) nameEl.innerText = state.currentTrack.title || "Unknown Title";
        }
      }
    });
  } else {
    if (alignmentViewer && typeof alignmentViewer.flushAutoSaveIfNeeded === 'function') {
      alignmentViewer.flushAutoSaveIfNeeded().catch((err) => {
        console.error('[Alignment] Auto-save flush failed on tab switch:', err);
      });
    }
    elements.viewport?.classList.remove("alignment-mode");
    if (alignmentPage) alignmentPage.style.display = "none";
  }

  if (tabId === "overlay") {
    // Do not force-reload on every tab switch.
    // Repeated reloads make preview feel delayed and can drop current preview context.
    const iframe = document.getElementById("overlay-iframe");
    if (iframe && !iframe.src) {
      iframe.src = "overlay-info.html?preview=true";
    }
    // Ensure preview scale/position is recalculated after the hidden tab becomes visible.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    });
  }

  if (tabId === "tasks") {
    import('../ui/components.js').then(({ updateTaskUI }) => updateTaskUI());
  }

  // Reset scroll position when switching tabs
  if (elements.scrollArea) {
    elements.scrollArea.scrollTop = 0;
  }
}

export async function openAlignmentForTrack(path, options = {}) {
  const forceLoad = options.forceLoad === true;
  switchTab("alignment");

  await initAlignmentViewer();
  if (!alignmentViewer || !path) return;

  // Manual navigation from lyric drawer should override existing sync-session track.
  if (forceLoad || alignmentViewer.state.currentPath !== path) {
    await alignmentViewer.loadAudio(path);
    const track = (state.songLibrary || []).find(t => t.path === path);
    const nameEl = document.getElementById('selected-track-name');
    if (nameEl) {
      nameEl.innerText = (track && track.title) ? track.title : "Unknown Title";
    }
  }
}

function getTabTitle(tabId) {
  const titles = {
    library: "라이브러리",
    live: "라이브",
    youtube: "유튜브",
    local: "내 파일",
    meloming: "멜로밍",
    settings: "설정",
    overlay: "OBS 오버레이",
    tasks: "AI 프로세싱",
    alignment: "가사 싱크"
  };
  return titles[tabId] || "라이브러리";
}

function getTabSubtitle(tabId) {
  const subtitles = {
    library: "라이브러리의 모든 곡을 관리하고 재생합니다.",
    live: "공연·방송 중 쓰는 리모컨 화면입니다. 키·빠르기·볼륨을 크게 조작하세요.",
    youtube: "유튜브 링크를 통해 곡을 검색하고 가져옵니다.",
    local: "화면 어디든 음원 파일을 드래그 앤 드롭하여 추가할 수 있습니다.",
    meloming: "멜로밍 노래책과 연동된 곡만 모아서 확인합니다.",
    settings: "애플리케이션 설정을 관리합니다.",
    overlay: "방송에 송출될 오버레이의 실시간 미리보기입니다.",
    tasks: "AI 작업 진행 상태를 확인합니다.",
    alignment: "가사 싱크를 조정하고 저장합니다."
  };
  return subtitles[tabId] || "";
}

export let alignmentViewer = null;
async function initAlignmentViewer() {
  if (alignmentViewer) return;
  const { ForcedAlignmentViewer } = await import('../alignment-viewer.js');
  const { invoke } = await import('../tauri-bridge.js');

  alignmentViewer = new ForcedAlignmentViewer("alignment-viewer-root");
  // Constructor already calls setupListeners, setupCanvasListeners, and loadTrackList
}

