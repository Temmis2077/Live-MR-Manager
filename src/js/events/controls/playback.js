/**
 * Playback, slider, and seek control listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';
import { setPitch, setTempo, setMasterVolume, setVocalBalance, seekTo } from '../../audio.js';
import { persistCurrentTrackAudioSettings, setupDirectInput } from './shared.js';

export function initPlaybackListeners() {
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.onclick = async () => {
      const { handlePlaybackToggle } = await import('../../player.js');
      handlePlaybackToggle();
    };
  }
  if (elements.dockThumb) {
    elements.dockThumb.onclick = async () => {
      const { handlePlaybackToggle } = await import('../../player.js');
      handlePlaybackToggle();
    };
  }

  if (elements.btnPrev) {
    elements.btnPrev.onclick = async () => {
      const { handlePrevTrack } = await import('../../player.js');
      handlePrevTrack();
    };
  }
  if (elements.btnNext) {
    elements.btnNext.onclick = async () => {
      const { handleNextTrack } = await import('../../player.js');
      handleNextTrack();
    };
  }

  if (elements.pitchSlider) {
    elements.pitchSlider.oninput = (e) => {
      const val = Number.parseFloat(e.target.value);
      if (elements.pitchVal) elements.pitchVal.textContent = val > 0 ? `+${val}` : val;
      setPitch(val);
      persistCurrentTrackAudioSettings({ pitch: val });
    };

    elements.pitchSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = Number.parseFloat(elements.pitchSlider.value);
      const min = Number.parseFloat(elements.pitchSlider.min || "-12");
      const max = Number.parseFloat(elements.pitchSlider.max || "12");
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(min, Math.min(max, val));
      elements.pitchSlider.value = String(Math.round(val));
      elements.pitchSlider.dispatchEvent(new Event("input"));
    }, { passive: false });
    elements.pitchSlider.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      elements.pitchSlider.value = "0";
      elements.pitchSlider.dispatchEvent(new Event("input"));
    });

    if (elements.pitchVal) setupDirectInput(elements.pitchVal, elements.pitchSlider);
  }

  if (elements.tempoSlider) {
    elements.tempoSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      if (elements.tempoVal) elements.tempoVal.textContent = `${val.toFixed(2)}x`;
      setTempo(val);
      persistCurrentTrackAudioSettings({ tempo: val });
    };

    elements.tempoSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(elements.tempoSlider.value);
      const min = Number.parseFloat(elements.tempoSlider.min || "0.5");
      const max = Number.parseFloat(elements.tempoSlider.max || "2.0");
      if (e.deltaY < 0) val += 0.05; else val -= 0.05;
      val = Math.max(min, Math.min(max, val));
      elements.tempoSlider.value = val.toFixed(2);
      elements.tempoSlider.dispatchEvent(new Event("input"));
    }, { passive: false });
    elements.tempoSlider.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      elements.tempoSlider.value = "1.00";
      elements.tempoSlider.dispatchEvent(new Event("input"));
    });

    if (elements.tempoVal) setupDirectInput(elements.tempoVal, elements.tempoSlider);
  }

  if (elements.volSlider) {
    elements.volSlider.oninput = (e) => {
      const val = e.target.value;
      if (elements.volSliderVal) elements.volSliderVal.textContent = `${val}%`;
      setMasterVolume(parseFloat(val));
      state.masterVolume = parseFloat(val);
      localStorage.setItem("masterVolume", val);
    };

    elements.volSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = Number.parseFloat(elements.volSlider.value);
      const min = Number.parseFloat(elements.volSlider.min || "0");
      const max = Number.parseFloat(elements.volSlider.max || "120");
      if (e.deltaY < 0) val += 2; else val -= 2;
      val = Math.max(min, Math.min(max, val));
      elements.volSlider.value = String(Math.round(val));
      elements.volSlider.dispatchEvent(new Event("input"));
    }, { passive: false });
    elements.volSlider.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      elements.volSlider.value = "100";
      elements.volSlider.dispatchEvent(new Event("input"));
    });

    if (elements.volSliderVal) setupDirectInput(elements.volSliderVal, elements.volSlider);
  }

  // 믹스 슬라이더는 이제 전송부에 그대로 나와 있다(팝오버 제거).
  const vocalBalanceVal = document.getElementById("vocal-balance-val");

  initDockMoreMenu();

  if (elements.vocalBalance) {
    elements.vocalBalance.oninput = (e) => {
      const val = e.target.value;
      if (vocalBalanceVal) vocalBalanceVal.textContent = `${val}%`;
      setVocalBalance(parseFloat(val));
    };

    elements.vocalBalance.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(elements.vocalBalance.value);
      if (e.deltaY < 0) val += 5; else val -= 5;
      val = Math.max(0, Math.min(100, val));
      elements.vocalBalance.value = val;
      elements.vocalBalance.dispatchEvent(new Event("input"));
    }, { passive: false });
  }

  if (elements.playbackBar) {
    elements.playbackBar.oninput = (e) => {
      state.isSeeking = true;
      state.currentProgressMs = (parseFloat(e.target.value) / 100) * state.trackDurationMs;
    };
    elements.playbackBar.onchange = async (e) => {
      const { updateThumbnailOverlay } = await import('../../ui/components.js');
      const targetMs = (parseFloat(e.target.value) / 100) * state.trackDurationMs;
      state.targetProgressMs = targetMs;
      state.currentProgressMs = targetMs;
      state.isLoading = true;
      updateThumbnailOverlay();

      try {
        await seekTo(targetMs);
      } catch (err) {
        console.error("Seek failed:", err);
      } finally {
        state.isSeeking = false;
        state.isLoading = false;
        updateThumbnailOverlay();
      }
    };
  }

  const btnReset = document.getElementById("btn-reset-audio");
  if (btnReset) {
    btnReset.onclick = () => {
      if (elements.pitchSlider) {
        elements.pitchSlider.value = 0;
        elements.pitchSlider.dispatchEvent(new Event("input"));
      }
      if (elements.tempoSlider) {
        elements.tempoSlider.value = 1.0;
        elements.tempoSlider.dispatchEvent(new Event("input"));
      }
      import('../../utils.js').then(m => m.showNotification("오디오 설정이 초기화되었습니다.", "info"));
    };
  }
}

/**
 * 컨트롤바 ⋮ 버튼 → 현재 곡 빠른 작업 메뉴(숨김 팝오버).
 * 곡 정보 수정 / MR 분리 / 가사 싱크 열기를 재생 중인 곡에 바로 실행한다.
 * 재생 중인 곡이 없으면 안내만 하고 메뉴를 열지 않는다.
 */
function initDockMoreMenu() {
  const btn = document.getElementById("dock-more-btn");
  const popover = document.getElementById("dock-more-popover");
  if (!btn || !popover) return;

  const titleEl = document.getElementById("dock-more-title");
  const itemEdit = document.getElementById("dock-menu-edit");
  const itemSeparate = document.getElementById("dock-menu-separate");
  const itemLyricSync = document.getElementById("dock-menu-lyric-sync");
  const itemLyricsWindow = document.getElementById("dock-menu-lyrics-window");
  const itemMrFolder = document.getElementById("dock-menu-mr-folder");

  const closeMenu = () => popover.classList.remove("active");

  if (itemMrFolder) {
    // 분리 결과 폴더 열기 — 캐시 폴더명은 경로를 URL 인코딩한 값이라
    // 사용자가 직접 찾기 어려워서 백엔드가 해석해 열어준다.
    itemMrFolder.onclick = async () => {
      if (itemMrFolder.classList.contains("disabled")) return;
      closeMenu();
      const song = state.currentTrack;
      if (!song) return;
      const { invoke } = await import('../../tauri-bridge.js');
      try {
        await invoke('open_mr_folder', { path: song.path });
      } catch (err) {
        const { showNotification } = await import('../../utils.js');
        showNotification(String(err), 'warning');
      }
    };
  }

  if (itemLyricsWindow) {
    // 가사 호버창 — 곡과 무관하게 열 수 있다(재생 중인 곡을 자동으로 따라감).
    itemLyricsWindow.onclick = async () => {
      closeMenu();
      const { invoke } = await import('../../tauri-bridge.js');
      try {
        await invoke('open_lyrics_window');
      } catch (err) {
        console.error('[LyricsWindow] open failed:', err);
        const { showNotification } = await import('../../utils.js');
        showNotification('가사 창을 열지 못했습니다: ' + err, 'error');
      }
    };
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    if (popover.classList.contains("active")) {
      closeMenu();
      return;
    }
    const song = state.currentTrack;
    if (!song) {
      import('../../utils.js').then(m => m.showNotification("재생 중인 곡이 없습니다.", "info"));
      return;
    }
    // 열 때마다 현재 곡 기준으로 항목 상태 갱신
    if (titleEl) titleEl.textContent = song.title || "현재 곡";
    const inLib = state.songLibrary.find((s) => s.path === song.path) || song;
    const isSeparated = !!(inLib.isSeparated || inLib.is_separated);
    if (itemSeparate) {
      const isManualMr = !!(inLib.isMr || inLib.is_mr);
      const busy = !!state.activeTasks[song.path];
      itemSeparate.classList.toggle("disabled", isSeparated || isManualMr || busy);
      itemSeparate.textContent = busy ? "분리 진행 중…" : (isSeparated ? "MR 분리됨" : "MR 분리");
    }
    if (itemMrFolder) {
      // 분리 안 된 곡은 열 폴더가 없다.
      itemMrFolder.classList.toggle("disabled", !isSeparated);
    }
    popover.classList.add("active");
  };

  if (itemEdit) {
    itemEdit.onclick = async () => {
      closeMenu();
      const song = state.currentTrack;
      if (!song) return;
      const idx = state.songLibrary.findIndex((s) => s.path === song.path);
      if (idx === -1) {
        import('../../utils.js').then(m => m.showNotification("라이브러리에서 곡을 찾을 수 없습니다.", "error"));
        return;
      }
      const { openEditModal } = await import('../../ui/modals.js');
      openEditModal(state.songLibrary[idx], idx);
    };
  }

  if (itemSeparate) {
    itemSeparate.onclick = async () => {
      closeMenu();
      const song = state.currentTrack;
      if (!song) return;
      // 컨텍스트 메뉴와 동일: 속도/품질(모델) 선택 모달을 먼저 띄운다.
      const { openSeparationModeModal } = await import('../../separation-mode-modal.js');
      openSeparationModeModal(state.songLibrary.find((s) => s.path === song.path) || song);
    };
  }

  if (itemLyricSync) {
    itemLyricSync.onclick = async () => {
      closeMenu();
      const song = state.currentTrack;
      if (!song) return;
      const { openAlignmentForTrack } = await import('../navigation.js');
      openAlignmentForTrack(song.path);
    };
  }
}
