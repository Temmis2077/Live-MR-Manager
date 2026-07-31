/**
 * alignment-queue.js — AI 가사 정렬 배치 대기열 (헤드리스 순차 처리기)
 *
 * 라이브러리에서 여러 곡을 선택해 일괄 정렬을 요청하면, 여기서 한 곡씩
 * 순서대로 처리한다: LRC 로드 → 미싱크 가사 추출 → run_forced_alignment →
 * 결과 병합(mergeAlignmentResult, 에디터와 동일 규칙) → LRC 저장.
 *
 * 반드시 엄격한 순차 처리여야 한다 — 백엔드의 `alignment-progress` 이벤트에는
 * 곡 식별자가 없어서, "지금 processing인 항목이 곧 이 이벤트의 주인"이라는
 * 가정으로 진행률을 귀속시키기 때문. (백엔드 쪽도 ALIGNMENT_QUEUE_LOCK으로
 * 직렬화되므로, 에디터의 단발 정렬 버튼과 겹쳐도 상태가 꼬이지 않는다.)
 */
import { invoke, listen } from './tauri-bridge.js';
import { state } from './state.js';
import { parseLrc, parseMarkers, mergeAlignmentResult, getSyncText, encodeLrc, isStructureDirective } from './lrc-parser.js';
import { showNotification } from './utils.js';
import { buildAlignmentLyrics, isEnglishLine } from './eng-to-kor.js';
import { attachMissingSegmentIds, gateAlignmentLines } from './alignment-quality.js';

let isRunning = false;
let listenerReady = false;

function createAlignmentTraceId(path) {
    const name = String(path || 'song').split(/[\\/]/).pop().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'song';
    return `${Date.now()}-${name}`;
}

/** Debug builds append these records to `logs/alignment-debug/<run>.jsonl`.
 * The Rust command is a no-op in release builds because lyrics are sensitive. */
async function traceAlignment(runId, stage, payload) {
    try {
        return await invoke('write_alignment_debug_trace', { runId, stage, payload });
    } catch (err) {
        console.warn('[AlignQueue] debug trace failed:', err);
        return '';
    }
}

function traceInputSummary(texts, entries) {
    const values = (texts || []).map((text) => String(text || ''));
    return {
        lineCount: values.length,
        nonEmptyLineCount: values.filter((text) => text.trim()).length,
        blankInputIndices: values.map((text, index) => text.trim() ? null : index).filter((index) => index != null),
        totalCharacterCount: values.reduce((sum, text) => sum + Array.from(text).length, 0),
        ids: (entries || []).map((entry) => entry.id),
    };
}

function traceGateSummary(gate) {
    const reasonCounts = {};
    (gate?.rejected || []).forEach(({ reasons }) => {
        (reasons || []).forEach((reason) => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; });
    });
    return {
        acceptedIds: (gate?.accepted || []).map((line) => line.segment_id),
        rejectedIds: (gate?.rejected || []).map(({ line }) => line?.segment_id).filter(Boolean),
        reasonCounts,
        acceptedCount: gate?.accepted?.length || 0,
        rejectedCount: gate?.rejected?.length || 0,
        confidenceFloor: gate?.confidenceFloor ?? null,
    };
}

function traceSegmentMap(originalSegments, workingSegments, entries) {
    const entryByIndex = new Map((entries || []).map((entry) => [entry.segmentIndex, entry]));
    return (originalSegments || []).map((original, index) => {
        const working = workingSegments?.[index] || original;
        const entry = entryByIndex.get(index);
        return {
            index,
            id: entry?.id || `segment:${index}`,
            originalText: String(original?.original ?? original?.text ?? ''),
            alignmentText: getSyncText(working),
            pronunciation: working?.pronunciation || null,
            start: Number(original?.start || 0),
            end: Number(original?.end || 0),
            approx: original?.approx === true,
            includedInPrimary: entry ? !entry.skipPrimary : false,
            skipPrimary: entry?.skipPrimary === true,
            fallbackCandidate: entry?.fallbackCandidate === true,
        };
    });
}

function buildFallbackAnchorLines(primaryLines, provisionalLines, entries) {
    const entryById = new Map((entries || []).map((entry) => [entry.id, entry]));
    const byId = new Map();
    (primaryLines || []).forEach((line) => {
        if (line?.segment_id) byId.set(line.segment_id, line);
    });
    // The provisional pass is not saved, but its non-English line timings are
    // more useful for locating English windows than a Korean-only path that
    // may have pulled the following Korean cue across the omitted English gap.
    (provisionalLines || []).forEach((line) => {
        const entry = entryById.get(line?.segment_id);
        if (!entry || entry.fallbackCandidate || !Number.isFinite(line?.start_ms) || !Number.isFinite(line?.end_ms)) return;
        byId.set(line.segment_id, line);
    });
    return [...byId.values()].sort((a, b) => {
        const ai = Number(String(a.segment_id || '').split(':')[1]);
        const bi = Number(String(b.segment_id || '').split(':')[1]);
        return (Number.isFinite(ai) ? ai : Infinity) - (Number.isFinite(bi) ? bi : Infinity);
    });
}

function traceTimingAudit(beforeSegments, afterSegments) {
    const changes = [];
    const unsyncedIds = [];
    const reversePairs = [];
    let previous = null;
    let textChangedCount = 0;
    (afterSegments || []).forEach((after, index) => {
        const before = beforeSegments?.[index] || {};
        const beforeText = String(before.original ?? before.text ?? '');
        const afterText = String(after?.original ?? after?.text ?? '');
        const beforeStart = Number(before.start || 0);
        const beforeEnd = Number(before.end || 0);
        const afterStart = Number(after?.start || 0);
        const afterEnd = Number(after?.end || 0);
        const active = afterEnd > afterStart;
        if (!active) unsyncedIds.push(`segment:${index}`);
        if (beforeText !== afterText) textChangedCount++;
        if (active && previous && afterStart < previous.start) {
            reversePairs.push({ previousId: previous.id, id: `segment:${index}`, previousStart: previous.start, start: afterStart });
        }
        if (active) previous = { id: `segment:${index}`, start: afterStart };
        if (beforeStart !== afterStart || beforeEnd !== afterEnd) {
            changes.push({
                id: `segment:${index}`,
                index,
                text: afterText,
                before: { start: beforeStart, end: beforeEnd },
                after: { start: afterStart, end: afterEnd },
                duration: afterEnd - afterStart,
                approx: after?.approx === true,
            });
        }
    });
    return {
        changedCount: changes.length,
        changes,
        appliedIds: changes.filter((change) => change.after.end > change.after.start).map((change) => change.id),
        unsyncedIds,
        reversePairs,
        textChangedCount,
        activeCount: (afterSegments || []).length - unsyncedIds.length,
        sourceTextOrderPreserved: textChangedCount === 0,
        monotonicOrderPreserved: reversePairs.length === 0,
    };
}

const TIMELINE_ORDER_TOLERANCE_SEC = 0.08;

function clearAutoTiming(segment) {
    if (!segment || segment.approx !== true) return false;
    segment.start = 0;
    segment.end = 0;
    return true;
}

/**
 * Fallback 결과가 이미 적용된 한국어 줄과 시간 순서를 뒤집지 않도록
 * 저장 직전에 검사한다. 자동 결과끼리 충돌하면 confidence가 약한 줄만
 * 미싱크로 되돌리고, 수동 싱크가 끼면 수동 줄을 기준으로 자동 줄을
 * 버린다. 어느 경우에도 시간을 강제로 이동하거나 원문 순서를 바꾸지 않는다.
 */
export function enforceAiTimelineOrder(segments) {
    const dropped = [];
    let changed = true;
    while (changed) {
        changed = false;
        let previous = null;
        for (let index = 0; index < (segments || []).length; index++) {
            const current = segments[index];
            if (!current || !(current.end > current.start)) continue;
            if (!previous || current.start >= previous.segment.start - TIMELINE_ORDER_TOLERANCE_SEC) {
                previous = { index, segment: current };
                continue;
            }

            const previousManual = previous.segment.approx !== true;
            const currentManual = current.approx !== true;
            let dropIndex;
            let reason;
            if (previousManual && !currentManual) {
                dropIndex = index;
                reason = 'out_of_order_against_manual';
            } else if (!previousManual && currentManual) {
                dropIndex = previous.index;
                reason = 'out_of_order_against_manual';
            } else if (!previousManual && !currentManual) {
                const previousConfidence = Number(previous.segment.confidence) || 0;
                const currentConfidence = Number(current.confidence) || 0;
                dropIndex = currentConfidence > previousConfidence ? previous.index : index;
                reason = 'out_of_order_weaker_auto';
            } else {
                // 두 수동 싱크가 모순되면 어느 쪽도 자동으로 수정하지 않는다.
                previous = { index, segment: current };
                continue;
            }

            const droppedSegment = segments[dropIndex];
            if (!clearAutoTiming(droppedSegment)) {
                previous = { index, segment: current };
                continue;
            }
            dropped.push({
                id: `segment:${dropIndex}`,
                index: dropIndex,
                text: getSyncText(droppedSegment),
                reason,
                confidence: Number(droppedSegment.confidence) || 0,
            });
            changed = true;
            break;
        }
    }
    return dropped;
}

// 한 항목의 정렬이 성공적으로 끝났을 때 (path, alignmentLines)로 호출되는
// 리스너들. 가사 싱크 에디터가 지금 열어둔 곡이 처리되면 결과를 즉시
// 반영(in-memory 병합, approx 표시 보존)하는 데 쓴다.
const itemCompleteListeners = [];
export function onAlignmentItemComplete(cb) {
    if (typeof cb === 'function') itemCompleteListeners.push(cb);
}
function notifyItemComplete(path, lines, segments = null) {
    itemCompleteListeners.forEach((cb) => {
        try { cb(path, lines, segments); } catch (e) { console.error('[AlignQueue] complete listener failed:', e); }
    });
}

/** 대기열에 처리 중이거나 대기 중인 항목이 있는지. */
export function isAlignmentBusy() {
    return state.alignmentQueue.some((i) => i.status === 'queued' || i.status === 'processing');
}

// ── MR 분리 후 정렬 (노래 추가 원스톱 흐름) ─────────────────────────
// 정렬 엔진은 분리된 보컬 스템을 우선 사용하므로, 분리와 정렬을 함께
// 요청한 곡은 분리가 끝난 뒤에 정렬을 걸어야 정확하다. 분리 완료 이벤트는
// backend.js의 separation-progress 리스너가 받아 onSeparationTerminated를
// 호출해준다.
const pendingAfterSeparation = new Set();

/** 이 곡의 정렬을 분리 종료 시점까지 미룬다. */
export function deferAlignmentUntilSeparated(path) {
    if (path) pendingAfterSeparation.add(path);
}

/**
 * 분리가 종료(완료/오류/취소)된 곡에 미뤄둔 정렬이 있으면 대기열에 등록.
 * 오류/취소로 끝나도 정렬은 진행한다 — 가사는 이미 저장돼 있고, 원본
 * 음원으로도 정렬은 (정확도는 낮지만) 가능하므로 사용자의 요청을 버리지
 * 않는다. matches는 유튜브 URL 변형까지 비교하는 backend.js의 pathMatches.
 */
export function onSeparationTerminated(path, matches = null) {
    for (const pending of [...pendingAfterSeparation]) {
        if (pending === path || (matches && matches(pending, path))) {
            pendingAfterSeparation.delete(pending);
            enqueueAlignment([pending]);
        }
    }
}

function notifyQueueChanged() {
    persistQueue();
    import('./ui/components.js').then((m) => {
        if (m.updateTaskUI) m.updateTaskUI();
    }).catch(() => {});
    // 가사 싱크 에디터 등 큐 상태에 반응해야 하는 UI용 (예: "AI 자동 정렬"
    // 버튼의 변환 중 표시). 직접 import 대신 이벤트로 느슨하게 연결.
    try { window.dispatchEvent(new CustomEvent('alignment-queue-changed')); } catch (e) {}
}

// ── 대기열 영속화 ───────────────────────────────────────────────────
// 정렬은 곡당 수십 초~분 단위라 작업 도중 앱을 끄거나 PC를 재시작하는 일이
// 흔하다. 아직 끝나지 않은 항목만 저장해 뒀다가 다음 실행에서 이어서 처리한다.
// (완료/오류/취소 등 종결 항목은 남길 이유가 없어 저장하지 않는다.)
const QUEUE_STORAGE_KEY = 'alignmentQueueV1';

function persistQueue() {
    try {
        const pending = (state.alignmentQueue || [])
            .filter((i) => i.status === 'queued' || i.status === 'processing')
            .map((i) => ({ path: i.path, title: i.title, thumbnail: i.thumbnail }));
        if (pending.length === 0) localStorage.removeItem(QUEUE_STORAGE_KEY);
        else localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(pending));
    } catch (err) {
        console.warn('[AlignQueue] persist failed:', err);
    }
}

/**
 * 앱 시작 시 호출 — 지난 실행에서 남은 정렬 항목을 복원하고 이어서 처리한다.
 * 처리 중이던 항목도 백엔드 작업은 이미 사라졌으므로 '대기 중'으로 되돌린다.
 */
export function restoreAlignmentQueue() {
    let saved = [];
    try {
        const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
        if (!raw) return 0;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) saved = parsed;
    } catch (err) {
        console.warn('[AlignQueue] restore failed:', err);
        return 0;
    }

    let restored = 0;
    saved.forEach((item) => {
        if (!item || !item.path) return;
        if (state.alignmentQueue.some((i) => i.path === item.path)) return;
        const song = state.songLibrary.find((s) => s.path === item.path);
        state.alignmentQueue.push({
            path: item.path,
            title: song?.title || item.title || item.path,
            thumbnail: song?.thumbnail || item.thumbnail || '',
            status: 'queued',
        });
        restored++;
    });

    if (restored > 0) {
        notifyQueueChanged();
        runQueue();
    }
    return restored;
}

function currentProcessingItem() {
    return state.alignmentQueue.find((item) => item.status === 'processing') || null;
}

async function ensureProgressListener() {
    if (listenerReady) return;
    listenerReady = true;
    await listen('alignment-progress', (event) => {
        const item = currentProcessingItem();
        if (!item) return; // 에디터의 단발 정렬 진행률 — 대기열 소관 아님
        const p = Number(event.payload);
        if (p === -1) {
            // 백엔드 락 대기 센티널 — 이미 '대기 중' 표시라 그대로 둠
            return;
        }
        if (p === -2) {
            // 전처리 + 모델 로드 준비 단계 — 0%가 아니라 "준비 중"으로 표시.
            item.phase = 'preparing';
            notifyQueueChanged();
            return;
        }
        if (Number.isFinite(p)) {
            // 실제 추론 진행률 도착 → 정렬 단계로 전환. 듀얼(랩/혼합) 모드는
            // 패스마다 offset/scale을 걸어 전체 0~100%로 이어 보이게 한다.
            item.phase = 'aligning';
            const scaled = (item.progressOffset || 0) + p * (item.progressScale || 1);
            item.percentage = Math.max(0, Math.min(100, scaled));
            notifyQueueChanged();
        }
    });
}

/** 선택한 정렬 언어(localStorage)에 필요한 설치 모델들을 언어별로 반환.
 *  단일 언어는 1개, 랩/혼합은 ko+en 2개. 하나라도 없으면 null(배치 중에는
 *  다운로드 프롬프트를 띄우지 않음). 반환: [{lang, model}] */
async function resolveAlignmentModels() {
    let models = [];
    try {
        models = await invoke('get_model_list');
    } catch (err) {
        console.error('[AlignQueue] get_model_list failed:', err);
        return null;
    }
    const { getAlignmentLanguage, findModelForLanguage, requiredLanguagesFor } = await import('./alignment-model.js');
    const langs = requiredLanguagesFor(getAlignmentLanguage());
    const resolved = [];
    for (const lang of langs) {
        const model = findModelForLanguage(models, lang);
        if (!model) return null;
        resolved.push({ lang, model });
    }
    return resolved;
}

function getAlignmentMode() {
    try { return localStorage.getItem('alignmentLanguage') || 'en-ko'; } catch (_) { return 'en-ko'; }
}

// Korean-pass phrase boundaries can be a few seconds late around a language
// switch. Keep a modest margin, but the surrounding anchors still prevent a
// fallback block from leaking into another verse.
const FALLBACK_WINDOW_PADDING_MS = 3_000;
const MIN_FALLBACK_WINDOW_MS = 800;

/**
 * Builds bounded English fallback requests from the Korean full-context pass.
 * English-only CTC must never see the full song: it would compress every
 * English refrain into one timeline and place it over Korean verses.
 */
export function buildEnglishFallbackWindows({ fallbackEntries, primaryRawLines, acceptedLines, entries, segments }) {
    const entryById = new Map((entries || []).map((entry) => [entry.id, entry]));
    const rawById = new Map((primaryRawLines || []).map((line) => [line.segment_id, line]));
    const anchors = [];

    (acceptedLines || []).forEach((line) => {
        const entry = entryById.get(line.segment_id);
        if (!entry || !Number.isFinite(line.start_ms) || !Number.isFinite(line.end_ms)) return;
        anchors.push({ segmentIndex: entry.segmentIndex, startMs: line.start_ms, endMs: line.end_ms });
    });
    // Existing non-approx timestamps are user anchors; preserve them even if
    // the current primary pass did not produce a line for that segment.
    (entries || []).forEach((entry) => {
        const segment = segments?.[entry.segmentIndex];
        if (!segment || segment.approx || !(segment.start > 0 || segment.end > 0)) return;
        anchors.push({
            segmentIndex: entry.segmentIndex,
            startMs: Math.round(segment.start * 1000),
            endMs: Math.round((segment.end || segment.start) * 1000),
        });
    });
    anchors.sort((a, b) => a.segmentIndex - b.segmentIndex || a.startMs - b.startMs);

    const sorted = [...(fallbackEntries || [])].sort((a, b) => a.segmentIndex - b.segmentIndex);
    const groups = [];
    for (const entry of sorted) {
        const previous = groups.at(-1);
        if (previous && entry.segmentIndex === previous.entries.at(-1).segmentIndex + 1) {
            previous.entries.push(entry);
        } else {
            groups.push({ entries: [entry] });
        }
    }

    return groups.map((group) => {
        const firstIndex = group.entries[0].segmentIndex;
        const lastIndex = group.entries.at(-1).segmentIndex;
        const provisional = group.entries
            .map((entry) => rawById.get(entry.id))
            .filter((line) => Number.isFinite(line?.start_ms) && Number.isFinite(line?.end_ms) && line.end_ms > line.start_ms);
        const previousAnchor = anchors.filter((anchor) => anchor.segmentIndex < firstIndex).at(-1);
        const nextAnchor = anchors.find((anchor) => anchor.segmentIndex > lastIndex);
        // 순수 영어 줄은 한국어 1차에서 의도적으로 제외되므로 provisional
        // 시각이 없다. 이 경우 앞뒤 한국어 앵커 사이를 window로 사용한다.
        // 양쪽 앵커가 모두 없을 때만 줄 수 기반의 제한된 추정폭을 쓴다.
        const estimatedSpanMs = Math.max(6_000, group.entries.length * 4_500);
        const provisionalStartMs = provisional.length > 0
            ? Math.min(...provisional.map((line) => line.start_ms))
            : (previousAnchor?.endMs ?? Math.max(0, (nextAnchor?.startMs ?? estimatedSpanMs) - estimatedSpanMs));
        const provisionalEndMs = provisional.length > 0
            ? Math.max(...provisional.map((line) => line.end_ms))
            : (nextAnchor?.startMs ?? provisionalStartMs + estimatedSpanMs);
        const windowStartMs = Math.max(
            0,
            previousAnchor?.endMs ?? 0,
            provisionalStartMs - FALLBACK_WINDOW_PADDING_MS,
        );
        const windowEndMs = Math.min(
            nextAnchor?.startMs ?? Infinity,
            provisionalEndMs + FALLBACK_WINDOW_PADDING_MS,
        );
        const windowSource = provisional.length === group.entries.length
            ? 'phonetic_provisional'
            : (previousAnchor || nextAnchor ? 'korean_anchor_inference' : 'size_estimate');
        const windowContext = {
            previousAnchor: previousAnchor || null,
            nextAnchor: nextAnchor || null,
            provisionalIds: provisional.map((line) => line.segment_id).filter(Boolean),
            provisionalCount: provisional.length,
            requestedCount: group.entries.length,
            estimatedSpanMs,
        };
        if (!Number.isFinite(windowEndMs) || windowEndMs - windowStartMs < MIN_FALLBACK_WINDOW_MS) {
            return {
                ...group,
                skipReason: 'invalid_window',
                provisionalStartMs,
                provisionalEndMs,
                windowStartMs,
                windowEndMs,
                windowSource,
                windowContext,
            };
        }
        return {
            ...group,
            windowStartMs: Math.round(windowStartMs),
            windowEndMs: Math.round(windowEndMs),
            provisionalStartMs,
            provisionalEndMs,
            windowSource,
            windowContext,
        };
    });
}

/**
 * 1차 gate 이후에도 미싱크로 남은 줄을 contiguous local windows로 묶는다.
 * 이미 채택된 줄은 시간 anchor로만 사용하며, 각 window는 한 언어만 갖는다.
 */
export function buildSecondPassWindows({ rescueEntries, segments, entries, markers, paddingMs = 2_000 }) {
    const activeAnchors = (entries || [])
        .map((entry) => {
            const segment = segments?.[entry.segmentIndex];
            if (!segment || !(segment.end > segment.start)) return null;
            return {
                segmentIndex: entry.segmentIndex,
                startMs: Math.round(segment.start * 1000),
                endMs: Math.round(segment.end * 1000),
                manual: segment.approx !== true,
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.segmentIndex - b.segmentIndex);
    const sorted = [...(rescueEntries || [])].sort((a, b) => a.segmentIndex - b.segmentIndex);
    const groups = [];
    for (const entry of sorted) {
        const language = entry.language || 'ko';
        const previous = groups.at(-1);
        if (previous
            && entry.segmentIndex === previous.entries.at(-1).segmentIndex + 1
            && language === previous.language) {
            previous.entries.push(entry);
        } else {
            groups.push({ language, entries: [entry] });
        }
    }

    return groups.map((group) => {
        const firstIndex = group.entries[0].segmentIndex;
        const lastIndex = group.entries.at(-1).segmentIndex;
        const previousAnchor = activeAnchors.filter((anchor) => anchor.segmentIndex < firstIndex).at(-1);
        const nextAnchor = activeAnchors.find((anchor) => anchor.segmentIndex > lastIndex);
        const estimatedSpanMs = Math.max(6_000, group.entries.length * 4_500);
        const vocalStartMs = Number.isFinite(markers?.vocalStartSec)
            ? Math.round(markers.vocalStartSec * 1000)
            : 0;
        const baseStartMs = previousAnchor?.endMs
            ?? Math.max(vocalStartMs, (nextAnchor?.startMs ?? estimatedSpanMs) - estimatedSpanMs);
        const baseEndMs = nextAnchor?.startMs
            ?? baseStartMs + estimatedSpanMs;
        const windowStartMs = Math.max(vocalStartMs, baseStartMs - paddingMs, 0);
        // 다음에 이미 채택된 줄의 시작 시각을 넘기지 않는다. 끝쪽 padding을
        // 허용하면 CTC가 다음 앵커의 음향을 현재 미싱크 줄에 먹여서 다시
        // 겹침을 만들 수 있으므로, 여유는 앞쪽에만 둔다.
        const windowEndMs = Math.min(nextAnchor?.startMs ?? Infinity, baseEndMs + paddingMs);
        const windowContext = {
            previousAnchor: previousAnchor || null,
            nextAnchor: nextAnchor || null,
            estimatedSpanMs,
            language: group.language,
        };
        if (!Number.isFinite(windowEndMs) || windowEndMs - windowStartMs < 800) {
            return { ...group, skipReason: 'invalid_rescue_window', windowStartMs, windowEndMs, windowContext };
        }
        return {
            ...group,
            windowStartMs: Math.round(windowStartMs),
            windowEndMs: Math.round(windowEndMs),
            windowSource: previousAnchor || nextAnchor ? 'accepted_anchor_window' : 'estimated_window',
            windowContext,
        };
    });
}

function applyFallbackLines(segments, entries, fallbackLines) {
    let applied = 0;
    const entryById = new Map((entries || []).map((entry) => [entry.id || `segment:${entry.segmentIndex}`, entry]));
    (fallbackLines || []).forEach((line) => {
        // Fallback/rescue results must carry a request identity. Positional
        // recovery here could attach a shortened backend response to the
        // wrong repeated lyric block.
        const entry = entryById.get(line?.segment_id);
        if (!entry || !Number.isFinite(line?.start_ms)) return;
        const seg = segments[entry.segmentIndex];
        if (!seg) return;
        const wasSynced = seg.start !== 0 || seg.end !== 0;
        // A low-confidence Korean pass may already have filled this segment.
        // Replace only that approximate result; never overwrite a user's
        // manually confirmed timestamp.
        if (seg.start !== 0 || seg.end !== 0) {
            if (!seg.approx) return;
        }
        const start = Math.max(0, line.start_ms / 1000);
        const end = Math.max(start + 0.05, (line.end_ms || line.start_ms) / 1000);
        seg.start = start;
        seg.end = end;
        seg.approx = true;
        if (typeof line.confidence === 'number') seg.confidence = line.confidence;
        if (!wasSynced) applied++;
    });
    return applied;
}

/** Copy only AI timing metadata back to the original LRC segments. The
 * phonetic preprocessor may use triplet-shaped clones, but it must never
 * replace the user's original text or reorder their blocks. */
function copyAlignmentTiming(originalSegments, alignedSegments) {
    (originalSegments || []).forEach((original, index) => {
        const aligned = alignedSegments?.[index];
        if (!original || !aligned) return;
        if (!(original.start === 0 && original.end === 0)) return;
        if (!(aligned.start > 0 || aligned.end > 0)) return;
        original.start = aligned.start;
        original.end = aligned.end;
        original.approx = aligned.approx;
        if (typeof aligned.confidence === 'number') original.confidence = aligned.confidence;
    });
    return originalSegments;
}

/**
 * 현재 정렬 언어(localStorage)에 필요한 정렬 모델이 설치돼 있는지 확인하고,
 * 없으면 사용자에게 다운로드 여부를 묻고 받는다. 노래 추가·배치 정렬을 걸기
 * 전에 호출해, "모델이 없어 대기열 항목만 조용히 실패"하는 상황을 막는다.
 *
 * @returns {Promise<boolean>} 정렬을 진행해도 되는지(모델 준비 완료 = true).
 *   사용자가 다운로드를 거절했거나 실패하면 false.
 */
export async function ensureAlignmentModelsReady() {
    let models = [];
    try {
        models = await invoke('get_model_list');
    } catch (err) {
        console.error('[AlignQueue] get_model_list failed:', err);
    }
    const { getAlignmentLanguage, missingModelsForLanguage } = await import('./alignment-model.js');
    const missing = missingModelsForLanguage(models, getAlignmentLanguage());
    if (missing.length === 0) return true;

    const names = missing.map((m) => m.label).join(', ');
    const ok = confirm(
        `AI 자동 정렬에 필요한 정렬 모델이 없습니다: ${names}\n\n`
        + '지금 다운로드할까요? (모델당 수백 MB, 시간이 걸릴 수 있습니다)'
    );
    if (!ok) return false;

    for (const m of missing) {
        try {
            showNotification(`정렬 모델(${m.label}) 다운로드 중…`, 'info');
            await invoke('download_alignment_model', { modelId: m.downloadableId });
        } catch (err) {
            console.error('[AlignQueue] download_alignment_model failed:', m.downloadableId, err);
            showNotification(`정렬 모델(${m.label}) 다운로드 실패: ${err}`, 'error');
            return false;
        }
    }
    showNotification('정렬 모델 다운로드 완료.', 'success');
    return true;
}

/** 원본 LRC에서 마커 줄([vocalstart]/[ilstart]/[ilend])만 추려 보존용으로 반환.
 *  인코딩은 공용 encodeLrc(lrc-parser.js) 사용 — 세그먼트 순서 보존. */
function extractMarkerLines(lrcContent) {
    const markerRegex = /^\[(\d{2}):(\d{2}\.\d{2,3})\]\[(vocalstart|ilstart|ilend)\]\s*$/;
    const lines = (lrcContent || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    lines.forEach((line) => {
        const m = markerRegex.exec(line.trim());
        if (m) {
            out.push(line.trim());
        }
    });
    return out;
}

/**
 * 정렬 입력 텍스트와 **하드 앵커**를 세그먼트에서 뽑는다.
 *
 * 앵커는 백엔드가 구간 분할 정렬에 쓰는 고정점 `(줄 인덱스, ms)`으로, 한 번의
 * 밀림이 곡 전체로 전파되는 것을 막고 사용자 교정을 정렬 기준으로 삼는다.
 * - 이미 싱크된 줄(start>0) → 그 시작 시각이 앵커.
 * - 보컬시작 마커 → 첫 줄이 아직 싱크 안 됐을 때만 첫 줄의 시작 앵커
 *   ("긴 인트로 동안 첫 토큰이 일찍 소비돼 처음부터 밀리는" 문제 차단).
 *
 * 줄 인덱스는 정렬 입력(allTexts)에서의 위치 — 백엔드가 같은 기준으로 매핑한다.
 * @returns {{ allTexts: string[], anchors: [number, number][] }}
 */
export function collectAlignmentAnchors(segments, markers, { skipPureEnglish = false } = {}) {
    const allTexts = [];
    const anchors = [];
    const entries = [];
    for (let segmentIndex = 0; segmentIndex < (segments || []).length; segmentIndex++) {
        const s = segments[segmentIndex];
        const t = getSyncText(s).trim();
        if (t.length === 0) continue;
        // 숫자·기호만 남은 메타/효과음은 모델 토큰으로 만들 수 없다.
        if (!/[A-Za-z\u3131-\u318E\uAC00-\uD7A3]/.test(t)) continue;
        const sourceText = String(s.original || t || '').trim();
        const englishFallbackOnly = s._alignmentSkip && isEnglishLine(sourceText);
        // 숫자/기호나 기타 변환 불가 줄은 제외한다. 변환 불가능한 영어는
        // 원문 ID를 유지한 채 영어 fallback만 시도할 수 있도록 남긴다.
        if (s._alignmentSkip && !englishFallbackOnly) continue;
        // 구조 지시어(간주, Chorus, Verse 등)는 실제 가사가 아니므로
        // AI 정렬 입력과 앵커에서 제외한다. parseLrc에서 이미 필터링했지만
        // 방어적으로 한 번 더 확인.
        if (isStructureDirective(t)) continue;
        const idx = allTexts.length;
        const pureEnglish = isEnglishLine(sourceText) && !/[\u3131-\u318E\uAC00-\uD7A3]/.test(sourceText);
        const skipPrimary = s._skipPrimary === true
            || englishFallbackOnly
            || (skipPureEnglish && pureEnglish);
        // 빈 줄도 입력 배열에 남겨야 Rust가 lyric line index와 segment ID를
        // 동일하게 유지할 수 있다. 원문/차음 데이터 자체는 수정하지 않는다.
        allTexts.push(skipPrimary ? '' : t);
        entries.push({
            id: `segment:${segmentIndex}`,
            segmentIndex,
            text: t,
            skipPrimary,
            fallbackCandidate: skipPrimary && isEnglishLine(sourceText),
        });
        const synced = !(s.start === 0 && s.end === 0);
        // 이번/현재 세션에서 AI가 채운 approx 줄은 다음 정렬의 하드 앵커가
        // 아니다. 수동으로 확정한 시간만 전역 경로를 강제할 수 있다.
        const isManualAnchor = synced && !s.approx;
        if (isManualAnchor && typeof s.start === 'number' && s.start > 0) {
            anchors.push([idx, Math.round(s.start * 1000)]);
        }
    }
    // vocalStartSec와 interludes는 재생/표시용 마커다.
    // AI 정렬의 시간축에는 절대 하드 앵커로 사용하지 않는다.
    // 정렬은 실제 가사와 사용자가 직접 확정한 가사 싱크만 기준으로 한다.
    return { allTexts, anchors, entries };
}

async function processOne(item) {
    const traceId = createAlignmentTraceId(item.path);
    item.alignmentTraceId = traceId;
    // 1. LRC 로드 + 파싱
    let lrcContent = '';
    try {
        lrcContent = await invoke('load_lrc_file', { audioPath: item.path });
    } catch (err) {
        // 파일 없음 — 가사 자체가 없는 곡
    }
    if (!lrcContent || !lrcContent.trim()) {
        item.status = 'no-lyrics';
        return;
    }
    const segments = parseLrc(lrcContent, 0);
    const alignmentMode = getAlignmentMode();
    // The phonetic mode creates a temporary alignment representation only.
    // It is never written back over the original LRC text.
    const prepared = alignmentMode === 'en-ko'
        ? buildAlignmentLyrics(segments)
        : { allTexts: null, entries: null, segments };
    const workingSegments = prepared.segments;
    const markers = parseMarkers(lrcContent);
    // 에디터(runAiAlignment)와 동일하게 원문 순서 전체를 유지한 입력을
    // 보낸다. 단, 순수 영어 줄은 빈 줄 placeholder로만 남겨 한국어 CTC
    // 토큰을 소비하지 않게 한다 — 병합은 미싱크 줄에만 됨.
    // 이미 싱크된 줄·보컬시작 마커는 하드 앵커로 함께 넘긴다(collectAlignmentAnchors).
    const { allTexts, anchors, entries } = collectAlignmentAnchors(
        workingSegments,
        markers,
        { skipPureEnglish: alignmentMode === 'en-ko' },
    );
    await traceAlignment(traceId, 'input_prepared', {
        audioPath: item.path,
        alignmentMode,
        markerSummary: markers,
        originalLrc: lrcContent,
        originalSegments: segments,
        temporaryAlignmentSegments: workingSegments,
        alignmentEntries: entries,
        alignmentTexts: allTexts,
        inputSummary: traceInputSummary(allTexts, entries),
        segmentMap: traceSegmentMap(segments, workingSegments, entries),
        primarySkippedSegmentIds: entries.filter((entry) => entry.skipPrimary).map((entry) => entry.id),
        manualAnchors: anchors,
    });
    const hasUnsynced = workingSegments.some(
        (s) => s.start === 0 && s.end === 0 && getSyncText(s).trim().length > 0
    );
    if (allTexts.length === 0) {
        item.status = 'no-lyrics';
        return;
    }
    if (!hasUnsynced) {
        // 가사는 있지만 전부 이미 싱크됨 — 할 일 없음, 완료 처리
        item.status = 'done';
        item.note = '이미 싱크됨';
        return;
    }

    // 2. 모델 확인 (없으면 이 항목만 실패 — 배치 중 다운로드 프롬프트 없음)
    const modelSpecs = await resolveAlignmentModels();
    if (!modelSpecs) {
        item.status = 'error';
        item.error = '선택한 언어의 정렬 모델이 설치되어 있지 않습니다 (가사 싱크 탭에서 언어를 고르고 먼저 다운로드하세요).';
        await traceAlignment(traceId, 'stopped', { reason: 'model_not_installed', error: item.error });
        return;
    }
    await traceAlignment(traceId, 'models_resolved', { modelSpecs });

    // 3. 강제정렬 실행 (백엔드 락이 에디터 단발 실행과의 동시성도 직렬화).
    // 한영 혼합도 en-ko의 한국어 1차 + 필요한 영어 줄의 창형 폴백으로 처리한다.
    const primaryModelSpecs = alignmentMode === 'en-ko'
        ? modelSpecs.filter((spec) => spec.lang === 'ko')
        : modelSpecs;
    await traceAlignment(traceId, 'pipeline_plan', {
        alignmentMode,
        modelSpecs,
        primaryModelSpecs,
        primaryInput: traceInputSummary(allTexts, entries),
        primarySkippedIds: entries.filter((entry) => entry.skipPrimary).map((entry) => entry.id),
        provisionalPass: alignmentMode === 'en-ko' && entries.some((entry) => entry.skipPrimary && entry.fallbackCandidate),
        fallbackEnabled: alignmentMode === 'en-ko' && prepared.entries?.some((entry) => entry.fallbackCandidate) === true,
    });
    const passResults = [];
    for (let pi = 0; pi < primaryModelSpecs.length; pi++) {
        const { lang, model } = primaryModelSpecs[pi];
        item.progressOffset = (100 / primaryModelSpecs.length) * pi;
        item.progressScale = 1 / primaryModelSpecs.length;
        item.passLabel = primaryModelSpecs.length > 1 ? `${pi + 1}/${primaryModelSpecs.length}` : null;
        notifyQueueChanged();
        const result = await invoke('run_forced_alignment', {
            audioPath: item.path,
            lyrics: allTexts.join('\n'),
            modelName: model,
            language: lang,
            anchors: anchors.length ? anchors : null,
            lineIds: entries.map((entry) => entry.id),
        });
        const resultLines = attachMissingSegmentIds((result && result.lines) || [], entries);
        passResults.push(resultLines);
        await traceAlignment(traceId, 'primary_model_result', {
            passIndex: pi,
            language: lang,
            request: {
                lyrics: allTexts,
                lineIds: entries.map((entry) => entry.id),
                anchors,
                inputSummary: traceInputSummary(allTexts, entries),
            },
            rawResultLines: resultLines,
            resultSummary: {
                lineCount: resultLines.length,
                returnedIds: resultLines.map((line) => line.segment_id),
                missingRequestedIds: entries
                    .map((entry) => entry.id)
                    .filter((id) => !resultLines.some((line) => line.segment_id === id)),
            },
            diagnostics: result?.diagnostics || null,
        });
    }
    item.progressOffset = 0;
    item.progressScale = 1;
    item.passLabel = null;

    let lines = passResults[0] || [];
    const primaryRawLines = lines;
    const primaryGate = gateAlignmentLines(lines, entries);
    lines = primaryGate.accepted;
    await traceAlignment(traceId, 'primary_quality_gate', {
        confidenceFloor: primaryGate.confidenceFloor,
        accepted: primaryGate.accepted,
        rejected: primaryGate.rejected,
        summary: traceGateSummary(primaryGate),
    });
    let rejectedCount = primaryGate.rejected.length;
    let appliedCount = mergeAlignmentResult(workingSegments, lines, entries);

    // Optional per-line fallback: only English phonetic candidates with no
    // usable Korean-model result are retried, and only when the English model
    // is already installed. Batch processing never prompts for a download.
    if (alignmentMode === 'en-ko' && prepared.entries?.some((e) => e.fallbackCandidate)) {
        let installedModels = [];
        try { installedModels = await invoke('get_model_list'); } catch (_) { installedModels = []; }
        const { findModelForLanguage } = await import('./alignment-model.js');
        const englishModel = findModelForLanguage(installedModels, 'en');
        if (englishModel) {
            let fallbackWindowRawLines = primaryRawLines;
            const koreanModel = modelSpecs.find((spec) => spec.lang === 'ko')?.model || modelSpecs[0]?.model;
            const hasPrimarySkippedEnglish = entries.some((entry) => entry.skipPrimary && entry.fallbackCandidate);
            // 실제 한국어 1차에서는 순수 영어 줄을 제외했기 때문에, 영어
            // window의 위치를 얻기 위한 phonetic provisional pass만 추가로
            // 실행한다. 이 pass의 한국어 결과는 절대 저장하지 않는다.
            if (hasPrimarySkippedEnglish && koreanModel) {
                const provisionalTexts = entries.map((entry) => {
                    const segment = workingSegments[entry.segmentIndex];
                    return getSyncText(segment).trim();
                });
                try {
                    const provisionalResult = await invoke('run_forced_alignment', {
                        audioPath: item.path,
                        lyrics: provisionalTexts.join('\n'),
                        modelName: koreanModel,
                        language: 'ko',
                        anchors: anchors.length ? anchors : null,
                        lineIds: entries.map((entry) => entry.id),
                    });
                    fallbackWindowRawLines = attachMissingSegmentIds(
                        (provisionalResult && provisionalResult.lines) || [],
                        entries,
                    );
                    await traceAlignment(traceId, 'phonetic_provisional_result', {
                        request: {
                            lyrics: provisionalTexts,
                            lineIds: entries.map((entry) => entry.id),
                            anchors,
                            inputSummary: traceInputSummary(provisionalTexts, entries),
                        },
                        rawResultLines: fallbackWindowRawLines,
                        resultSummary: {
                            lineCount: fallbackWindowRawLines.length,
                            returnedIds: fallbackWindowRawLines.map((line) => line.segment_id),
                        },
                        diagnostics: provisionalResult?.diagnostics || null,
                        usedOnlyFor: 'english_fallback_window_estimation',
                    });
                } catch (error) {
                    await traceAlignment(traceId, 'phonetic_provisional_error', {
                        error: String(error?.message || error),
                        usedOnlyFor: 'english_fallback_window_estimation',
                    });
                }
            }
            const fallbackEntries = prepared.entries.filter((entry) => {
                if (!entry.fallbackCandidate || !entry.isEnglish) return false;
                return !lines.some((line) => line.segment_id === `segment:${entry.segmentIndex}`);
            }).map((entry) => ({ ...entry, id: `segment:${entry.segmentIndex}` }));
            const fallbackAnchorLines = buildFallbackAnchorLines(
                lines,
                fallbackWindowRawLines,
                entries,
            );
            const fallbackWindows = buildEnglishFallbackWindows({
                fallbackEntries,
                primaryRawLines: fallbackWindowRawLines,
                acceptedLines: fallbackAnchorLines,
                entries,
                segments: workingSegments,
            });
            for (const fallbackWindow of fallbackWindows) {
                if (fallbackWindow.skipReason) {
                    await traceAlignment(traceId, 'english_fallback_skipped', {
                        ...fallbackWindow,
                        reason: fallbackWindow.skipReason,
                    });
                    continue;
                }
                const fallbackTexts = fallbackWindow.entries.map((entry) => {
                    const seg = workingSegments[entry.segmentIndex];
                    return String(seg?.original || seg?.text || entry.text).trim();
                });
                if (fallbackTexts.every(Boolean)) {
                    const fallbackResult = await invoke('run_forced_alignment', {
                        audioPath: item.path,
                        lyrics: fallbackTexts.join('\n'),
                        modelName: englishModel,
                        language: 'en',
                        anchors: null,
                        lineIds: fallbackWindow.entries.map((entry) => entry.id),
                        windowStartMs: fallbackWindow.windowStartMs,
                        windowEndMs: fallbackWindow.windowEndMs,
                    });
                    const fallbackAlignmentEntries = fallbackWindow.entries.map((entry) => ({
                        id: entry.id,
                        segmentIndex: entry.segmentIndex,
                        text: entry.text,
                    }));
                    const rawFallbackLines = attachMissingSegmentIds(
                        (fallbackResult && fallbackResult.lines) || [],
                        fallbackAlignmentEntries,
                    );
                    const fallbackGate = gateAlignmentLines(rawFallbackLines, fallbackAlignmentEntries, {
                        windowStartMs: fallbackWindow.windowStartMs,
                        windowEndMs: fallbackWindow.windowEndMs,
                        // The time window already prevents cross-verse
                        // placement, so allow a weaker individual line when
                        // neighboring lines provide the acoustic context.
                        confidenceScale: 0.25,
                    });
                    const fallbackLines = fallbackGate.accepted;
                    await traceAlignment(traceId, 'english_fallback', {
                        window: fallbackWindow,
                        entries: fallbackAlignmentEntries,
                        requestTexts: fallbackTexts,
                        requestSummary: traceInputSummary(fallbackTexts, fallbackAlignmentEntries),
                        rawResultLines: rawFallbackLines,
                        diagnostics: fallbackResult?.diagnostics || null,
                        confidenceFloor: fallbackGate.confidenceFloor,
                        accepted: fallbackGate.accepted,
                        rejected: fallbackGate.rejected,
                        gateSummary: traceGateSummary(fallbackGate),
                    });
                    rejectedCount += fallbackGate.rejected.length;
                    appliedCount += applyFallbackLines(
                        workingSegments,
                        fallbackWindow.entries,
                        fallbackLines,
                    );
                }
            }
        }
    }
    const initialTimelineDropped = enforceAiTimelineOrder(workingSegments);
    if (initialTimelineDropped.length > 0) {
        appliedCount = Math.max(0, appliedCount - initialTimelineDropped.length);
        rejectedCount += initialTimelineDropped.length;
    }
    await traceAlignment(traceId, 'post_merge_timeline_gate', {
        phase: 'initial',
        dropped: initialTimelineDropped,
        droppedCount: initialTimelineDropped.length,
        reason: initialTimelineDropped.length > 0 ? 'automatic_results_reversed_original_order' : null,
    });

    // 2차 구조: 1차에서 미싱크로 남은 줄만, 이미 통과한 줄 사이의
    // local window에서 다시 시도한다. 전곡 경로를 다시 열지 않아 기존
    // 결과를 흔들지 않는다.
    const preparedByIndex = new Map((prepared.entries || []).map((entry) => [entry.segmentIndex, entry]));
    const rescueEntries = entries
        .filter((entry) => {
            const segment = workingSegments[entry.segmentIndex];
            return segment && !(segment.end > segment.start);
        })
        .map((entry) => {
            const preparedEntry = preparedByIndex.get(entry.segmentIndex);
            const isPureEnglish = alignmentMode === 'en-ko'
                && preparedEntry?.skipPrimary === true
                && preparedEntry?.fallbackCandidate === true;
            const language = alignmentMode === 'en'
                ? 'en'
                : (isPureEnglish ? 'en' : 'ko');
            return {
                ...entry,
                language,
                text: getSyncText(workingSegments[entry.segmentIndex]),
            };
        });
    const rescueWindows = buildSecondPassWindows({
        rescueEntries,
        segments: workingSegments,
        entries,
        markers,
    });
    let rescueEnglishModel = null;
    if (rescueWindows.some((window) => window.language === 'en')) {
        let installedModels = [];
        try { installedModels = await invoke('get_model_list'); } catch (_) { installedModels = []; }
        const { findModelForLanguage } = await import('./alignment-model.js');
        rescueEnglishModel = findModelForLanguage(installedModels, 'en');
    }
    let rescueAppliedCount = 0;
    let rescueRejectedCount = 0;
    for (const rescueWindow of rescueWindows) {
        const model = rescueWindow.language === 'en'
            ? rescueEnglishModel
            : modelSpecs.find((spec) => spec.lang === 'ko')?.model || modelSpecs[0]?.model;
        if (rescueWindow.skipReason || !model) {
            await traceAlignment(traceId, 'second_pass_rescue_skipped', {
                ...rescueWindow,
                reason: rescueWindow.skipReason || 'model_not_available',
            });
            continue;
        }
        const requestTexts = rescueWindow.entries.map((entry) => {
            const segment = workingSegments[entry.segmentIndex];
            return rescueWindow.language === 'en'
                ? String(segment?.original || segment?.text || '').trim()
                : getSyncText(segment).trim();
        });
        if (!requestTexts.every(Boolean)) {
            await traceAlignment(traceId, 'second_pass_rescue_skipped', {
                ...rescueWindow,
                reason: 'empty_request_text',
                requestTexts,
            });
            continue;
        }
        const alignmentEntries = rescueWindow.entries.map((entry) => ({
            id: entry.id,
            segmentIndex: entry.segmentIndex,
            text: entry.text,
        }));
        try {
            const rescueResult = await invoke('run_forced_alignment', {
                audioPath: item.path,
                lyrics: requestTexts.join('\n'),
                modelName: model,
                language: rescueWindow.language,
                anchors: null,
                lineIds: rescueWindow.entries.map((entry) => entry.id),
                windowStartMs: rescueWindow.windowStartMs,
                windowEndMs: rescueWindow.windowEndMs,
            });
            const rawRescueLines = attachMissingSegmentIds(
                (rescueResult && rescueResult.lines) || [],
                alignmentEntries,
            );
            const rescueGate = gateAlignmentLines(rawRescueLines, alignmentEntries, {
                windowStartMs: rescueWindow.windowStartMs,
                windowEndMs: rescueWindow.windowEndMs,
                confidenceScale: rescueWindow.language === 'en' ? 0.30 : 0.50,
            });
            const applied = applyFallbackLines(workingSegments, rescueWindow.entries, rescueGate.accepted);
            rescueAppliedCount += applied;
            rescueRejectedCount += rescueGate.rejected.length;
            await traceAlignment(traceId, 'second_pass_rescue', {
                window: rescueWindow,
                language: rescueWindow.language,
                model,
                requestTexts,
                requestSummary: traceInputSummary(requestTexts, alignmentEntries),
                rawResultLines: rawRescueLines,
                accepted: rescueGate.accepted,
                rejected: rescueGate.rejected,
                gateSummary: traceGateSummary(rescueGate),
                diagnostics: rescueResult?.diagnostics || null,
            });
        } catch (error) {
            await traceAlignment(traceId, 'second_pass_rescue_error', {
                window: rescueWindow,
                language: rescueWindow.language,
                model,
                error: String(error?.message || error),
            });
        }
    }
    appliedCount += rescueAppliedCount;
    rejectedCount += rescueRejectedCount;
    const rescueTimelineDropped = enforceAiTimelineOrder(workingSegments);
    if (rescueTimelineDropped.length > 0) {
        appliedCount = Math.max(0, appliedCount - rescueTimelineDropped.length);
        rejectedCount += rescueTimelineDropped.length;
    }
    await traceAlignment(traceId, 'post_merge_timeline_gate', {
        phase: 'after_second_pass',
        rescueAppliedCount,
        rescueRejectedCount,
        dropped: rescueTimelineDropped,
        droppedCount: rescueTimelineDropped.length,
        reason: rescueTimelineDropped.length > 0 ? 'second_pass_reversed_original_order' : null,
    });
    const finalUnsyncedEntries = entries.filter((entry) => {
        const segment = workingSegments[entry.segmentIndex];
        return !segment || !(segment.end > segment.start);
    });
    const finalUnsyncedCount = finalUnsyncedEntries.length;
    if (appliedCount === 0) {
        item.status = 'error';
        item.error = 'AI가 정렬한 줄과 일치하는 미싱크 가사를 찾지 못했습니다.';
        return;
    }

    // 4. 저장 (마커 줄 보존)
    const beforeSaveSegments = segments.map((segment) => ({ ...segment }));
    const savedSegments = copyAlignmentTiming(segments, workingSegments);
    const content = encodeLrc(savedSegments, extractMarkerLines(lrcContent));
    const timingAudit = traceTimingAudit(beforeSaveSegments, savedSegments);
    await traceAlignment(traceId, 'before_save', {
        appliedCount,
        attemptRejectedCount: rejectedCount,
        finalUnsyncedCount,
        finalUnsyncedIds: finalUnsyncedEntries.map((entry) => entry.id),
        acceptedPrimaryLines: lines,
        secondPass: {
            windowCount: rescueWindows.length,
            windows: rescueWindows.map((window) => ({
                language: window.language,
                segmentIds: window.entries.map((entry) => entry.id),
                windowStartMs: window.windowStartMs,
                windowEndMs: window.windowEndMs,
                windowSource: window.windowSource || null,
                skipReason: window.skipReason || null,
            })),
            rescueAppliedCount,
            rescueRejectedCount,
        },
        timingAudit,
        finalOriginalSegments: savedSegments,
        outputLrc: content,
    });
    await invoke('save_lrc_file', { audioPath: item.path, content });
    await traceAlignment(traceId, 'saved', {
        outputLrc: content,
        outputLineCount: content.split(/\r?\n/).filter(Boolean).length,
        timingAudit,
    });

    // 라이브러리 카드의 가사 보유/싱크 상태 즉시 갱신
    const song = state.songLibrary.find((s) => s.path === item.path);
    if (song) {
        song.hasLyrics = true; song.has_lyrics = true;
        song.lyricSyncStatus = 'synced'; song.lyric_sync_status = 'synced';
    }

    item.status = 'done';
    item.note = finalUnsyncedCount > 0
        ? `${appliedCount}줄 배치됨 · ${finalUnsyncedCount}줄 미싱크`
        : `${appliedCount}줄 배치됨`;

    // 이 곡이 지금 가사 싱크 에디터에 열려 있으면 결과를 즉시 반영.
    notifyItemComplete(item.path, lines, savedSegments);
}

async function runQueue() {
    if (isRunning) return;
    isRunning = true;
    await ensureProgressListener();
    try {
        for (;;) {
            const item = state.alignmentQueue.find((i) => i.status === 'queued');
            if (!item) break;
            item.status = 'processing';
            item.percentage = 0;
            // 새 항목 시작 — 진행률(-2/실수) 이벤트가 오기 전까지는 '준비 중'.
            item.phase = 'preparing';
            notifyQueueChanged();
            try {
                await processOne(item);
            } catch (err) {
                const msg = String(err);
                if (item.alignmentTraceId) {
                    await traceAlignment(item.alignmentTraceId, 'error', { message: msg, stack: err?.stack || null });
                }
                if (msg.includes('취소')) {
                    item.status = 'cancelled';
                } else {
                    console.error('[AlignQueue] item failed:', item.path, err);
                    item.status = 'error';
                    item.error = msg;
                }
            }
            notifyQueueChanged();
        }
    } finally {
        isRunning = false;
    }
}

/** 여러 곡을 정렬 대기열에 추가하고 (미실행 중이면) 순차 처리를 시작한다. */
export function enqueueAlignment(paths) {
    const active = new Set(
        state.alignmentQueue
            .filter((i) => i.status === 'queued' || i.status === 'processing')
            .map((i) => i.path)
    );
    let added = 0;
    (paths || []).forEach((path) => {
        if (!path || active.has(path)) return;
        // 같은 곡의 지난 실행 결과(done/error 등)가 남아있으면 치우고 다시
        // 등록 — 렌더러가 path를 카드 키로 쓰므로 경로 중복은 허용하지 않음.
        const staleIdx = state.alignmentQueue.findIndex((i) => i.path === path);
        if (staleIdx !== -1) state.alignmentQueue.splice(staleIdx, 1);
        const song = state.songLibrary.find((s) => s.path === path);
        state.alignmentQueue.push({
            path,
            title: song?.title || path,
            thumbnail: song?.thumbnail || '',
            status: 'queued',
        });
        active.add(path);
        added++;
    });
    if (added > 0) {
        notifyQueueChanged();
        runQueue();
    }
    return added;
}

/** 정렬 대기열 전체 지우기 — 처리 중인 항목이 있으면 취소하고, 대기/완료/
 *  오류 항목을 모두 목록에서 제거한다. (AI 프로세싱 탭의 "전체 지우기") */
export async function clearAlignmentQueue() {
    const processing = state.alignmentQueue.find((i) => i.status === 'processing');
    if (processing) {
        try {
            await invoke('cancel_forced_alignment');
        } catch (err) {
            console.error('[AlignQueue] cancel during clear failed:', err);
        }
    }
    state.alignmentQueue.length = 0;
    notifyQueueChanged();
}

/** 대기열 항목 취소/제거. queued는 즉시 제거(백엔드 호출 없음), processing은
 *  전역 취소 커맨드 호출(활성 정렬은 항상 1개라 안전). done/error 등 완료
 *  상태는 목록에서 치우는 용도. */
export async function cancelAlignmentQueueItem(path) {
    const idx = state.alignmentQueue.findIndex((i) => i.path === path);
    if (idx === -1) return;
    const item = state.alignmentQueue[idx];
    if (item.status === 'processing') {
        try {
            await invoke('cancel_forced_alignment');
        } catch (err) {
            console.error('[AlignQueue] cancel failed:', err);
        }
        // 실제 상태 전환은 runQueue의 에러 처리(취소 메시지)에서 일어남
    } else {
        state.alignmentQueue.splice(idx, 1);
        notifyQueueChanged();
    }
}
