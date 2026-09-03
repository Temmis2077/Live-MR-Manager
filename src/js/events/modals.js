/**
 * js/events/modals.js - Modal Event Handlers (Save, Cancel, Search)
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { invoke } from '../tauri-bridge.js';
import { initMetaStarRatings, showNotification } from '../utils.js';
import { openOverlayModal, closeOverlayModal } from '../ui/modals.js';
import { libraryService } from '../../ipc/services/library.js';

export function initModalListeners() {
  initMetaStarRatings();
  const btnAnalyzeKeyBpm = document.getElementById('btn-analyze-key-bpm');
  if (btnAnalyzeKeyBpm) {
    btnAnalyzeKeyBpm.onclick = async () => {
      const idx = state.editingSongIndex;
      if (idx === null || idx < 0) return;
      const song = state.songLibrary[idx];
      if (!song?.path) return;
      btnAnalyzeKeyBpm.classList.add('is-analyzing');
      btnAnalyzeKeyBpm.disabled = true;
      try {
        const res = await invoke('analyze_key_bpm', { path: song.path });
        const ek = document.getElementById('edit-key');
        const eb = document.getElementById('edit-bpm');
        if (ek) ek.value = res.key || '';
        if (eb && res.bpm != null && Number.isFinite(res.bpm)) {
          eb.value = String(Math.round(res.bpm));
        }
        showNotification('KEY/BPM 분석을 반영했습니다.', 'success');
      } catch (err) {
        showNotification('분석 실패: ' + err, 'error');
      } finally {
        btnAnalyzeKeyBpm.classList.remove('is-analyzing');
        btnAnalyzeKeyBpm.disabled = false;
      }
    };
  }

  if (elements.editVolume) {
    elements.editVolume.oninput = async (e) => {
      const raw = Number.parseFloat(e.target.value);
      const min = Number.parseFloat(elements.editVolume.min || "0");
      const max = Number.parseFloat(elements.editVolume.max || "120");
      const val = Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : min;
      const rounded = Math.round(val);
      if (elements.editVolumeVal) elements.editVolumeVal.textContent = String(rounded);

      // Live preview: while editing the currently playing track, apply volume immediately.
      const idx = state.editingSongIndex;
      const editingSong = (idx !== null && idx >= 0) ? state.songLibrary[idx] : null;
      if (editingSong && state.currentTrack && state.currentTrack.path === editingSong.path) {
        await invoke('set_volume', { volume: rounded });
      }
    };
    elements.editVolume.addEventListener("wheel", (e) => {
      e.preventDefault();
      const min = Number.parseFloat(elements.editVolume.min || "0");
      const max = Number.parseFloat(elements.editVolume.max || "120");
      let val = Number.parseFloat(elements.editVolume.value);
      if (e.deltaY < 0) val += 2; else val -= 2;
      val = Math.max(min, Math.min(max, val));
      elements.editVolume.value = String(Math.round(val));
      elements.editVolume.dispatchEvent(new Event("input"));
    }, { passive: false });
    elements.editVolume.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      elements.editVolume.value = "100";
      elements.editVolume.dispatchEvent(new Event("input"));
    });
  }

  // Metadata Save
  const btnSave = document.getElementById("modal-save");
  if (btnSave) {
    btnSave.onclick = async () => {
      const idx = state.editingSongIndex;
      if (idx == null || idx < 0) {
        showNotification("편집 중인 곡을 찾을 수 없습니다.", "error");
        return;
      }

      const song = state.songLibrary[idx];
      if (!song?.path) {
        showNotification("곡 경로가 없어 저장할 수 없습니다.", "error");
        return;
      }

      btnSave.disabled = true;
      const prevLabel = btnSave.textContent;
      btnSave.textContent = "저장 중…";

      const volMin = Number.parseFloat(elements.editVolume?.min || "0");
      const volMax = Number.parseFloat(elements.editVolume?.max || "120");
      const inputVolume = Number.parseFloat(elements.editVolume?.value);
      const safeVolume = Number.isFinite(inputVolume)
        ? Math.max(volMin, Math.min(volMax, inputVolume))
        : (Number.isFinite(song?.volume) ? song.volume : 100);
      const isManualMr = document.getElementById("edit-is-mr").checked;
      const wasSeparated = !!(song.isSeparated || song.is_separated);
      const categoryText = document.getElementById("edit-category").value.trim();
      const updated = {
        ...song,
        title: document.getElementById("edit-title").value,
        artist: document.getElementById("edit-artist").value,
        genre: document.getElementById("edit-genre-custom").value.trim() || document.getElementById("edit-genre-select").value,
        categories: categoryText ? [categoryText] : [],
        curationCategory: categoryText || null,
        tags: document.getElementById("edit-tags").value.split(",").map(t => t.trim()).filter(t => t),
        volume: safeVolume,
        songKey: (document.getElementById("edit-key")?.value || "").trim(),
        lyricsLink: (document.getElementById("edit-lyrics-link")?.value || "").trim() || null,
        bpm: (() => {
          const raw = Number.parseInt(document.getElementById("edit-bpm")?.value || "", 10);
          return Number.isFinite(raw) ? raw : null;
        })(),
        difficulty: (() => {
          const raw = Number.parseInt(document.getElementById("edit-difficulty-select")?.value || "", 10);
          return Number.isFinite(raw) && raw >= 1 && raw <= 5 ? raw : null;
        })(),
        proficiency: (() => {
          const raw = Number.parseInt(document.getElementById("edit-proficiency-select")?.value || "", 10);
          return Number.isFinite(raw) && raw >= 1 && raw <= 5 ? raw : null;
        })(),
        isMr: isManualMr,
        is_mr: isManualMr,
        isSeparated: wasSeparated,
        is_separated: wasSeparated,
      };

      try {
        await libraryService.update(updated);
        state.songLibrary[idx] = updated;
        if (state.currentTrack && state.currentTrack.path === updated.path) {
          state.currentTrack = updated;
          await invoke('set_volume', { volume: safeVolume });
        }

        const { closeEditModal } = await import('../ui/modals.js');
        closeEditModal();

        const { renderLibrary } = await import('../ui/library.js');
        renderLibrary();
        const { refreshLibraryPanels } = await import('../ui/library-panels.js');
        refreshLibraryPanels();
        showNotification("정보가 수정되었습니다.", "success");

        const { refreshFilterDropdowns } = await import('../ui/core.js');
        refreshFilterDropdowns().catch((err) => {
          console.warn("[Modal Save] Filter refresh failed:", err);
        });
      } catch (err) {
        showNotification("수정 실패: " + err, "error");
      } finally {
        btnSave.disabled = false;
        btnSave.textContent = prevLabel;
      }
    };
  }

  // '곡 정보 관리자' 모달은 제거했다 — 일괄 편집은 음원 관리 표의 선택 모드,
  // 개별 편집은 우측 인스펙터에서 한다(창을 따로 열 이유가 없다).

  // Modal Cancel/Close
  const modalCancel = document.getElementById("modal-cancel");
  const modalClose = document.getElementById("modal-close");
  
  const closeModal = async () => {
    const { closeEditModal } = await import('../ui/modals.js');
    closeEditModal();
  };

  if (modalCancel) modalCancel.onclick = closeModal;
  if (modalClose) modalClose.onclick = closeModal;

  // Online Metadata Search
  if (elements.btnMetadataSearch) {
    elements.btnMetadataSearch.onclick = async () => {
      const title = document.getElementById("edit-title").value;
      const artist = document.getElementById("edit-artist").value;
      const query = `${title} ${artist}`.trim();
      if (!query) return;

      // 정보 수정 모달 위에 겹쳐 뜬다 — layer-stack이 Esc를 최상단 하나에만
      // 주므로, Esc를 누르면 검색 결과만 닫히고 편집 모달은 남는다.
      openOverlayModal(elements.metadataSearchResultsModal, { autoFocus: false });
      elements.searchResultsList.innerHTML = `
        <div class="loading-container" style="text-align:center; padding:20px;">
          <div class="spinner"></div>
          <div style="margin-top:10px;">온라인에서 곡 정보를 검색 중입니다...</div>
        </div>
      `;

      try {
        const results = await invoke("search_track_metadata", { query });
        elements.searchResultsList.innerHTML = "";
        if (results.length === 0) {
          elements.searchResultsList.innerHTML = '<div class="loading-container" style="color: #666;">검색 결과가 없습니다.</div>';
          return;
        }

        results.forEach(res => {
          const item = document.createElement("div");
          item.className = "search-result-item";
          const isUnknownGenre = !res.genre || res.genre.toLowerCase() === "unknown" || res.genre.toLowerCase() === "unknown genre";
          const genreHtml = !isUnknownGenre
            ? `<div class="track-genre-preview">${res.genre}</div>`
            : "";
          const tagsHtml = res.tags && res.tags.length > 0
            ? `<div class="track-tags-preview">${res.tags.map(t => `<span class="tag-badge-mini">${t}</span>`).join("")}</div>`
            : "";
          item.innerHTML = `
            <div class="search-result-info">
              <div class="track-name">${res.name || res.title || ""}</div>
              <div class="artist-name">${res.artist || ""}</div>
              ${genreHtml}
            </div>
            ${tagsHtml}
          `;
          item.onclick = () => {
            document.getElementById("edit-title").value = res.name || res.title || "";
            document.getElementById("edit-artist").value = res.artist || "";
            
            // 1. 장르 정보 업데이트
            const isUnknown = !res.genre || res.genre.toLowerCase() === "unknown" || res.genre.toLowerCase() === "unknown genre";
            if (!isUnknown) {
              document.getElementById("edit-genre-custom").value = res.genre;
              const genreSelect = document.getElementById("edit-genre-select");
              if (genreSelect) genreSelect.value = ""; // 드롭다운 선택 초기화
              const genreText = document.querySelector("#edit-genre-dropdown .selected-text");
              if (genreText) genreText.textContent = "장르 선택...";
            }
            
            // 2. 태그 정보 업데이트
            if (res.tags && res.tags.length > 0) {
              document.getElementById("edit-tags").value = res.tags.join(", ");
            }
            
            // 3. 썸네일 정보 업데이트
            const coverUrl = res.thumbnail || res.image || res.cover_url || res.cover;
            if (coverUrl) {
              const thumbEl = document.getElementById("edit-thumbnail-url");
              if (thumbEl) thumbEl.value = coverUrl;
            }

            closeOverlayModal(elements.metadataSearchResultsModal);
          };
          elements.searchResultsList.appendChild(item);
        });
      } catch (err) {
        elements.searchResultsList.innerHTML = '<div class="loading-container" style="color: var(--accent-red);">검색 중 오류가 발생했습니다.</div>';
      }
    };
  }

  // Metadata Search Result Close
  if (elements.searchResultsClose) {
    elements.searchResultsClose.onclick = () => {
      closeOverlayModal(elements.metadataSearchResultsModal);
    };
  }
}
