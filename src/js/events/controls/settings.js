/**
 * Settings page control listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';
import { loadLibrary } from '../../audio.js';
import {
  FAQ_URL,
  GITHUB_ISSUES_BUG_URL,
  PRIVACY_URL,
  QA_URL,
  TERMS_URL,
  resolveDiscordUrl,
} from '../../companion-links.js';
import {
  checkForAppUpdate,
  exportBackup,
  exportLibrarySpreadsheet,
  getMrCacheFormat,
  importBackup,
  importLibrarySpreadsheet,
  openAppPage,
  openCacheFolder,
  openLogFolder,
  runCacheRescue,
  setBroadcastMode,
  setMrCacheFormat,
} from '../../settings-api.js';

/** CSV 가져오기 뒤 목록 갱신 + 결과 알림. 시작 가이드의 가져오기도 같은 경로를 쓴다. */
export async function reloadLibraryAfterSpreadsheetImport(result) {
  const { showNotification } = await import('../../utils.js');
  const { renderLibrary } = await import('../../ui/library.js');
  const { refreshFilterDropdowns } = await import('../../ui/core.js');
  state.songLibrary = await loadLibrary() || [];
  await refreshFilterDropdowns();
  renderLibrary();
  const added = Number(result?.added || 0);
  const updated = Number(result?.updated || 0);
  const skipped = Number(result?.skipped || 0);
  let enriched = Number(result?.enriched || 0);
  let errCount = Array.isArray(result?.errors) ? result.errors.length : 0;
  let msg = `가져오기 완료: 추가 ${added}곡, 갱신 ${updated}곡`;
  if (enriched > 0) msg += `, 유튜브 정보 ${enriched}곡`;
  if (skipped > 0) msg += `, 건너뜀 ${skipped}행`;
  if (errCount > 0) msg += `, 오류 ${errCount}건`;
  showNotification(msg, errCount > 0 ? "warning" : "success");
  if (errCount > 0 && result.errors?.length) {
    console.warn("[spreadsheet import]", result.errors.slice(0, 20));
  }
}

export function initSettingsListeners({ syncAllOverlayStylesToBackend }) {
  if (elements.btnExportBackup) {
    elements.btnExportBackup.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await exportBackup();
        showNotification("라이브러리와 앱 설정을 백업했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("백업 중 오류가 발생했습니다: " + err, "error");
        }
      }
    };
  }

  if (elements.btnImportBackup) {
    elements.btnImportBackup.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        const { added, settingsRestored } = await importBackup();
        const { renderLibrary } = await import('../../ui/library.js');
        state.songLibrary = await loadLibrary() || [];
        const { refreshFilterDropdowns } = await import('../../ui/core.js');
        await refreshFilterDropdowns();
        renderLibrary();

        // 복원한 설정 중 상당수(테마·오버레이 디자인·대기열)는 앱이 시작할 때
        // 한 번만 읽는다. 여기서 부분적으로 반영하려 들면 어떤 건 되고 어떤 건
        // 안 되는 상태가 되므로, 재시작을 안내하는 편이 정직하다.
        let msg = added > 0 ? `백업본에서 ${added}곡을 병합했습니다.` : "백업본에 새로 추가할 곡이 없었습니다.";
        if (settingsRestored > 0) msg += ` 앱 설정 ${settingsRestored}개는 다시 시작하면 적용됩니다.`;
        showNotification(msg, "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("복원 중 오류가 발생했습니다: " + err, "error");
        }
      }
    };
  }

  if (elements.btnExportSpreadsheetTemplate) {
    elements.btnExportSpreadsheetTemplate.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await exportLibrarySpreadsheet(true);
        showNotification("가져오기 양식(CSV)을 저장했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("양식 저장 중 오류: " + err, "error");
        }
      }
    };
  }

  if (elements.btnExportSpreadsheet) {
    elements.btnExportSpreadsheet.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await exportLibrarySpreadsheet(false);
        showNotification("라이브러리를 CSV로 저장했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("CSV 보내기 중 오류: " + err, "error");
        }
      }
    };
  }

  if (elements.btnImportSpreadsheet) {
    elements.btnImportSpreadsheet.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        const result = await importLibrarySpreadsheet();
        await reloadLibraryAfterSpreadsheetImport(result);
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("가져오기 중 오류: " + err, "error");
        }
      }
    };
  }

  if (elements.btnRunRescue) {
    elements.btnRunRescue.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      const { renderLibrary } = await import('../../ui/library.js');

      showNotification("데이터 복구를 시작합니다. 유튜브 곡의 경우 시간이 소요될 수 있습니다.", "info");
      elements.btnRunRescue.classList.add("loading-btn");

      try {
        const result = await runCacheRescue();
        const stats = typeof result === "number"
          ? { scanned: result, recovered: result, failed: 0 }
          : {
              scanned: Number(result?.scanned || 0),
              recovered: Number(result?.recovered || 0),
              failed: Number(result?.failed || 0),
            };
        showNotification(
          `복구 완료: 스캔 ${stats.scanned}곡 / 복구 ${stats.recovered}곡 / 실패 ${stats.failed}곡`,
          stats.failed > 0 ? "warning" : "success"
        );
        state.songLibrary = await loadLibrary() || [];
        const { refreshFilterDropdowns } = await import('../../ui/core.js');
        await refreshFilterDropdowns();
        renderLibrary();
      } catch (err) {
        showNotification("복구 중 오류가 발생했습니다: " + err, "error");
      } finally {
        elements.btnRunRescue.classList.remove("loading-btn");
      }
    };
  }

  const syncBroadcastModeToggles = (enabled) => {
    state.broadcastMode = !!enabled;
    localStorage.setItem("broadcastMode", String(!!enabled));
    if (elements.toggleBroadcastMode) elements.toggleBroadcastMode.checked = !!enabled;
    if (elements.toggleBroadcastModeActive) elements.toggleBroadcastModeActive.checked = !!enabled;
  };

  const applyBroadcastMode = async (enabled) => {
    try {
      await setBroadcastMode(enabled);
      syncBroadcastModeToggles(enabled);
    } catch (err) {
      syncBroadcastModeToggles(state.broadcastMode);
      const { showNotification } = await import('../../utils.js');
      showNotification("방송 제원 보호 모드 변경 실패: " + err, "error");
    }
  };

  if (elements.toggleBroadcastMode) {
    elements.toggleBroadcastMode.onchange = (e) => applyBroadcastMode(e.target.checked);
  }
  if (elements.toggleBroadcastModeActive) {
    elements.toggleBroadcastModeActive.onchange = (e) => applyBroadcastMode(e.target.checked);
  }
  syncBroadcastModeToggles(state.broadcastMode);

  const syncMrCacheFormatToUi = (format) => {
    const normalized = format === "wav" ? "wav" : "mp3";
    const dropdown = document.getElementById("mr-cache-format-dropdown");
    if (!dropdown) return;
    const selectedText = dropdown.querySelector(".selected-text");
    const options = dropdown.querySelectorAll(".option-item");
    options.forEach((opt) => {
      const selected = opt.dataset.value === normalized;
      opt.classList.toggle("selected", selected);
      if (selected && selectedText) selectedText.textContent = opt.textContent;
    });
    if (elements.mrCacheFormatSelect) {
      elements.mrCacheFormatSelect.value = normalized;
    }
  };

  const applyMrCacheFormat = async (format) => {
    const normalized = format === "wav" ? "wav" : "mp3";
    try {
      await setMrCacheFormat(normalized);
      state.mrCacheFormat = normalized;
      localStorage.setItem("mrCacheFormat", normalized);
      syncMrCacheFormatToUi(normalized);
    } catch (err) {
      syncMrCacheFormatToUi(state.mrCacheFormat);
      const { showNotification } = await import('../../utils.js');
      showNotification("MR 저장 형식 변경 실패: " + err, "error");
    }
  };

  if (elements.mrCacheFormatSelect) {
    const initMrCacheFormat = async () => {
      let format = state.mrCacheFormat || "mp3";
      try {
        const backend = await getMrCacheFormat();
        if (backend === "mp3" || backend === "wav") {
          format = backend;
        }
      } catch (_) {
        /* use localStorage fallback */
      }
      state.mrCacheFormat = format;
      localStorage.setItem("mrCacheFormat", format);
      syncMrCacheFormatToUi(format);
      try {
        await setMrCacheFormat(format);
      } catch (_) {
        /* backend may be unavailable during early init */
      }
    };
    initMrCacheFormat();

    elements.mrCacheFormatSelect.addEventListener("change", async (e) => {
      await applyMrCacheFormat(e.target.value);
      const { showNotification } = await import('../../utils.js');
      const label = e.target.value === "wav" ? "WAV (32비트 무손실)" : "MP3 (320kbps)";
      showNotification(`MR 저장 형식이 ${label}로 변경되었습니다.`, "info");
    });
  }

  const btnOpenCache = document.getElementById("btn-open-cache");
  if (btnOpenCache) {
    btnOpenCache.onclick = async () => {
      await openCacheFolder();
    };
  }

  // 로그 폴더 열기 — 버그 신고 양식이 로그를 요구하는데 정작 위치를 알려주는
  // 곳이 없었다. 폴더가 아직 없으면 백엔드가 만들어서 연다.
  const btnOpenLogs = document.getElementById("btn-open-logs");
  if (btnOpenLogs) {
    btnOpenLogs.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await openLogFolder();
      } catch (err) {
        showNotification("로그 폴더를 열지 못했습니다: " + err, "error");
      }
    };
  }

  const btnCheckAppUpdate = document.getElementById("btn-check-app-update");
  const appVersionDesc = document.getElementById("app-version-desc");
  const btnOpenPrivacyPolicy = document.getElementById("btn-open-privacy-policy");
  const btnOpenTermsOfService = document.getElementById("btn-open-terms-of-service");
  const btnOpenFaq = document.getElementById("btn-open-faq");
  const btnOpenQa = document.getElementById("btn-open-qa");
  const btnOpenDiscord = document.getElementById("btn-open-discord");
  const btnOpenBugReport = document.getElementById("btn-open-bug-report");

  const openCompanionPage = async (url) => {
    const { showNotification } = await import('../../utils.js');
    try {
      await openAppPage(url);
    } catch (err) {
      console.error("[Companion] Failed to open page:", err);
      showNotification("브라우저에서 페이지를 열지 못했습니다.", "error");
    }
  };

  if (btnOpenPrivacyPolicy) btnOpenPrivacyPolicy.onclick = () => openCompanionPage(PRIVACY_URL);
  if (btnOpenTermsOfService) btnOpenTermsOfService.onclick = () => openCompanionPage(TERMS_URL);
  if (btnOpenFaq) btnOpenFaq.onclick = () => openCompanionPage(FAQ_URL);
  if (btnOpenQa) btnOpenQa.onclick = () => openCompanionPage(QA_URL);
  if (btnOpenDiscord) btnOpenDiscord.onclick = () => openCompanionPage(resolveDiscordUrl());
  if (btnOpenBugReport) btnOpenBugReport.onclick = () => openCompanionPage(GITHUB_ISSUES_BUG_URL);

  if (btnCheckAppUpdate) {
    btnCheckAppUpdate.onclick = async () => {
      const { showNotification, showUpdateAvailable } = await import('../../utils.js');
      btnCheckAppUpdate.disabled = true;
      try {
        const info = await checkForAppUpdate();
        const current = info?.currentVersion || info?.current_version || "?";
        const latest = info?.latestVersion || info?.latest_version || "?";
        if (appVersionDesc) {
          appVersionDesc.textContent = `현재 v${current} · GitHub 최신 v${latest}`;
        }
        if (info?.hasUpdate) {
          showUpdateAvailable(info);
        } else {
          showNotification("이미 최신 버전을 사용 중입니다.", "success");
        }
      } catch (err) {
        showNotification("업데이트 확인 실패: " + err, "error");
      } finally {
        btnCheckAppUpdate.disabled = false;
      }
    };
  }

  // 인트로 자동 건너뛰기 — 가사 싱크 탭에서 지정한 "보컬 시작 지점" 마커가
  // 있는 곡은 재생 시작 시 그 지점으로 자동 탐색(player.js::selectTrack).
  // 기본 켜짐, localStorage에 저장(다른 순수 프론트 토글과 동일 패턴).
  const toggleIntroSkip = document.getElementById('toggle-intro-skip');
  if (toggleIntroSkip) {
    const stored = localStorage.getItem('introSkipEnabled');
    toggleIntroSkip.checked = stored === null ? true : stored === 'true';
    toggleIntroSkip.onchange = (e) => {
      localStorage.setItem('introSkipEnabled', String(!!e.target.checked));
    };
  }

  // 우클릭 메뉴의 재생/가사 보기 항목 표시 여부 — 기본 숨김(false).
  // 메뉴를 단순하게 유지하되, 원하는 사용자는 여기서 되살릴 수 있음.
  [
    ['toggle-ctx-menu-play', 'ctxMenuPlayEnabled'],
    ['toggle-ctx-menu-lyrics', 'ctxMenuLyricsViewEnabled'],
  ].forEach(([elId, storageKey]) => {
    const toggle = document.getElementById(elId);
    if (!toggle) return;
    toggle.checked = localStorage.getItem(storageKey) === 'true';
    toggle.onchange = (e) => {
      localStorage.setItem(storageKey, String(!!e.target.checked));
    };
  });

  initMrCacheDirControls();
}

/**
 * MR 캐시 저장 위치 카드 — 현재/설정된 경로 표시 + 폴더 변경/기본값 복귀.
 * 변경은 오버라이드 파일에만 저장되고 앱 재시작 후 적용된다(백엔드가 세션
 * 내내 경로를 고정하므로, configured ≠ current면 "재시작 필요"로 안내).
 */
async function initMrCacheDirControls() {
  const statusEl = document.getElementById('mr-cache-dir-status');
  const changeBtn = document.getElementById('btn-change-cache-dir');
  const resetBtn = document.getElementById('btn-reset-cache-dir');
  if (!statusEl || !changeBtn || !resetBtn) return;

  const { invoke } = await import('../../tauri-bridge.js');

  const refresh = async () => {
    try {
      const info = await invoke('get_mr_cache_dir');
      if (!info) return;
      const isOverridden = !!info.configured;
      const pendingRestart = isOverridden
        ? info.configured !== info.current
        : info.current !== info.defaultDir;
      let html = `현재 위치: <span style="color: var(--text-main);">${info.current}</span>`;
      if (isOverridden && pendingRestart) {
        html += `<br>변경된 위치(재시작 후 적용): <span style="color: var(--accent-primary);">${info.configured}</span>`;
      } else if (!isOverridden && pendingRestart) {
        html += `<br><span style="color: var(--accent-primary);">기본 위치로 초기화됨 — 재시작 후 적용</span>`;
      }
      statusEl.innerHTML = html;
      resetBtn.style.display = isOverridden ? '' : 'none';
    } catch (err) {
      console.error('[Settings] get_mr_cache_dir failed:', err);
    }
  };

  changeBtn.onclick = async () => {
    try {
      changeBtn.disabled = true;
      const picked = await invoke('set_mr_cache_dir');
      if (picked) {
        const { showNotification } = await import('../../utils.js');
        showNotification('MR 캐시 저장 위치가 변경되었습니다. 앱을 재시작하면 적용됩니다.', 'success');
        await refresh();
      }
    } catch (err) {
      const { showNotification } = await import('../../utils.js');
      showNotification('저장 위치 변경 실패: ' + err, 'error');
    } finally {
      changeBtn.disabled = false;
    }
  };

  resetBtn.onclick = async () => {
    try {
      await invoke('reset_mr_cache_dir');
      const { showNotification } = await import('../../utils.js');
      showNotification('기본 저장 위치로 되돌렸습니다. 앱을 재시작하면 적용됩니다.', 'info');
      await refresh();
    } catch (err) {
      const { showNotification } = await import('../../utils.js');
      showNotification('초기화 실패: ' + err, 'error');
    }
  };

  refresh();
}
