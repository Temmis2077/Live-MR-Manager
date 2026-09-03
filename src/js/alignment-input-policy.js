const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);

export function isTextEntryDescriptor(tagName, inputType = 'text', contentEditable = false) {
    if (contentEditable) return true;
    const tag = String(tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    return TEXT_INPUT_TYPES.has(String(inputType || 'text').toLowerCase());
}

export function shouldToggleAlignmentPlayback({ activeView, code, repeat = false, textEditing = false }) {
    return activeView === 'alignment'
        && code === 'Space'
        && !repeat
        && !textEditing;
}

export const ALIGNMENT_COMMAND = Object.freeze({
    PLAYBACK_TOGGLE: 'PLAYBACK_TOGGLE',
    CONFIRM_LINE_END: 'CONFIRM_LINE_END',
    ADJUST_LINE_START: 'ADJUST_LINE_START',
    NUDGE_BOUNDARY: 'NUDGE_BOUNDARY',
    UNDO: 'UNDO',
    REDO: 'REDO',
    CANCEL_SELECTION: 'CANCEL_SELECTION',
    IGNORE: 'IGNORE',
});

/**
 * 가사 싱크 화면의 키 의미를 DOM 처리와 분리한다. 새 컨트롤이나 모달이
 * 추가돼도 이 함수의 우선순위 표만 통과해야 하므로 단축키 회귀를 막을 수 있다.
 */
export function resolveAlignmentCommand(context = {}, event = {}) {
    const {
        activeView,
        textEditing = false,
        layerOpen = false,
        hasBoundarySelection = false,
    } = context;
    if (activeView !== 'alignment' || layerOpen || textEditing || event.isComposing) {
        return { command: ALIGNMENT_COMMAND.IGNORE };
    }

    const commandKey = !!(event.ctrlKey || event.metaKey);
    if (commandKey && !event.altKey && event.code === 'KeyZ') {
        return { command: event.shiftKey ? ALIGNMENT_COMMAND.REDO : ALIGNMENT_COMMAND.UNDO };
    }
    if (commandKey && !event.altKey && event.code === 'KeyY') {
        return { command: ALIGNMENT_COMMAND.REDO };
    }
    if (event.code === 'Space') {
        return { command: event.repeat ? ALIGNMENT_COMMAND.IGNORE : ALIGNMENT_COMMAND.PLAYBACK_TOGGLE };
    }
    if (event.code === 'Enter') {
        return { command: event.shiftKey
            ? ALIGNMENT_COMMAND.ADJUST_LINE_START
            : ALIGNMENT_COMMAND.CONFIRM_LINE_END };
    }
    if (hasBoundarySelection && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        const direction = event.code === 'ArrowRight' ? 1 : -1;
        return {
            command: ALIGNMENT_COMMAND.NUDGE_BOUNDARY,
            deltaSec: direction * (event.shiftKey ? 0.1 : 0.01),
        };
    }
    if (event.code === 'Escape' && hasBoundarySelection) {
        return { command: ALIGNMENT_COMMAND.CANCEL_SELECTION };
    }
    return { command: ALIGNMENT_COMMAND.IGNORE };
}
