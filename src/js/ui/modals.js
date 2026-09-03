/**
 * js/ui/modals.js - Modal Management (Edit, Confirm, etc.)
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { getSongCategory } from './library.js';
import { setMetaStarRating } from '../utils.js';
// 장르/카테고리 기준은 taxonomy.js 단일 소스 (docs/GENRE_CATEGORY_STANDARD.md).
import { GENRES, CATEGORIES } from '../taxonomy.js';
import { pushLayer, popLayer } from './layer-stack.js';

/** 열려 있는 오버레이 모달의 레이어 핸들 (요소 → handle) */
const modalLayers = new WeakMap();

/**
 * `.modal-overlay` 하나를 여는 공통 경로.
 *
 * 예전에는 모달마다 닫는 방법이 제각각이었다 — 어떤 것은 Esc가 되고 어떤
 * 것은 안 되고, 배경 클릭도 마찬가지였다. 더 나쁜 건 controls/library.js가
 * Esc에서 `.modal-overlay.active`를 통째로 지워 버려서, 각 모달이 정해 둔
 * 닫기 함수(closeEditModal 등)를 건너뛰고 상태가 남았다는 점이다.
 *
 * 여기를 통해 열면 Esc·배경 클릭·닫기 아이콘이 전부 같은 close로 모이고,
 * 포커스도 열기 전 자리로 돌아간다.
 *
 * @param {Element} el `.modal-overlay` 요소
 * @param {object} [opts]
 * @param {Function} [opts.onClose] 닫을 때 실행할 정리 작업
 * @param {string} [opts.closeIconId] 헤더 x 버튼의 id
 */
export function openOverlayModal(el, { onClose, closeIconId, autoFocus = true } = {}) {
  if (!el) return null;
  if (modalLayers.has(el)) closeOverlayModal(el);

  const close = () => closeOverlayModal(el);

  el.onclick = (event) => {
    if (event.target === el) close();
  };
  if (closeIconId) {
    const icon = document.getElementById(closeIconId);
    if (icon) icon.onclick = close;
  }

  el.classList.add('active');
  const handle = pushLayer({ id: el.id || 'modal', el, close, autoFocus });
  handle.onClose = onClose;
  modalLayers.set(el, handle);
  return handle;
}

/** openOverlayModal로 연 모달을 닫는다. 버튼 클릭 경로도 이걸 쓴다. */
export function closeOverlayModal(el) {
  if (!el) return;
  const handle = modalLayers.get(el);
  modalLayers.delete(el);
  el.classList.remove('active');
  if (handle) {
    popLayer(handle);
    handle.onClose?.();
  }
}

/** 커스텀 셀렉트(.custom-select)의 옵션 목록을 주어진 값들로 다시 만든다. */
function fillCustomSelect(dropdown, values) {
  const box = dropdown?.querySelector(".select-options");
  if (!box) return;
  box.innerHTML = [
    '<div class="option-item" data-value="">장르 선택...</div>',
    ...values.map((v) => `<div class="option-item" data-value="${v}">${v}</div>`),
  ].join("");
}

/** 커스텀 셀렉트에서 특정 값을 선택 상태로 표시. */
function selectCustomOption(dropdown, value) {
  const option = dropdown?.querySelector(`.option-item[data-value='${value}']`);
  const selectedText = dropdown?.querySelector(".selected-text");
  if (!option || !selectedText) return;
  selectedText.textContent = option.textContent;
  dropdown.querySelectorAll(".option-item").forEach((o) => o.classList.remove("selected"));
  option.classList.add("selected");
}

export function openEditModal(song, index) {
  if (!elements.metadataModal) return;

  state.editingSongIndex = index;

  // Fill modal fields
  document.getElementById("edit-title").value = song.title || "";
  document.getElementById("edit-artist").value = song.artist || "";

  // Genre Handling — 옵션은 taxonomy(GENRES)에서 만들어 노래 추가 모달과 항상 일치.
  const genreSelect = document.getElementById("edit-genre-select");
  const genreCustom = document.getElementById("edit-genre-custom");
  const genreDropdown = document.getElementById("edit-genre-dropdown");

  if (genreSelect && genreCustom && genreDropdown) {
    fillCustomSelect(genreDropdown, GENRES);
    const songGenre = (song.genre || "").trim();

    if (GENRES.includes(songGenre)) {
      genreSelect.value = songGenre;
      genreCustom.value = "";
      selectCustomOption(genreDropdown, songGenre);
    } else {
      // 표준에 없는 값(사용자 커스텀)은 '기타' + 직접 입력란에 원본 보존
      genreSelect.value = songGenre ? "기타" : "";
      genreCustom.value = songGenre;
      selectCustomOption(genreDropdown, songGenre ? "기타" : "");
    }
  }

  // 카테고리 — 표준 목록을 datalist 제안으로 제공(자유 입력도 허용).
  const catPresets = document.getElementById("edit-category-presets");
  if (catPresets) {
    catPresets.innerHTML = CATEGORIES.map((c) => `<option value="${c}"></option>`).join("");
  }
  document.getElementById("edit-category").value = getSongCategory(song) || "";
  document.getElementById("edit-tags").value = (song.tags || []).join(", ");
  const editVolume = document.getElementById("edit-volume");
  const editVolumeVal = document.getElementById("edit-volume-val");
  const editKey = document.getElementById("edit-key");
  const editBpm = document.getElementById("edit-bpm");
  if (editVolume) {
    const min = Number.parseFloat(editVolume.min || "0");
    const max = Number.parseFloat(editVolume.max || "120");
    const volume = Number.parseFloat(song.volume);
    const safeVolume = Number.isFinite(volume) ? Math.max(min, Math.min(max, volume)) : 100;
    editVolume.value = String(Math.round(safeVolume));
    if (editVolumeVal) editVolumeVal.textContent = String(Math.round(safeVolume));
  }
  if (editKey) {
    editKey.value = song.songKey || song.key || "";
  }
  if (editBpm) {
    editBpm.value = song.bpm ?? "";
  }
  const editLyricsLink = document.getElementById("edit-lyrics-link");
  if (editLyricsLink) {
    editLyricsLink.value = song.lyricsLink || song.lyrics_link || "";
  }

  // MR 분리 기록 (읽기 전용) — 분리 완료 시 캐시에 자동 저장된 모델/일시 표시.
  // 비동기 조회라 일단 숨겼다가 기록이 있으면 채워서 노출.
  const sepGroup = document.getElementById("edit-separation-info-group");
  const sepInfoEl = document.getElementById("edit-separation-info");
  if (sepGroup && sepInfoEl) {
    sepGroup.style.display = "none";
    sepInfoEl.textContent = "";
    const modalPath = song.path;
    import("../model-api.js").then(({ getSeparationInfo }) => getSeparationInfo(modalPath)).then((info) => {
      // 조회가 돌아왔을 때 모달이 다른 곡으로 바뀌었으면 무시
      const currentTitle = document.getElementById("edit-title");
      if (!info || !currentTitle) return;
      if (state.editingSongIndex === null || state.songLibrary[state.editingSongIndex]?.path !== modalPath) return;
      const when = info.completedAt
        ? new Date(info.completedAt * 1000).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
        : "";
      const provider = info.provider ? ` · ${info.provider}` : "";
      sepInfoEl.textContent = `${info.modelName || info.modelId || "알 수 없는 모델"}${provider}${when ? ` · ${when}` : ""}`;
      sepGroup.style.display = "";
    }).catch(() => {});
  }
  setMetaStarRating("edit-difficulty-stars", "edit-difficulty-select", song.difficulty);
  setMetaStarRating("edit-proficiency-stars", "edit-proficiency-select", song.proficiency);

  // MR Checkbox initialization
  const mrCheckbox = document.getElementById("edit-is-mr");
  if (mrCheckbox) {
    const isSeparated = !!(song.is_separated || song.isSeparated);
    mrCheckbox.checked = isSeparated || !!(song.is_mr || song.isMr);
    mrCheckbox.disabled = isSeparated;
    
    // Add visual feedback for disabled state
    const label = mrCheckbox.closest(".mr-checkbox-label");
    if (label) label.classList.toggle("disabled", isSeparated);
  }

  // Esc·배경 클릭도 반드시 아래 정리를 거치게 한다. 예전에는 Esc가
  // closeEditModal()을 건너뛰어서 editingSongIndex와 MR 체크박스의 disabled가
  // 남았고, 다음에 연 곡의 체크박스가 잠긴 채로 뜨는 일이 있었다.
  openOverlayModal(elements.metadataModal, { onClose: resetEditModalState });
}

/** 편집 모달을 닫은 뒤 남는 상태를 정리한다(다음에 열 때를 위해). */
function resetEditModalState() {
  const mrCheckbox = document.getElementById("edit-is-mr");
  if (mrCheckbox) {
    mrCheckbox.disabled = false;
    const label = mrCheckbox.closest(".mr-checkbox-label");
    if (label) label.classList.remove("disabled");
  }
  state.editingSongIndex = null;
}

export function closeEditModal() {
  if (elements.metadataModal) closeOverlayModal(elements.metadataModal);
  // openOverlayModal을 거치지 않고 열린 경우에도 상태는 정리되게 한다.
  resetEditModalState();
}

export function openConfirmModal(title, message, onConfirm) {
  if (!elements.confirmModal) return;
  
  const titleEl = elements.confirmModal.querySelector("h3");
  const msgEl = elements.confirmModal.querySelector("p");
  // Prefer current button IDs, but keep legacy fallback for compatibility.
  const confirmBtn = document.getElementById("confirm-ok") || document.getElementById("confirm-yes");
  const cancelBtn = document.getElementById("confirm-cancel") || document.getElementById("confirm-no");
  
  if (!confirmBtn || !cancelBtn) {
    console.error("[openConfirmModal] Confirm/Cancel buttons not found");
    return;
  }
  
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  
  confirmBtn.onclick = () => {
    onConfirm();
    closeConfirmModal();
  };
  
  cancelBtn.onclick = closeConfirmModal;

  // 헤더의 x·배경 클릭·Esc를 전부 취소 경로로 묶는다 — 확인 모달은 파일
  // 삭제처럼 되돌릴 수 없는 동작 앞에 서므로, 빠져나갈 길이 '취소' 버튼
  // 하나뿐이면 곤란하다. 셋 다 openOverlayModal이 붙여 준다.
  openOverlayModal(elements.confirmModal, { closeIconId: "confirm-close-icon" });

  // 되돌릴 수 없는 동작 앞이므로 초점은 '취소'에 둔다 — Enter를 습관적으로
  // 눌러도 삭제가 실행되지 않게.
  cancelBtn.focus();
}

export function closeConfirmModal() {
  if (elements.confirmModal) closeOverlayModal(elements.confirmModal);
}
