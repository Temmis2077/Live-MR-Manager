import { describe, expect, it } from 'vitest';
import {
    ALIGNMENT_COMMAND,
    isTextEntryDescriptor,
    resolveAlignmentCommand,
    shouldToggleAlignmentPlayback,
} from '../src/js/alignment-input-policy.js';

describe('alignment Space policy', () => {
    it('reserves Space for playback throughout the alignment workspace', () => {
        for (const tagName of ['BUTTON', 'CANVAS', 'DIV', 'INPUT']) {
            const inputType = tagName === 'INPUT' ? 'range' : '';
            const textEditing = isTextEntryDescriptor(tagName, inputType, false);
            expect(shouldToggleAlignmentPlayback({ activeView: 'alignment', code: 'Space', textEditing })).toBe(true);
        }
    });

    it('allows Space only in actual text entry controls', () => {
        expect(isTextEntryDescriptor('TEXTAREA')).toBe(true);
        expect(isTextEntryDescriptor('INPUT', 'text')).toBe(true);
        expect(isTextEntryDescriptor('SPAN', '', true)).toBe(true);
        expect(shouldToggleAlignmentPlayback({ activeView: 'alignment', code: 'Space', textEditing: true })).toBe(false);
    });

    it('ignores key repeat and other app views', () => {
        expect(shouldToggleAlignmentPlayback({ activeView: 'alignment', code: 'Space', repeat: true })).toBe(false);
        expect(shouldToggleAlignmentPlayback({ activeView: 'library', code: 'Space' })).toBe(false);
        expect(shouldToggleAlignmentPlayback({ activeView: 'alignment', code: 'Enter' })).toBe(false);
    });
});

describe('alignment command router', () => {
    const context = { activeView: 'alignment', textEditing: false, layerOpen: false };

    it('keeps the confirmed Enter and Shift+Enter meanings', () => {
        expect(resolveAlignmentCommand(context, { code: 'Enter' }).command)
            .toBe(ALIGNMENT_COMMAND.CONFIRM_LINE_END);
        expect(resolveAlignmentCommand(context, { code: 'Enter', shiftKey: true }).command)
            .toBe(ALIGNMENT_COMMAND.ADJUST_LINE_START);
    });

    it('routes undo, redo and boundary nudges before view code handles them', () => {
        expect(resolveAlignmentCommand(context, { code: 'KeyZ', ctrlKey: true }).command)
            .toBe(ALIGNMENT_COMMAND.UNDO);
        expect(resolveAlignmentCommand(context, { code: 'KeyZ', ctrlKey: true, shiftKey: true }).command)
            .toBe(ALIGNMENT_COMMAND.REDO);
        expect(resolveAlignmentCommand({ ...context, hasBoundarySelection: true }, { code: 'ArrowRight', shiftKey: true }))
            .toMatchObject({ command: ALIGNMENT_COMMAND.NUDGE_BOUNDARY, deltaSec: 0.1 });
    });

    it('yields to text editing, IME composition and open layers', () => {
        expect(resolveAlignmentCommand({ ...context, textEditing: true }, { code: 'Enter' }).command)
            .toBe(ALIGNMENT_COMMAND.IGNORE);
        expect(resolveAlignmentCommand(context, { code: 'Enter', isComposing: true }).command)
            .toBe(ALIGNMENT_COMMAND.IGNORE);
        expect(resolveAlignmentCommand({ ...context, layerOpen: true }, { code: 'Space' }).command)
            .toBe(ALIGNMENT_COMMAND.IGNORE);
    });

    it('ignores repeated Space without disabling normal Space', () => {
        expect(resolveAlignmentCommand(context, { code: 'Space', repeat: true }).command)
            .toBe(ALIGNMENT_COMMAND.IGNORE);
        expect(resolveAlignmentCommand(context, { code: 'Space', repeat: false }).command)
            .toBe(ALIGNMENT_COMMAND.PLAYBACK_TOGGLE);
    });
});
