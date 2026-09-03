/**
 * js/events/navigation.js - Workspace Navigation & Tabs
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { renderLibrary } from '../ui/library.js';
import { getAllWindows, WebviewWindow, emit } from '../tauri-bridge.js';
import { updateBroadcastTasksControlVisibility } from '../ui/components.js';
import { pushEntry, rememberScroll, back, forward, canGoBack, canGoForward } from '../nav-history.js';

export function initNavigation() {
  const btnCopyOverlayUrl = document.getElementById("btn-copy-overlay-url");

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

export function switchTab(tabId, options = {}) {
  // 오버레이 설정은 화면이 아니다. 예전 코드가 탭으로 열려고 하면 빈 화면이
  // 되므로 여기서 패널로 돌려보낸다(진입 경로를 하나로 유지).
  if (tabId === "overlay") {
    import('../ui/overlay-float.js').then(({ openOverlayFloat }) => openOverlayFloat())
      .catch((err) => console.error('[Overlay] panel failed:', err));
    return;
  }

  // 떠 있는 오버레이 설정 패널을 먼저 닫는다 — 패널이 #overlay-tab 노드를
  // 자기 안으로 옮겨 두므로, 닫아서 제자리로 돌려야 다른 화면이 정상이다.
  import('../ui/overlay-float.js').then((m) => m.close()).catch(() => {});

  // 화면을 떠나기 직전의 스크롤 위치를 지금 화면 기록에 남긴다 — 뒤로가기로
  // 돌아왔을 때 보던 자리에서 이어지게 하기 위해서다. 뒤로/앞으로가 부른
  // 전환은 스택을 다시 밀면 안 되므로 건너뛴다.
  if (!options.fromHistory) {
    rememberScroll(elements.scrollArea?.scrollTop ?? 0);
    pushEntry(tabId);
  }

  state.activeView = tabId;

  // 앱바가 현재 화면 이름과 화면별 컨트롤 노출을 맞춘다(사이드바 대체).
  import('../ui/app-bar.js').then((m) => m.syncAppBar(tabId)).catch(() => {});

  // 하단 전송부는 화면마다 다르다 — 라이브는 본문에 자기 전송부가 있어 숨기고,
  // 나머지는 얇은 스트립만 남긴다(styles/transport.css).
  document.body.classList.toggle('view-live', tabId === 'live');
  document.body.classList.toggle('transport-slim', tabId !== 'live');

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

  // 유튜브/내 파일 탭은 라이브러리에 합병됨.
  const isMusicTab = (tabId === "library" || tabId === "meloming");
  if (elements.libraryControls) elements.libraryControls.style.display = isMusicTab ? "flex" : "none";
  if (elements.viewControls) elements.viewControls.style.display = isMusicTab ? "flex" : "none";
  updateBroadcastTasksControlVisibility();

  if (elements.settingsPage) elements.settingsPage.style.display = tabId === "settings" ? "block" : "none";

  // 설정에 들어올 때마다 하위 탭을 다시 적용한다 — 앱 시작 때 한 번만 칠하면
  // 그 뒤 다른 코드가 섹션 hidden을 건드렸을 때 되돌릴 기회가 없어, 설정이
  // 다시 긴 리스트가 된다(이 화면이 리스트로 되돌아간 재발 원인 중 하나).
  if (tabId === "settings") {
    import('./settings-tabs.js').then((m) => m.refreshSettingsTabs())
      .catch((err) => console.error('[Settings] tabs refresh failed:', err));
  }

  // 라이브(공연 리모컨) — 보일 때만 갱신 루프를 돌린다.
  if (elements.livePage) {
    const isLive = tabId === "live";
    elements.livePage.style.display = isLive ? "flex" : "none";
    import('../live-screen.js')
      .then((m) => (isLive ? m.showLiveScreen() : m.hideLiveScreen()))
      .catch((err) => console.error('[Live] screen module failed:', err));
  }
  if (elements.tasksPage) elements.tasksPage.style.display = tabId === "tasks" ? "block" : "none";
  // 오버레이 설정은 탭이 아니라 떠 있는 패널이다 — overlay-float.js가 표시를 맡는다.

  // Lyric Drawer control: Only show on music tabs
  if (elements.lyricDrawerTrigger) {
    elements.lyricDrawerTrigger.style.display = isMusicTab ? "flex" : "none";
  }
  // Close drawer if moving to a non-music (system) tab
  if (!isMusicTab && document.body.classList.contains('drawer-open')) {
    document.body.classList.remove('drawer-open');
  }
  if (!isMusicTab) {
    document.body.classList.remove('lib-filters-open', 'lib-inspector-open');
    document.getElementById('lib-filters-toggle')?.setAttribute('aria-expanded', 'false');
    document.getElementById('lib-inspector-toggle')?.setAttribute('aria-expanded', 'false');
  }

  // 음원 관리 3단 레이아웃 — 음악 탭에서만 펼친다.
  const libLayout = document.getElementById("library-layout");
  if (libLayout) {
    libLayout.classList.toggle("active", isMusicTab);
    if (isMusicTab) {
      import('../ui/library-panels.js')
        .then((m) => m.refreshLibraryPanels())
        .catch((err) => console.error('[Library] panels failed:', err));
    }
  }

  if (elements.songGrid) {
    // 보기 모드는 표 하나뿐이다.
    if (isMusicTab) {
      elements.songGrid.style.removeProperty("display");
      elements.songGrid.style.display = "flex";
    } else {
      elements.songGrid.style.setProperty("display", "none", "important");
    }
    elements.songGrid.classList.add("list-mode");
    if (elements.viewport) elements.viewport.setAttribute("data-view-mode", "list");
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

  if (tabId === "tasks") {
    import('../ui/components.js').then(({ updateTaskUI }) => updateTaskUI());
  }

  // 스크롤 — 새로 들어가는 화면은 맨 위에서, 뒤로/앞으로로 돌아온 화면은
  // 떠날 때 보던 자리에서 시작한다.
  if (elements.scrollArea) {
    const target = options.fromHistory ? (options.restoreScroll || 0) : 0;
    elements.scrollArea.scrollTop = target;
    // 목록을 비동기로 채우는 화면(가사 싱크 등)은 이 시점에 아직 높이가
    // 없어서 위 대입이 먹지 않는다. 한 프레임 뒤에 한 번 더 맞춘다.
    if (target > 0) {
      requestAnimationFrame(() => {
        if (elements.scrollArea && elements.scrollArea.scrollTop !== target) {
          elements.scrollArea.scrollTop = target;
        }
      });
    }
  }
}

/**
 * 히스토리를 따라 이동한다. 커서를 옮기기 전에 지금 화면의 스크롤을 먼저
 * 기록해야 한다 — 그래야 뒤로 갔다가 다시 앞으로 왔을 때도 자리가 유지된다.
 */
function travel(step) {
  rememberScroll(elements.scrollArea?.scrollTop ?? 0);
  const entry = step();
  if (!entry) return false;
  switchTab(entry.view, { fromHistory: true, restoreScroll: entry.scroll });
  return true;
}

/** 뒤로 한 칸. 갈 곳이 없으면 아무 일도 하지 않는다. */
export function goBackView() {
  return travel(back);
}

/** 앞으로 한 칸. */
export function goForwardView() {
  return travel(forward);
}

export { canGoBack, canGoForward };

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
    // 편집기에서 연 곡을 앱의 현재 곡으로 맞춘다. 재생 → 편집기 방향은
    // player.js가 이미 따라가는데 반대가 없어서, 다른 곡을 틀어둔 채 편집하면
    // 가사 드로어·라이브 패널·오버레이가 편집 중인 곡과 계속 어긋났다.
    // loadAudio가 playNow:false로 이미 로드했으므로 재생을 시작하지는 않는다.
    if (track && state.currentTrack?.path !== path) {
      state.currentTrack = track;
      state.currentLyricIndex = -1;
      const idx = (state.songLibrary || []).findIndex(t => t.path === path);
      if (idx >= 0) state.selectedTrackIndex = idx;

      // 길이는 "3:47" 형태라 초로 바꿔 넘긴다(가사 파서가 끝 시각 보정에 쓴다).
      const { loadLyricsAndMarkers } = await import('../lyrics.js');
      const { durationToSeconds } = await import('../duration.js');
      const { segments: lyrics, markers } = await loadLyricsAndMarkers(path, durationToSeconds(track.duration) || 0);
      const drawer = await import('../lyric-drawer.js');
      drawer.setDisplayLyrics(lyrics, markers);
      drawer.syncLyricDrawerHeader?.();
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
