/**
 * AI toggle and model control listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';
import { toggleAiFeature } from '../../audio.js';
import { getAppHandler } from '../../app-context.js';
import {
  checkModelReady,
  deleteAiModel,
  downloadAiModel,
  getActiveSeparations,
  getModelSettings,
  updateModelSettings,
  listAllModels,
} from '../../model-api.js';

const modelDescMap = {
  kim: "일반적인 보컬·MR 분리에 적합합니다.",
  inst_hq_3: "MR(반주) 품질이 더 중요할 때 추천합니다.",
};

// Cache of the current model list (built-in + custom) for lookups.
let modelListCache = [];

function describeModel(modelId) {
  if (modelDescMap[modelId]) return modelDescMap[modelId];
  const entry = modelListCache.find((m) => m.id === modelId);
  if (entry && entry.isCustom) return "사용자가 추가한 커스텀 모델입니다.";
  return "";
}

/**
 * Rebuilds the AI model dropdown options from the backend list of built-in and
 * custom models, marking the currently active model as selected.
 */
export async function refreshModelDropdown() {
  const dropdown = document.getElementById("ai-model-select-dropdown");
  if (!dropdown) return;
  const optionsContainer = dropdown.querySelector(".select-options");
  if (!optionsContainer) return;

  let models = [];
  try {
    models = await listAllModels();
  } catch (err) {
    console.error("Failed to list models:", err);
    return;
  }
  modelListCache = Array.isArray(models) ? models : [];

  let activeId = "kim";
  try { activeId = await getModelSettings(); } catch (_) {}

  const labelFor = (m) => {
    if (m.id === "kim") return "Kim Vocal 2 (기본/고속)";
    if (m.id === "inst_hq_3") return "Inst HQ 3 (고품질 반주/MR)";
    return m.isCustom ? `${m.name} (커스텀)` : m.name;
  };

  const hasActive = modelListCache.some((m) => m.id === activeId);
  const effectiveActive = hasActive ? activeId : (modelListCache[0]?.id || "kim");

  optionsContainer.innerHTML = modelListCache
    .map((m) => {
      const selected = m.id === effectiveActive ? "selected" : "";
      const label = labelFor(m);
      return `<div class="option-item ${selected}" data-value="${m.id}">${label}</div>`;
    })
    .join("");

  const selectedText = document.getElementById("selected-model-text");
  const activeEntry = modelListCache.find((m) => m.id === effectiveActive);
  if (selectedText && activeEntry) selectedText.textContent = labelFor(activeEntry);

  const aiModelDesc = document.getElementById("ai-model-desc");
  if (aiModelDesc) aiModelDesc.textContent = describeModel(effectiveActive);
}

async function hasPendingSeparations() {
  const localActive = Object.values(state.activeTasks || {}).some((task) => {
    const s = String(task?.status || "").toLowerCase();
    const done =
      s === "finished" ||
      s === "cancelled" ||
      s === "error" ||
      s.startsWith("error:") ||
      s.includes("cancel");
    return !done;
  });
  if (localActive) return true;
  try {
    const activePaths = await getActiveSeparations();
    return Array.isArray(activePaths) && activePaths.length > 0;
  } catch (_) {
    return localActive;
  }
}

async function refreshModelUiState(modelId) {
  const { updateAiModelStatus } = await import('../../ui/components.js');
  const isReady = await checkModelReady(modelId);
  updateAiModelStatus(isReady);
}

export function initAiListeners() {
  if (elements.toggleVocal) {
    elements.toggleVocal.onchange = async (e) => {
      const isEnabled = e.target.checked;
      state.vocalEnabled = isEnabled;
      localStorage.setItem("vocalEnabled", isEnabled);
      await toggleAiFeature("vocal", isEnabled);
    };
  }

  // '가사' 토글은 전송부에서 뺐다 — 가사는 표의 '가사' 열, 가사 싱크 화면,
  // 별도 가사 창에서 다룬다.

  const aiModelSelect = document.getElementById("ai-model-select-dropdown");
  const aiModelDesc = document.getElementById("ai-model-desc");

  if (aiModelSelect) {
    aiModelSelect.addEventListener("click", async (e) => {
      const option = e.target.closest(".option-item");
      if (!option) return;
      const modelId = option.dataset.value;
      if (!modelId) return;

      try {
        await updateModelSettings(modelId);
        if (aiModelDesc) {
          aiModelDesc.textContent = describeModel(modelId);
        }
        await refreshModelUiState(modelId);
        const entry = modelListCache.find((m) => m.id === modelId);
        const label = entry ? entry.name : modelId;
        const { showNotification } = await import('../../utils.js');
        showNotification(`${label} 모델로 변경되었습니다.`, "info");
      } catch (err) {
        const { showNotification } = await import('../../utils.js');
        showNotification("모델 변경 실패: " + err, "error");
      }
    });
  }

  if (elements.btnDownloadModel) {
    elements.btnDownloadModel.onclick = async () => {
      try {
        const modelId = await getModelSettings();
        elements.btnDownloadModel.classList.add("loading-btn");
        elements.btnDownloadModel.disabled = true;
        await downloadAiModel(modelId);
        await refreshModelUiState(modelId);
        import('../../utils.js').then(m => m.showNotification("모델 다운로드 완료", "success"));
      } catch (err) {
        import('../../utils.js').then(m => m.showNotification("다운로드 실패: " + err, "error"));
      } finally {
        elements.btnDownloadModel.classList.remove("loading-btn");
        elements.btnDownloadModel.disabled = false;
      }
    };
  }

  if (elements.btnDeleteModel) {
    elements.btnDeleteModel.onclick = async () => {
      try {
        if (await hasPendingSeparations()) {
          const { showNotification } = await import('../../utils.js');
          showNotification("분리 작업(진행/대기열)이 있는 동안에는 모델을 삭제할 수 없습니다.", "warning");
          return;
        }

        const modelId = await getModelSettings();
        elements.btnDeleteModel.disabled = true;
        await deleteAiModel(modelId);
        await refreshModelUiState(modelId);
        import('../../utils.js').then(m => m.showNotification("모델이 삭제되었습니다.", "info"));
      } catch (err) {
        import('../../utils.js').then(m => m.showNotification("삭제 실패: " + err, "error"));
      } finally {
        elements.btnDeleteModel.disabled = false;
      }
    };
  }

  // Populate the model dropdown with built-in + custom models.
  refreshModelDropdown();
}
