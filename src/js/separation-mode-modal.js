/**
 * separation-mode-modal.js — MR 분리 방식(속도/품질) 선택 모달
 *
 * 컨텍스트 메뉴의 "MR 분리"가 바로 분리를 시작하는 대신 이 모달을 띄운다:
 * MIT 기본 모델과 사용자가 직접 등록한 커스텀 모델을
 * 등록돼 있으면 드롭다운으로 추가 노출. 카드를 누르면 즉시 해당 모델로
 * start_mr_separation(path, modelId)이 호출된다(원탭 플로우). "기본값으로
 * 저장"을 켠 채 선택하면 전역 기본 모델(updateModelSettings)도 갱신.
 */
import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';

let initialized = false;
let pendingSong = null;
let pendingStartHandler = null;
let pendingPrompt = null;

export function partitionSeparationModels(models) {
    const custom = (models || []).filter((m) => m?.isCustom);
    return {
        baseModels: custom.filter((m) => m.presetKey !== 'melband_roformer_karaoke'),
        harmonyModels: custom.filter((m) => m.presetKey === 'melband_roformer_karaoke'),
    };
}

export function immediateSeparationModelId(element) {
    const id = element?.dataset?.modelId;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

function modal() { return document.getElementById('separation-mode-modal'); }

function closeModal() {
    const m = modal();
    if (m) import('./ui/modals.js').then((mod) => mod.closeOverlayModal(m));
    pendingSong = null;
    pendingStartHandler = null;
    pendingPrompt = null;
}

async function startWithModel(modelId, harmonyModelId = null) {
    const song = pendingSong;
    if (!song) return;
    const startHandler = pendingStartHandler;
    const saveDefault = document.getElementById('separation-mode-save-default')?.checked;
    closeModal();

    if (saveDefault && modelId) {
        try {
            await invoke('update_model_settings', { modelId });
            // AI 프로세싱 설정 화면의 모델 드롭다운도 새 기본값으로 동기화.
            import('./events/controls/ai.js').then((m) => {
                if (m.refreshModelDropdown) m.refreshModelDropdown();
            }).catch(() => {});
        } catch (err) {
            console.error('[SeparationMode] Failed to save default model:', err);
        }
    }

    try {
        if (startHandler) {
            await startHandler(modelId, harmonyModelId);
            return;
        }
        const { startMrSeparation } = await import('./audio.js');
        await startMrSeparation(song.path, modelId, harmonyModelId);
    } catch (err) {
        console.error('[SeparationMode] Separation trigger failed:', err);
    }
}

async function refreshModalState() {
    const titleEl = document.getElementById('separation-mode-song-title');
    if (titleEl && pendingSong) {
        titleEl.textContent = pendingPrompt
            || `"${pendingSong.title || pendingSong.path}" 곡을 어떤 방식으로 분리할까요?`;
        // 이전 분리 기록이 있으면 참고용으로 같이 표시 (재분리 판단에 도움)
        const songPath = pendingSong.path;
        import('./model-api.js').then(({ getSeparationInfo }) => getSeparationInfo(songPath)).then((info) => {
            if (!info || !pendingSong || pendingSong.path !== songPath) return;
            if (pendingPrompt) return;
            const when = info.completedAt
                ? new Date(info.completedAt * 1000).toLocaleDateString('ko-KR')
                : '';
            titleEl.textContent += ` (이전 분리: ${info.modelName || info.modelId}${when ? `, ${when}` : ''})`;
        }).catch(() => {});
    }
    const saveDefault = document.getElementById('separation-mode-save-default');
    if (saveDefault) saveDefault.checked = false;

    // 현재 전역 기본 모델 카드 하이라이트
    let activeId = 'melband_roformer_vocals_mit';
    try { activeId = await invoke('get_model_settings'); } catch (_) {}
    document.querySelectorAll('#separation-mode-modal .separation-mode-card').forEach((card) => {
        card.classList.toggle('current-default', card.dataset.modelId === activeId);
    });

    // 커스텀 모델을 일반 1차 모델과 리드/화음 2차 모델로 분리한다.
    const wrap = document.getElementById('separation-mode-custom-wrap');
    const select = document.getElementById('separation-mode-custom-select');
    if (!wrap || !select) return;
    let customs = [];
    try {
        const all = await invoke('list_all_models');
        customs = partitionSeparationModels(all).baseModels;
    } catch (_) {}
    if (customs.length === 0) {
        wrap.style.display = 'none';
    } else {
        wrap.style.display = 'flex';
        select.innerHTML = customs
            .map((m) => `<option value="${m.id}" ${m.id === activeId ? 'selected' : ''}>${m.name}</option>`)
            .join('');
    }
    const harmonyBase = document.getElementById('separation-mode-harmony-base');
    if (harmonyBase) {
        harmonyBase.innerHTML = [
            '<option value="melband_roformer_vocals_mit">1차: Mel-Band RoFormer Vocals (MIT)</option>',
            ...customs.map((m) => `<option value="${m.id}">1차: ${m.name}</option>`),
        ].join('');
    }

    const harmonySelect = document.getElementById('separation-mode-harmony-select');
    const harmonyStart = document.getElementById('separation-mode-harmony-start');
    const harmonyHint = document.getElementById('separation-mode-harmony-hint');
    if (harmonySelect && harmonyStart) {
        let allModels = [];
        try { allModels = await invoke('list_all_models'); } catch (_) {}
        const harmonyModels = partitionSeparationModels(allModels).harmonyModels;
        harmonySelect.innerHTML = harmonyModels
            .map((m) => `<option value="${m.id}">${m.name}</option>`)
            .join('');
        harmonyStart.disabled = harmonyModels.length === 0;
        if (harmonyHint) harmonyHint.textContent = harmonyModels.length
            ? '통합 보컬을 다시 처리해 리드와 화음/코러스를 별도 채널로 만듭니다.'
            : '커스텀 AI 모델에서 Mel-Band RoFormer Karaoke ONNX를 먼저 등록해주세요.';
    }
}

function initOnce() {
    if (initialized) return;
    initialized = true;
    const m = modal();
    if (!m) return;

    document.getElementById('separation-mode-close')?.addEventListener('click', closeModal);
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });

    // Only the two explicit one-click model buttons start immediately. The
    // advanced harmony panel uses the same visual card class, but clicks on
    // either selector must never bubble into a default separation request.
    m.querySelectorAll('.separation-mode-card[data-model-id]').forEach((card) => {
        card.addEventListener('click', () => {
            const modelId = immediateSeparationModelId(card);
            if (modelId) startWithModel(modelId);
        });
    });

    document.getElementById('separation-mode-custom-start')?.addEventListener('click', () => {
        const select = document.getElementById('separation-mode-custom-select');
        if (select && select.value) startWithModel(select.value);
    });
    document.getElementById('separation-mode-harmony-start')?.addEventListener('click', () => {
        const base = document.getElementById('separation-mode-harmony-base');
        const harmony = document.getElementById('separation-mode-harmony-select');
        if (base?.value && harmony?.value) startWithModel(base.value, harmony.value);
    });
}

/**
 * 분리 방식 선택 모달을 연다.
 * options.onStart를 주면 선택된 모델을 호출자에게 넘긴다(일괄 분리용).
 */
export function openSeparationModeModal(song, options = {}) {
    if (!song || !song.path) return;
    initOnce();
    const m = modal();
    if (!m) {
        // 선택 UI가 깨진 상태에서 사용자의 선택 없이 비싼 작업을 시작하지 않는다.
        showNotification('모델 선택창을 열 수 없어 MR 분리를 시작하지 않았습니다.', 'error');
        return false;
    }
    pendingSong = song;
    pendingStartHandler = typeof options.onStart === 'function' ? options.onStart : null;
    pendingPrompt = typeof options.prompt === 'string' ? options.prompt : null;
    refreshModalState();
    // Esc·배경 클릭도 닫기로 이어지게 공통 경로로 연다(예전에는 카드나
    // 닫기 버튼을 누르는 길밖에 없었다).
    import('./ui/modals.js').then((mod) => mod.openOverlayModal(m, {
        onClose: () => {
            pendingSong = null;
            pendingStartHandler = null;
            pendingPrompt = null;
        },
    }));
    return true;
}
