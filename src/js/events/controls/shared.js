/**
 * Shared helpers for control event listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';

let audioSettingsSaveTimer = null;

export function isTextEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const editable = target.closest("input, textarea, [contenteditable='true']");
  if (!editable) return false;
  if (editable instanceof HTMLInputElement) {
    const unsupportedTypes = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "file", "image", "color"]);
    return !unsupportedTypes.has((editable.type || "").toLowerCase());
  }
  return true;
}

function setMenuItemState(item, enabled) {
  if (!item) return;
  item.classList.toggle("disabled", !enabled);
}

async function runInputAction(action, editable) {
  editable?.focus?.();
  switch (action) {
    case "undo":
      document.execCommand("undo");
      return;
    case "redo":
      document.execCommand("redo");
      return;
    case "cut":
      document.execCommand("cut");
      return;
    case "copy":
      document.execCommand("copy");
      return;
    case "paste": {
      const text = await navigator.clipboard.readText();
      if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        const start = editable.selectionStart ?? editable.value.length;
        const end = editable.selectionEnd ?? editable.value.length;
        editable.setRangeText(text, start, end, "end");
        editable.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (editable?.isContentEditable) {
        document.execCommand("insertText", false, text);
      }
      return;
    }
    case "selectAll":
      if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        editable.select();
      } else if (editable?.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editable);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return;
    default:
      return;
  }
}

export function showInputContextMenu(event, editable) {
  if (!elements.contextMenu) return;

  const songMenuIds = ["menu-play", "menu-lyrics-view", "menu-separate", "menu-delete-mr", "menu-edit", "menu-delete"];
  const inputMenuIds = [
    "menu-input-separator",
    "menu-undo",
    "menu-redo",
    "menu-cut",
    "menu-copy",
    "menu-paste",
    "menu-select-all",
  ];

  songMenuIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  inputMenuIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === "menu-input-separator" ? "block" : "block";
  });

  const menuUndo = document.getElementById("menu-undo");
  const menuRedo = document.getElementById("menu-redo");
  const menuCut = document.getElementById("menu-cut");
  const menuCopy = document.getElementById("menu-copy");
  const menuPaste = document.getElementById("menu-paste");
  const menuSelectAll = document.getElementById("menu-select-all");

  const hasValue = (editable.value?.length ?? editable.textContent?.length ?? 0) > 0;
  const hasSelection =
    editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
      ? (editable.selectionStart ?? 0) !== (editable.selectionEnd ?? 0)
      : !!window.getSelection()?.toString();
  const readOnly = !!editable.readOnly || editable.getAttribute?.("contenteditable") === "false";

  setMenuItemState(menuUndo, !readOnly);
  setMenuItemState(menuRedo, !readOnly);
  setMenuItemState(menuCut, !readOnly && hasSelection);
  setMenuItemState(menuCopy, hasSelection);
  setMenuItemState(menuPaste, !readOnly);
  setMenuItemState(menuSelectAll, hasValue);

  const bindAction = (el, action) => {
    if (!el) return;
    el.onclick = async () => {
      if (el.classList.contains("disabled")) return;
      const { showNotification } = await import("../../utils.js");
      try {
        await runInputAction(action, editable);
      } catch (err) {
        if (action === "paste") {
          showNotification("붙여넣기에 실패했습니다. (클립보드 접근 권한 확인)", "warning");
        }
      } finally {
        const { closeContextMenu } = await import("../../ui/components.js");
        closeContextMenu();
      }
    };
  };

  bindAction(menuUndo, "undo");
  bindAction(menuRedo, "redo");
  bindAction(menuCut, "cut");
  bindAction(menuCopy, "copy");
  bindAction(menuPaste, "paste");
  bindAction(menuSelectAll, "selectAll");

  const menuWidth = 200;
  const menuHeight = 260;
  let x = event.clientX;
  let y = event.clientY;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  if (x + menuWidth > winW) x = winW - menuWidth - 10;
  if (y + menuHeight > winH) y = winH - menuHeight - 10;
  if (x < 10) x = 10;
  if (y < 10) y = 10;

  elements.contextMenu.style.top = `${y}px`;
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.display = "flex";
  elements.contextMenu.classList.add("active");
  import("../../ui/components.js").then((m) => m.openContextMenuLayer());
}

export function persistCurrentTrackAudioSettings(partial) {
  const currentPath = state.currentTrack?.path;
  if (!currentPath) return;

  const song = state.songLibrary.find((s) => s.path === currentPath);
  if (!song) return;

  Object.assign(song, partial);
  Object.assign(state.currentTrack, partial);

  if (audioSettingsSaveTimer) {
    clearTimeout(audioSettingsSaveTimer);
  }
  audioSettingsSaveTimer = setTimeout(async () => {
    try {
      const { saveLibrary } = await import('../../audio.js');
      await saveLibrary(state.songLibrary);
    } catch (err) {
      console.error("Failed to persist per-track audio settings:", err);
    }
  }, 300);
}

export function setupDirectInput(displayEl, sliderEl) {
  displayEl.onclick = (e) => {
    e.stopPropagation();
    if (displayEl.querySelector("input")) return;

    const input = document.createElement("input");
    input.type = "number";
    input.className = "val-input";
    input.value = parseFloat(sliderEl.value);
    input.step = sliderEl.step;
    input.min = sliderEl.min;
    input.max = sliderEl.max;

    const originalText = displayEl.textContent;
    displayEl.textContent = "";
    displayEl.appendChild(input);
    input.focus();
    input.select();

    const save = () => {
      let val = parseFloat(input.value);
      if (isNaN(val)) val = parseFloat(sliderEl.value);
      val = Math.max(parseFloat(sliderEl.min), Math.min(parseFloat(sliderEl.max), val));
      sliderEl.value = val;
      sliderEl.dispatchEvent(new Event("input"));
    };

    input.onkeydown = (ev) => {
      if (ev.key === "Enter") save();
      if (ev.key === "Escape") displayEl.textContent = originalText;
    };

    input.onblur = () => {
      if (displayEl.contains(input)) save();
    };
  };
}

export function initContextMenuListener() {
  document.addEventListener("contextmenu", (e) => {
    if (!isTextEditableTarget(e.target)) return;
    e.preventDefault();
    const editable = e.target.closest("input, textarea, [contenteditable='true']");
    showInputContextMenu(e, editable);
  });
}
