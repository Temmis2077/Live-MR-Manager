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
import { attachMissingSegmentIds, classifyAlignmentLine, gateAlignmentLines } from './alignment-quality.js';
import { applyAlignmentMetadata, buildAlignmentMetadata } from './alignment-metadata.js';
import { applyAlignmentAssistant } from './alignment-assistant.js';

let isRunning = false;
let listenerReady = false;
const ALIGNMENT_PIPELINE_REVISION = 'ordered-lexical-window-v3';

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
        softAcceptedIds: (gate?.softAccepted || []).map((line) => line.segment_id),
        softAcceptedCount: gate?.softAccepted?.length || 0,
        doublingAmbiguityIds: (gate?.accepted || [])
            .filter((line) => line?.quality_flags?.includes('doubling_ambiguity'))
            .map((line) => line.segment_id),
        lexicalMismatchIds: (gate?.rejected || [])
            .filter(({ reasons }) => reasons?.includes('lexical_mismatch') || reasons?.includes('vocable_mismatch'))
            .map(({ line }) => line?.segment_id)
            .filter(Boolean),
        nonLexicalVocalRegions: gate?.nonLexicalVocalRegions || [],
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
            repeated_lyric: entry?.repeatedLyric === true,
            line_kind: entry?.lineKind || classifyAlignmentLine(entry?.text || ''),
            anchor_trust: working?.alignmentTrust || (working?.approx ? 'acoustic_soft' : 'manual'),
            quality_flags: working?.qualityFlags || [],
        };
    });
}

const THIRD_PASS_INVALID_EVIDENCE_REASONS = new Set([
    'lexical_mismatch', 'vocable_mismatch',
    'duration', 'duration_sanity', 'outside_window',
    'out_of_order', 'duplicate_id', 'vocal_silence',
]);

// 문자 불일치와 낮은 confidence는 모델 인식 불확실성이라 VAD 순서 복구가
// 가능하지만, 시간·길이·순서가 깨진 후보는 같은 방식으로 되살리면 안 된다.
const VAD_ORDERED_STRUCTURAL_REJECTION_REASONS = new Set([
    'vocable_mismatch', 'duration', 'duration_sanity', 'outside_window',
    'out_of_order', 'duplicate_id', 'vocal_silence',
]);

export function collectGateLexicalEvidence(gate, evidenceById, nonLexicalRegions) {
    const candidates = [
        ...(gate?.accepted || []).map((line) => ({ line, reasons: [], accepted: true })),
        ...(gate?.rejected || []).map(({ line, reasons }) => ({ line, reasons: reasons || [], accepted: false })),
    ];
    candidates.forEach(({ line, reasons, accepted }) => {
        const similarity = Number(line?.greedy_text_similarity);
        if (!line?.segment_id || !Number.isFinite(similarity)) return;
        const candidate = {
            similarity,
            lineKind: line.line_kind || 'lyric',
            startMs: Number(line.start_ms),
            endMs: Number(line.end_ms),
            accepted,
            rejectedReasons: [...reasons],
            thirdPassEligible: accepted
                || !reasons.some((reason) => THIRD_PASS_INVALID_EVIDENCE_REASONS.has(reason)),
        };
        const previous = evidenceById.get(line.segment_id);
        const previousCandidates = previous?.candidates
            || (previous ? [{
                similarity: previous.similarity,
                lineKind: previous.lineKind,
                startMs: previous.startMs,
                endMs: previous.endMs,
            }] : []);
        const candidatesByKey = new Map();
        for (const item of [...previousCandidates, candidate]) {
            const key = `${item.similarity}:${item.startMs}:${item.endMs}`;
            const existing = candidatesByKey.get(key);
            if (!existing || (item.thirdPassEligible !== false && existing.thirdPassEligible === false)) {
                candidatesByKey.set(key, item);
            }
        }
        const candidates = [...candidatesByKey.values()];
        const best = candidates.reduce((current, item) =>
            !current || item.similarity > current.similarity ? item : current, null);
        evidenceById.set(line.segment_id, { ...best, candidates });
    });
    (gate?.nonLexicalVocalRegions || []).forEach((region) => nonLexicalRegions.push({ ...region }));
}

function mergeBlockedVocalRegions(regions) {
    const sorted = (regions || [])
        .filter((region) => Number.isFinite(region?.startMs) && Number.isFinite(region?.endMs) && region.endMs > region.startMs)
        .sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const region of sorted) {
        const previous = merged.at(-1);
        if (previous && region.startMs - previous.endMs <= 200) {
            previous.endMs = Math.max(previous.endMs, region.endMs);
            previous.activity = Math.max(Number(previous.activity) || 0, Number(region.activity) || 0);
            previous.segmentIds = [...new Set([...(previous.segmentIds || []), ...(region.segmentIds || [])])];
        } else {
            merged.push({ ...region, reason: 'non_lexical_vocal_region' });
        }
    }
    return merged;
}

function hasStoredTiming(segment) {
    if (!segment) return false;
    const start = Number(segment.start);
    const end = Number(segment.end);
    return Number.isFinite(start) && Number.isFinite(end) && (start > 0 || end > 0);
}

function hasClosedTimingRange(segment) {
    return hasStoredTiming(segment) && Number(segment.end) > Number(segment.start);
}

function markLexicalGateRejections(segments, entries, gate) {
    const entryById = new Map((entries || []).map((entry) => [entry.id, entry]));
    (gate?.rejected || []).forEach(({ line, reasons }) => {
        if (!reasons?.includes('lexical_mismatch') && !reasons?.includes('vocable_mismatch')) return;
        const entry = entryById.get(line?.segment_id);
        const segment = entry ? segments?.[entry.segmentIndex] : null;
        if (!segment || hasStoredTiming(segment)) return;
        segment.approx = true;
        segment.alignmentSource = 'unsynced_review';
        segment.lineKind = line.line_kind || entry.lineKind || classifyAlignmentLine(entry.text);
        if (typeof line.greedy_text_similarity === 'number') {
            segment.greedyTextSimilarity = line.greedy_text_similarity;
        }
        segment.qualityFlags = Array.from(new Set([
            ...(segment.qualityFlags || []),
            ...reasons,
            ...(segment.lineKind === 'vocable' ? ['non_lexical_vocal_risk'] : ['lexical_uncertain']),
        ]));
    });
}

function buildFallbackAnchorLines(primaryLines, provisionalLines, entries) {
    const entryById = new Map((entries || []).map((entry) => [entry.id, entry]));
    const byId = new Map();
    (primaryLines || []).forEach((line) => {
        if (line?.segment_id && line.alignment_trust !== 'acoustic_soft') {
            byId.set(line.segment_id, line);
        }
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
    const overlapPairs = [];
    const implausibleDurations = [];
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
        const timed = hasStoredTiming(after);
        const active = hasClosedTimingRange(after);
        if (!timed) unsyncedIds.push(`segment:${index}`);
        if (beforeText !== afterText) textChangedCount++;
        if (active && previous && afterStart < previous.start) {
            reversePairs.push({ previousId: previous.id, id: `segment:${index}`, previousStart: previous.start, start: afterStart });
        }
        if (active && previous && afterStart < previous.end - TIMELINE_OVERLAP_TOLERANCE_SEC) {
            overlapPairs.push({
                previousId: previous.id,
                id: `segment:${index}`,
                previousEnd: previous.end,
                start: afterStart,
                overlapSec: previous.end - afterStart,
            });
        }
        if (active) {
            const durationCheck = lyricDurationCheck(after);
            if (!durationCheck.plausible) {
                implausibleDurations.push({ id: `segment:${index}`, ...durationCheck });
            }
            previous = { id: `segment:${index}`, start: afterStart, end: afterEnd };
        }
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
        appliedIds: changes.filter((change) => change.after.start > 0 || change.after.end > 0).map((change) => change.id),
        unsyncedIds,
        reversePairs,
        overlapPairs,
        implausibleDurations,
        textChangedCount,
        activeCount: (afterSegments || []).length - unsyncedIds.length,
        sourceTextOrderPreserved: textChangedCount === 0,
        monotonicOrderPreserved: reversePairs.length === 0 && overlapPairs.length === 0,
        durationSanityPreserved: implausibleDurations.length === 0,
    };
}

/**
 * Detects a broad text/audio-fit problem after structural timeline checks have
 * succeeded. This is deliberately advisory: doubling, an alternate song
 * version, missing/reordered source lyrics, or transcription errors can all
 * produce the same CTC evidence.
 */
export function assessLyricsSourceMismatch({ entries = [], primaryGate = null, timingAudit = null } = {}) {
    const lineCount = entries.length;
    const structurallyHealthy = timingAudit?.sourceTextOrderPreserved === true
        && timingAudit?.monotonicOrderPreserved === true
        && timingAudit?.durationSanityPreserved === true;
    const confidenceFloor = Number(primaryGate?.confidenceFloor || 0);
    const evidenceIds = new Set();
    const doublingIds = new Set();

    (primaryGate?.rejected || []).forEach(({ line, reasons }) => {
        const activity = Number(line?.vocal_activity);
        const coverage = Number(line?.token_coverage);
        // Low posterior confidence is common for singing and does not by
        // itself mean the source lyrics are wrong. Reserve this advisory for
        // explicit text/audio mismatch evidence; confidence remains available
        // to the quality gate and unsynced review flow separately.
        const lowTextFit = (reasons || []).includes('lexical_mismatch')
            || (reasons || []).includes('vocable_mismatch');
        if (line?.segment_id && lowTextFit
            && Number.isFinite(activity) && activity >= 0.25
            && Number.isFinite(coverage) && coverage >= 0.90) {
            evidenceIds.add(line.segment_id);
        }
    });
    (primaryGate?.accepted || []).forEach((line) => {
        if (!line?.segment_id || line.alignment_trust !== 'acoustic_soft') return;
        evidenceIds.add(line.segment_id);
        if (line.quality_flags?.includes('doubling_ambiguity')) doublingIds.add(line.segment_id);
    });

    const evidenceCount = evidenceIds.size;
    const evidenceRatio = lineCount > 0 ? evidenceCount / lineCount : 0;
    const entryOrder = new Map(entries.map((entry, index) => [entry.id, index]));
    const evidenceIndices = [...evidenceIds]
        .map((id) => entryOrder.get(id))
        .filter(Number.isInteger)
        .sort((a, b) => a - b);
    let longestConsecutiveRun = 0;
    let currentRun = 0;
    let previousIndex = null;
    evidenceIndices.forEach((index) => {
        currentRun = previousIndex != null && index === previousIndex + 1 ? currentRun + 1 : 1;
        longestConsecutiveRun = Math.max(longestConsecutiveRun, currentRun);
        previousIndex = index;
    });

    const broadMismatch = evidenceCount >= 4
        && evidenceRatio >= 0.30
        && (longestConsecutiveRun >= 3 || evidenceRatio >= 0.45);
    const suspected = lineCount >= 8 && structurallyHealthy && broadMismatch;
    const reasons = [];
    if (suspected) {
        reasons.push('high_vocal_activity_but_low_text_fit');
        if ((primaryGate?.rejected || []).some(({ reasons: lineReasons }) => lineReasons?.includes('lexical_mismatch'))) {
            reasons.push('broad_lexical_mismatch');
        }
        if (longestConsecutiveRun >= 3) reasons.push('consecutive_text_fit_failures');
        if (doublingIds.size > 0) reasons.push('doubling_or_repeated_vocal_ambiguity');
    }
    return {
        suspected,
        reasons,
        metrics: {
            lineCount,
            structurallyHealthy,
            evidenceCount,
            evidenceRatio,
            evidenceIds: [...evidenceIds],
            longestConsecutiveRun,
            doublingAmbiguityCount: doublingIds.size,
            confidenceFloor,
        },
    };
}

const TIMELINE_ORDER_TOLERANCE_SEC = 0.08;
const TIMELINE_OVERLAP_TOLERANCE_SEC = 0.02;
const THIRD_PASS_EVIDENCE_TOLERANCE_MS = 80;
const MIN_LINE_DURATION_MS = 180;
const MIN_MS_PER_SINGABLE_UNIT = 50;
const MAX_BASE_LINE_DURATION_MS = 3_000;
const MAX_MS_PER_SINGABLE_UNIT = 1_000;
const MAX_LINE_DURATION_MS = 15_000;
const VOCABLE_MAX_LINE_DURATION_MS = 8_000;

function singableUnitCount(text) {
    return Array.from(String(text || '')).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
}

function lyricDurationCheck(segment) {
    const units = Math.max(1, singableUnitCount(getSyncText(segment)));
    const durationMs = Math.round((Number(segment?.end) - Number(segment?.start)) * 1000);
    const lineKind = segment?.lineKind || classifyAlignmentLine(getSyncText(segment));
    const minimumMs = Math.max(MIN_LINE_DURATION_MS, units * MIN_MS_PER_SINGABLE_UNIT);
    const baseMaximumMs = lineKind === 'vocable'
        ? VOCABLE_MAX_LINE_DURATION_MS
        : Math.min(
            MAX_LINE_DURATION_MS,
            Math.max(MAX_BASE_LINE_DURATION_MS, units * MAX_MS_PER_SINGABLE_UNIT),
        );
    // 실제 VAD 시작/끝에 잠긴 줄은 모델이 확인한 지속 발성 근거가 있으므로
    // 글자 수 휴리스틱보다 최대 800ms 긴 꼬리를 허용한다. 무제한 연장은
    // 화음·추임새를 한 줄에 삼키므로 허용하지 않는다.
    const maximumMs = segment?.alignmentSource === 'vad_boundary_review'
        ? Math.min(MAX_LINE_DURATION_MS, baseMaximumMs + 800)
        : baseMaximumMs;
    const reason = durationMs < minimumMs
        ? 'duration_too_short_for_lyrics'
        : (durationMs > maximumMs ? 'duration_too_long_for_lyrics' : null);
    return { plausible: reason == null, reason, durationMs, units, lineKind, minimumMs, maximumMs };
}

function clearAutoTiming(segment) {
    if (!segment || segment.approx !== true) return false;
    segment.start = 0;
    segment.end = 0;
    segment.alignmentTrust = null;
    segment.alignmentSource = null;
    return true;
}

/** Explicit AI reruns replace prior automatic timings but never manual work. */
export function resetAutomaticTimingsForRealignment(segments) {
    const reset = [];
    (segments || []).forEach((segment, index) => {
        if (!segment) return;
        if (!hasStoredTiming(segment)) {
            // 실패한 이전 실행의 진단은 새 모델 판단에 섞지 않는다. 특히
            // start/end=0인데 manual로 복원된 오래된 메타데이터도 바로잡는다.
            delete segment.confidence;
            delete segment.greedyTextSimilarity;
            delete segment.gateDecision;
            delete segment.ctcEnd;
            delete segment.tailExtensionMs;
            delete segment.words;
            delete segment.vadAssignment;
            delete segment.alignmentTrust;
            delete segment.alignmentSource;
            delete segment.approx;
            if (Array.isArray(segment.qualityFlags)) {
                segment.qualityFlags = segment.qualityFlags.filter((flag) => ![
                    'non_lexical_vocal_risk', 'no_lexical_evidence', 'lexical_uncertain',
                    'vad_ordered_review', 'vad_boundary_review', 'review_required', 'confidence', 'lexical_mismatch',
                    'duration_sanity', 'estimate_rejected',
                ].includes(flag));
                if (segment.qualityFlags.length === 0) delete segment.qualityFlags;
            }
            return;
        }
        if (segment.approx !== true) return;
        reset.push({
            id: `segment:${index}`,
            start: segment.start,
            end: segment.end,
            alignmentTrust: segment.alignmentTrust || 'acoustic_soft',
            alignmentSource: segment.alignmentSource || null,
        });
        segment.start = 0;
        segment.end = 0;
        delete segment.confidence;
        delete segment.alignmentTrust;
        delete segment.alignmentSource;
        delete segment.gateDecision;
        delete segment.qualityFlags;
        delete segment.greedyTextSimilarity;
        delete segment.vadAssignment;
    });
    return reset;
}

function alignmentTrustOf(segment) {
    if (!hasStoredTiming(segment)) return null;
    if (segment.approx !== true) return 'manual';
    if (!hasClosedTimingRange(segment)) return 'acoustic_soft';
    if (segment.alignmentTrust) return segment.alignmentTrust;
    if (segment.alignmentSource === 'anchor_interpolation') return 'estimated';
    // Unknown automatic timings are deliberately weak. Only an explicitly
    // classified acoustic result may constrain a later rescue window.
    return 'acoustic_soft';
}

function isStrongAlignmentAnchor(segment) {
    const trust = alignmentTrustOf(segment);
    return trust === 'manual' || (trust === 'acoustic_strong' && hasClosedTimingRange(segment));
}

/**
 * Fallback 결과가 이미 적용된 한국어 줄과 시간 순서를 뒤집지 않도록
 * 저장 직전에 검사한다. 자동 결과끼리 충돌하면 confidence가 약한 줄만
 * 미싱크로 되돌리고, 수동 싱크가 끼면 수동 줄을 기준으로 자동 줄을
 * 버린다. 어느 경우에도 시간을 강제로 이동하거나 원문 순서를 바꾸지 않는다.
 */
export function enforceAiTimelineOrder(segments) {
    const dropped = [];
    // 먼저 문장 길이에 비해 물리적으로 불가능한 자동 결과를 제거한다.
    for (let index = 0; index < (segments || []).length; index++) {
        const segment = segments[index];
        if (!segment || !hasClosedTimingRange(segment) || segment.approx !== true) continue;
        const durationCheck = lyricDurationCheck(segment);
        if (durationCheck.plausible) continue;
        if (!clearAutoTiming(segment)) continue;
        dropped.push({
            id: `segment:${index}`,
            index,
            text: getSyncText(segment),
            reason: durationCheck.reason,
            confidence: Number(segment.confidence) || 0,
            durationCheck,
        });
    }
    let changed = true;
    while (changed) {
        changed = false;
        let previous = null;
        for (let index = 0; index < (segments || []).length; index++) {
            const current = segments[index];
            if (!current || !hasStoredTiming(current)) continue;
            const startsInOrder = !previous
                || current.start >= previous.segment.start - TIMELINE_ORDER_TOLERANCE_SEC;
            const doesNotOverlap = !previous
                || current.start >= previous.segment.end - TIMELINE_OVERLAP_TOLERANCE_SEC;
            if (startsInOrder && doesNotOverlap) {
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
                const trustRank = (segment) => ({ acoustic_strong: 3, acoustic_soft: 2, estimated: 1 }[alignmentTrustOf(segment)] || 0);
                const previousTrust = trustRank(previous.segment);
                const currentTrust = trustRank(current);
                const previousConfidence = Number(previous.segment.confidence) || 0;
                const currentConfidence = Number(current.confidence) || 0;
                dropIndex = currentTrust > previousTrust
                    || (currentTrust === previousTrust && currentConfidence > previousConfidence)
                    ? previous.index
                    : index;
                reason = startsInOrder ? 'overlap_weaker_auto' : 'out_of_order_weaker_auto';
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

/** 분리 시작 자체가 실패했을 때 남은 예약을 제거한다. */
export function cancelDeferredAlignment(path) {
    if (path) pendingAfterSeparation.delete(path);
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
            if (!segment || !isStrongAlignmentAnchor(segment)) return null;
            return {
                id: entry.id,
                segmentIndex: entry.segmentIndex,
                startMs: Math.round(segment.start * 1000),
                endMs: Math.round(segment.end * 1000),
                manual: segment.approx !== true,
                trust: alignmentTrustOf(segment),
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
        const skippedSoftAnchors = (entries || []).map((entry) => {
            const segment = segments?.[entry.segmentIndex];
            const trust = alignmentTrustOf(segment);
            if (entry.segmentIndex <= (previousAnchor?.segmentIndex ?? -1)
                || entry.segmentIndex >= (nextAnchor?.segmentIndex ?? Infinity)
                || (trust !== 'acoustic_soft' && trust !== 'estimated')) return null;
            return { id: entry.id, segmentIndex: entry.segmentIndex, trust };
        }).filter(Boolean);
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
            softAnchorSkipped: skippedSoftAnchors,
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

function singableWeight(text) {
    return Math.max(1, singableUnitCount(text));
}

/** 2차까지 남은 실제 가사를 원문 순서의 연속 그룹으로 묶고 앵커 경계를 고정한다. */
export function buildFinalEstimateGroups(segments, entries, markers = {}) {
    const orderedEntries = [...(entries || [])].sort((a, b) => a.segmentIndex - b.segmentIndex);
    const anchors = orderedEntries.map((entry) => {
        const segment = segments?.[entry.segmentIndex];
        if (!segment || !isStrongAlignmentAnchor(segment)) return null;
        return {
            id: entry.id,
            segmentIndex: entry.segmentIndex,
            startMs: Math.round(segment.start * 1000),
            endMs: Math.round(segment.end * 1000),
            manual: segment.approx !== true,
            trust: alignmentTrustOf(segment),
        };
    }).filter(Boolean);
    const missing = orderedEntries.filter((entry) => {
        const segment = segments?.[entry.segmentIndex];
        return segment && !hasStoredTiming(segment);
    });
    const groups = [];
    for (const entry of missing) {
        const previous = groups.at(-1);
        if (previous && entry.segmentIndex === previous.entries.at(-1).segmentIndex + 1) {
            previous.entries.push(entry);
        } else {
            groups.push({ entries: [entry] });
        }
    }
    const vocalStartMs = Number.isFinite(markers?.vocalStartSec)
        ? Math.max(0, Math.round(markers.vocalStartSec * 1000))
        : 0;
    const interludes = (markers?.interludes || [])
        .filter((region) => Number.isFinite(region?.start) && Number.isFinite(region?.end) && region.end > region.start)
        .map((region) => ({ startMs: Math.round(region.start * 1000), endMs: Math.round(region.end * 1000) }));

    return groups.map((group) => {
        const firstIndex = group.entries[0].segmentIndex;
        const lastIndex = group.entries.at(-1).segmentIndex;
        const previousAnchor = anchors.filter((anchor) => anchor.segmentIndex < firstIndex).at(-1) || null;
        const nextAnchor = anchors.find((anchor) => anchor.segmentIndex > lastIndex) || null;
        // 약한 자동 결과를 정렬의 의미적 앵커로 신뢰하지는 않지만, 이미 차지한
        // 시간대를 새 추정값이 침범하면 최종 순서 감사에서 둘 다 흔들린다.
        // 인접한 저장 시각은 오직 닫힌 점유 경계로만 사용한다.
        const previousOccupied = orderedEntries
            .filter((entry) => entry.segmentIndex < firstIndex && hasStoredTiming(segments?.[entry.segmentIndex]))
            .map((entry) => segments[entry.segmentIndex])
            .at(-1) || null;
        const nextOccupiedEntry = orderedEntries
            .find((entry) => entry.segmentIndex > lastIndex && hasStoredTiming(segments?.[entry.segmentIndex]));
        const nextOccupied = nextOccupiedEntry ? segments[nextOccupiedEntry.segmentIndex] : null;
        const skippedSoftAnchors = orderedEntries.map((entry) => {
            const segment = segments?.[entry.segmentIndex];
            const trust = alignmentTrustOf(segment);
            if (entry.segmentIndex <= (previousAnchor?.segmentIndex ?? -1)
                || entry.segmentIndex >= (nextAnchor?.segmentIndex ?? Infinity)
                || (trust !== 'acoustic_soft' && trust !== 'estimated')) return null;
            return { id: entry.id, segmentIndex: entry.segmentIndex, trust };
        }).filter(Boolean);
        return {
            ...group,
            previousAnchor,
            nextAnchor,
            lowerBoundMs: Math.max(
                previousAnchor?.endMs ?? vocalStartMs,
                previousOccupied ? Math.round(Math.max(previousOccupied.start, previousOccupied.end) * 1000) : 0,
            ),
            upperBoundMs: nextOccupied
                ? Math.round(nextOccupied.start * 1000)
                : (nextAnchor?.startMs ?? null),
            interludes,
            skippedSoftAnchors,
        };
    });
}

function subtractBlockedIntervals(startMs, endMs, blocked) {
    let intervals = [{ startMs, endMs, activity: 1 }];
    for (const block of [...(blocked || [])].sort((a, b) => a.startMs - b.startMs)) {
        const next = [];
        for (const interval of intervals) {
            if (block.endMs <= interval.startMs || block.startMs >= interval.endMs) {
                next.push(interval);
                continue;
            }
            if (block.startMs > interval.startMs) {
                next.push({ ...interval, endMs: Math.min(block.startMs, interval.endMs) });
            }
            if (block.endMs < interval.endMs) {
                next.push({ ...interval, startMs: Math.max(block.endMs, interval.startMs) });
            }
        }
        intervals = next.filter((interval) => interval.endMs > interval.startMs);
    }
    return intervals;
}

function intersectVocalIntervals(available, vocalRegions) {
    const result = [];
    for (const interval of available) {
        for (const region of vocalRegions) {
            const startMs = Math.max(interval.startMs, region.startMs);
            const endMs = Math.min(interval.endMs, region.endMs);
            if (endMs > startMs) {
                result.push({ startMs, endMs, activity: Math.max(0.01, Number(region.activity) || 0.01) });
            }
        }
    }
    return result;
}

/** 긴 무성 구간으로 나뉜 VAD 후보 중 현재 미싱크 줄 수에 맞는 연속 구간을 고른다. */
function selectVocalIntervalsForGroup(intervals, lineCount) {
    if (intervals.length < 2) return intervals;
    const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
    const clusters = [];
    for (const interval of sorted) {
        const previous = clusters.at(-1);
        if (previous && interval.startMs - previous.at(-1).endMs <= 800) {
            previous.push(interval);
        } else {
            clusters.push([interval]);
        }
    }
    if (clusters.length < 2) return sorted;

    const targetDurationMs = Math.max(1, lineCount) * 3_400;
    let best = sorted;
    let bestScore = Infinity;
    for (let from = 0; from < clusters.length; from++) {
        let candidate = [];
        for (let to = from; to < clusters.length; to++) {
            candidate = candidate.concat(clusters[to]);
            const activeDurationMs = candidate.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
            const score = Math.abs(activeDurationMs - targetDurationMs);
            if (score < bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
    }
    return best;
}

function pointAtWeightedRatio(intervals, ratio) {
    const masses = intervals.map((interval) => (interval.endMs - interval.startMs) * (interval.activity || 1));
    const total = masses.reduce((sum, mass) => sum + mass, 0);
    if (!(total > 0)) return intervals[0]?.startMs ?? 0;
    let target = Math.max(0, Math.min(1, ratio)) * total;
    for (let index = 0; index < intervals.length; index++) {
        const interval = intervals[index];
        const mass = masses[index];
        if (target <= mass || index === intervals.length - 1) {
            return Math.round(interval.startMs + Math.min(interval.endMs - interval.startMs, target / (interval.activity || 1)));
        }
        target -= mass;
    }
    return intervals.at(-1)?.endMs ?? 0;
}

function intervalEndAt(intervals, pointMs) {
    return intervals.find((interval) => pointMs >= interval.startMs && pointMs < interval.endMs)?.endMs
        ?? intervals.find((interval) => interval.startMs >= pointMs)?.endMs
        ?? intervals.at(-1)?.endMs
        ?? pointMs;
}

const VAD_MIN_REGION_MS = 160;
const VAD_BREATH_GAP_MAX_MS = 400;
const VAD_CLUSTER_GAP_MS = 800;

function addScore(left, right) {
    return left.map((value, index) => value + right[index]);
}

function compareScore(left, right) {
    if (!right) return -1;
    for (let index = 0; index < left.length; index++) {
        if (Math.abs(left[index] - right[index]) > 0.001) return left[index] - right[index];
    }
    return 0;
}

/**
 * 초록색 VAD 블록의 시작/끝을 경계 후보로 삼아 한 그룹 전체를 원문 순서로
 * 배치한다. 각 줄은 하나 이상의 연속 블록을 쓰며 800ms가 넘는 공백은 절대
 * 가로지르지 않는다. 점수는 CTC 거리 → 줄 경계 품질 → 발화 길이 → 버린
 * 보컬량 순서의 사전식 비교다.
 */
export function optimizeVocalBoundaryAssignments(intervals, entries, weights, lexicalEligibility) {
    const regions = (intervals || [])
        .filter((region) => region.endMs - region.startMs >= VAD_MIN_REGION_MS)
        .sort((left, right) => left.startMs - right.startMs);
    const lineCount = entries?.length || 0;
    if (!lineCount || regions.length < lineCount) return null;

    const masses = regions.map((region) =>
        (region.endMs - region.startMs) * Math.max(0.01, Number(region.activity) || 0.01));
    const totalActiveMs = regions.reduce((sum, region) => sum + region.endMs - region.startMs, 0);
    const totalWeight = Math.max(1, (weights || []).reduce((sum, weight) => sum + weight, 0));
    const memo = new Map();

    const solve = (lineIndex, cursor) => {
        const key = `${lineIndex}:${cursor}`;
        if (memo.has(key)) return memo.get(key);
        if (lineIndex >= lineCount) {
            const skipped = regions.slice(cursor).reduce((sum, region) => sum + region.endMs - region.startMs, 0);
            const done = { score: [0, 0, 0, skipped, 0], assignments: [] };
            memo.set(key, done);
            return done;
        }

        const remainingLines = lineCount - lineIndex - 1;
        let best = null;
        for (let start = cursor; start < regions.length - remainingLines; start++) {
            const skippedBefore = regions.slice(cursor, start)
                .reduce((sum, region) => sum + region.endMs - region.startMs, 0);
            let activeMs = 0;
            let activityMass = 0;
            for (let end = start; end < regions.length - remainingLines; end++) {
                if (end > start && regions[end].startMs - regions[end - 1].endMs > VAD_CLUSTER_GAP_MS) break;
                activeMs += regions[end].endMs - regions[end].startMs;
                activityMass += masses[end];
                const minimumMs = Math.max(200, Number(weights?.[lineIndex] || 1) * 50);
                if (activeMs < minimumMs) continue;
                const tail = solve(lineIndex + 1, end + 1);
                if (!tail) continue;

                const startMs = regions[start].startMs;
                const endMs = regions[end].endMs;
                const lexical = lexicalEligibility?.[lineIndex] || {};
                const hasEvidenceTimes = lexical.selectedEvidenceStartMs != null
                    && lexical.selectedEvidenceEndMs != null;
                const evidenceStart = Number(lexical.selectedEvidenceStartMs);
                const evidenceEnd = Number(lexical.selectedEvidenceEndMs);
                const hasEvidence = lexical.boundaryEvidenceEligible === true
                    && hasEvidenceTimes
                    && Number.isFinite(evidenceStart) && Number.isFinite(evidenceEnd);
                const lexicalDistance = hasEvidence
                    ? Math.abs(startMs - evidenceStart) + Math.abs(endMs - evidenceEnd)
                    : 0;
                const nextRegion = regions[end + 1];
                const boundaryGap = nextRegion ? nextRegion.startMs - regions[end].endMs : VAD_CLUSTER_GAP_MS;
                const boundaryPenalty = lineIndex === lineCount - 1
                    ? 0
                    : (boundaryGap >= VAD_BREATH_GAP_MAX_MS ? 0 : Math.max(1, VAD_BREATH_GAP_MAX_MS - boundaryGap));
                const expectedActiveMs = totalActiveMs * Number(weights?.[lineIndex] || 1) / totalWeight;
                const durationDeviation = Math.abs(activeMs - expectedActiveMs);
                const ownScore = [lexicalDistance, boundaryPenalty, durationDeviation, skippedBefore, -activityMass];
                const candidate = {
                    score: addScore(ownScore, tail.score),
                    assignments: [{
                        startMs,
                        endMs,
                        regions: regions.slice(start, end + 1).map((region) => ({ ...region })),
                        activeMs,
                        boundaryGapAfterMs: nextRegion ? boundaryGap : null,
                        startBoundary: 'vad_start',
                        endBoundary: 'vad_end',
                        lexicalDistanceMs: hasEvidence ? lexicalDistance : null,
                        skippedVocalMs: skippedBefore,
                    }, ...tail.assignments],
                };
                if (!best || compareScore(candidate.score, best.score) < 0) best = candidate;
            }
        }
        memo.set(key, best);
        return best;
    };

    return solve(0, 0);
}

/** 앵커 구간 안에서 VAD 누적량(없으면 시간)을 가사 길이 비율로 분배한다. */
export function estimateUnsyncedTimings(groups, diagnostics = {}) {
    const audioDurationMs = Number(diagnostics.audio_duration_ms ?? diagnostics.audioDurationMs) || 0;
    const vocalRegions = (diagnostics.vocal_regions ?? diagnostics.vocalRegions ?? [])
        .map((region) => ({
            startMs: Number(region.start_ms ?? region.startMs),
            endMs: Number(region.end_ms ?? region.endMs),
            activity: Number(region.activity),
        }))
        .filter((region) => Number.isFinite(region.startMs) && Number.isFinite(region.endMs) && region.endMs > region.startMs);
    const lexicalEvidenceById = diagnostics.lexical_evidence_by_id
        ?? diagnostics.lexicalEvidenceById
        ?? {};
    const nonLexicalVocalRegions = (diagnostics.non_lexical_vocal_regions
        ?? diagnostics.nonLexicalVocalRegions
        ?? [])
        .map((region) => ({
            startMs: Number(region.start_ms ?? region.startMs),
            endMs: Number(region.end_ms ?? region.endMs),
            reason: 'non_lexical_vocal_region',
        }))
        .filter((region) => Number.isFinite(region.startMs) && Number.isFinite(region.endMs) && region.endMs > region.startMs);
    const estimates = [];
    const rejectedGroups = [];

    for (const group of groups || []) {
        if (!group.entries?.length) continue;
        let lowerBoundMs = Math.max(0, Number(group.lowerBoundMs) || 0);
        const lastVocalEndMs = vocalRegions.at(-1)?.endMs || 0;
        let upperBoundMs = group.upperBoundMs == null ? Number.NaN : Number(group.upperBoundMs);
        const hasReliableUpperBound = Number.isFinite(upperBoundMs)
            || audioDurationMs > lowerBoundMs
            || lastVocalEndMs > lowerBoundMs;
        if (!Number.isFinite(upperBoundMs)) {
            upperBoundMs = audioDurationMs > lowerBoundMs
                ? audioDurationMs
                : (lastVocalEndMs > lowerBoundMs
                    ? lastVocalEndMs
                    : lowerBoundMs + Math.max(800, group.entries.length * 4_500));
        }
        if (upperBoundMs <= lowerBoundMs) {
            if (group.nextAnchor) {
                // 실제 동시 보컬 때문에 앞줄 end가 다음 줄 start를 넘은 경우에는
                // 앞 앵커의 start 이후를 사용한다. 수동/채택 시각은 이동하지 않는다.
                lowerBoundMs = Math.max(0, Math.min(
                    Number(group.previousAnchor?.startMs) + 1 || 0,
                    upperBoundMs - group.entries.length - 1,
                ));
            } else {
                upperBoundMs = lowerBoundMs + Math.max(800, group.entries.length * 200);
            }
        }

        const blockedIntervals = [...(group.interludes || []), ...nonLexicalVocalRegions];
        const available = subtractBlockedIntervals(lowerBoundMs, upperBoundMs, blockedIntervals);
        // If interludes/non-lexical vocals consume the whole window, do not
        // silently restore the blocked interval as a time-weighted fallback.
        const fallbackIntervals = available;
        const activeIntervals = intersectVocalIntervals(fallbackIntervals, vocalRegions);
        const selectedVocalIntervals = selectVocalIntervalsForGroup(activeIntervals, group.entries.length);
        const allocationIntervals = selectedVocalIntervals.length ? selectedVocalIntervals : fallbackIntervals;
        const method = activeIntervals.length ? 'vad_weighted' : 'time_weighted';
        const weights = group.entries.map((entry) => singableWeight(entry.text));
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        const availableDuration = (activeIntervals.length ? activeIntervals : allocationIntervals)
            .reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
        // 짧은 호흡형 가사는 0.8~1.0초에도 충분히 성립한다. 줄별 실제 길이
        // 검사는 뒤에서 다시 수행하므로 그룹 밀도 단계에서 1초 고정으로 먼저
        // 탈락시키지 않는다.
        const requiredDurationMs = Math.max(group.entries.length * 800, totalWeight * 90);
        const windowDensity = availableDuration / Math.max(1, group.entries.length);
        const lexicalEligibility = group.entries.map((entry) => {
            const evidence = lexicalEvidenceById instanceof Map
                ? lexicalEvidenceById.get(entry.id)
                : lexicalEvidenceById[entry.id];
            const allCandidates = Array.isArray(evidence?.candidates) && evidence.candidates.length
                ? evidence.candidates
                : (evidence ? [evidence] : []);
            const candidateFitsWindow = (candidate) => {
                const startMs = Number(candidate?.startMs);
                const endMs = Number(candidate?.endMs);
                if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return true;
                return endMs >= lowerBoundMs - 500 && startMs <= upperBoundMs + 500;
            };
            const candidatesInWindow = allCandidates.filter(candidateFitsWindow);
            const windowCandidates = candidatesInWindow
                .filter((candidate) => candidate?.thirdPassEligible !== false);
            const selectedEvidence = windowCandidates.reduce((best, candidate) =>
                !best || Number(candidate?.similarity) > Number(best?.similarity) ? candidate : best, null);
            const boundaryEvidence = candidatesInWindow
                .filter((candidate) => Number(candidate?.similarity) >= 0.15)
                .filter((candidate) => !(candidate?.rejectedReasons || []).some((reason) =>
                    VAD_ORDERED_STRUCTURAL_REJECTION_REASONS.has(reason)))
                .reduce((best, candidate) =>
                    !best || Number(candidate?.similarity) > Number(best?.similarity) ? candidate : best, null);
            const lineKind = entry.lineKind || selectedEvidence?.lineKind
                || evidence?.lineKind || classifyAlignmentLine(entry.text);
            const requiredSimilarity = lineKind === 'vocable' ? 0.50 : 0.25;
            const similarity = Number(selectedEvidence?.similarity);
            return {
                id: entry.id,
                lineKind,
                repeatedLyric: entry.repeatedLyric === true,
                similarity: Number.isFinite(similarity) ? similarity : null,
                requiredSimilarity,
                eligible: Number.isFinite(similarity) && similarity >= requiredSimilarity,
                boundaryEvidenceEligible: !!boundaryEvidence,
                evidenceWindowMatched: windowCandidates.length > 0,
                candidateWindowMatched: candidatesInWindow.length > 0,
                evidenceCandidateCount: allCandidates.length,
                hasOutOfWindowCandidate: allCandidates.length > 0 && candidatesInWindow.length === 0,
                hasStructurallyInvalidCandidate: candidatesInWindow.some((candidate) =>
                    Number(candidate?.similarity) >= 0.15
                    && (candidate?.rejectedReasons || []).some((reason) =>
                        VAD_ORDERED_STRUCTURAL_REJECTION_REASONS.has(reason))),
                selectedEvidenceStartMs: Number.isFinite(Number((selectedEvidence || boundaryEvidence)?.startMs))
                    ? Number((selectedEvidence || boundaryEvidence).startMs) : null,
                selectedEvidenceEndMs: Number.isFinite(Number((selectedEvidence || boundaryEvidence)?.endMs))
                    ? Number((selectedEvidence || boundaryEvidence).endMs) : null,
                selectedEvidenceAccepted: selectedEvidence?.accepted === true,
                selectedEvidenceRejectedReasons: Array.isArray(selectedEvidence?.rejectedReasons)
                    ? [...selectedEvidence.rejectedReasons] : [],
            };
        });
        // 문자 증거가 약해도 닫힌 시간 창 안에 실제 VAD가 충분하면 원문 순서를
        // 기준으로 복구한다. 원시 CTC 위치는 쓰지 않고 검토 필요 상태로 남긴다.
        const vadOrderedGroupEligible = method === 'vad_weighted'
            && hasReliableUpperBound
            && availableDuration >= requiredDurationMs;
        const recoveryEligibility = lexicalEligibility.map((item) => {
            const vadOrderedEligible = item.lineKind === 'lyric'
                && vadOrderedGroupEligible
                && !(item.repeatedLyric && item.hasOutOfWindowCandidate)
                && !item.hasStructurallyInvalidCandidate;
            return item.eligible || vadOrderedEligible;
        });
        const boundaryOptimization = activeIntervals.length
            ? optimizeVocalBoundaryAssignments(activeIntervals, group.entries, weights, lexicalEligibility)
            : null;
        const lexicallyIneligibleIndices = recoveryEligibility
            .map((eligible, index) => eligible ? null : index)
            .filter((index) => index != null);
        if (lexicallyIneligibleIndices.length > 0) {
            const ineligibleEntries = lexicallyIneligibleIndices.map((index) => group.entries[index]);
            rejectedGroups.push({
                segmentIds: ineligibleEntries.map((entry) => entry.id),
                entries: ineligibleEntries,
                previousAnchor: group.previousAnchor,
                nextAnchor: group.nextAnchor,
                skippedSoftAnchors: group.skippedSoftAnchors || [],
                usedRegions: allocationIntervals,
                excludedNonLexicalRegions: nonLexicalVocalRegions,
                method,
                weights: lexicallyIneligibleIndices.map((index) => weights[index]),
                lexicalEligibility: lexicallyIneligibleIndices.map((index) => lexicalEligibility[index]),
                availableDurationMs: Math.round(availableDuration),
                requiredDurationMs: Math.round(requiredDurationMs),
                windowDensity: Math.round(windowDensity),
                rejectedReason: 'no_lexical_evidence',
            });
            if (lexicallyIneligibleIndices.length === group.entries.length) continue;
        }
        if (availableDuration < requiredDurationMs) {
            rejectedGroups.push({
                segmentIds: group.entries.map((entry) => entry.id),
                entries: group.entries,
                previousAnchor: group.previousAnchor,
                nextAnchor: group.nextAnchor,
                skippedSoftAnchors: group.skippedSoftAnchors || [],
                usedRegions: allocationIntervals,
                method,
                weights,
                lexicalEligibility,
                excludedNonLexicalRegions: nonLexicalVocalRegions,
                availableDurationMs: Math.round(availableDuration),
                requiredDurationMs: Math.round(requiredDurationMs),
                windowDensity: Math.round(windowDensity),
                rejectedReason: 'insufficient_window_density',
            });
            continue;
        }
        const minimumGapMs = Math.max(80, Math.min(200, Math.floor(availableDuration / Math.max(1, group.entries.length * 4))));
        const timelineGapCapacity = Math.floor((upperBoundMs - lowerBoundMs) / Math.max(1, group.entries.length + 1));
        if (timelineGapCapacity < 80) {
            rejectedGroups.push({
                segmentIds: group.entries.map((entry) => entry.id),
                entries: group.entries,
                previousAnchor: group.previousAnchor,
                nextAnchor: group.nextAnchor,
                skippedSoftAnchors: group.skippedSoftAnchors || [],
                usedRegions: allocationIntervals,
                excludedNonLexicalRegions: nonLexicalVocalRegions,
                method,
                weights,
                lexicalEligibility,
                availableDurationMs: Math.round(availableDuration),
                requiredDurationMs: Math.round(requiredDurationMs),
                windowDensity: Math.round(windowDensity),
                rejectedReason: 'insufficient_window_density',
            });
            continue;
        }
        const effectiveGapMs = Math.min(minimumGapMs, timelineGapCapacity);
        let cumulative = 0;
        let previousStartMs = -Infinity;

        const starts = group.entries.map((entry, index) => {
            const boundaryAssignment = boundaryOptimization?.assignments?.[index];
            if (boundaryAssignment) {
                previousStartMs = boundaryAssignment.startMs;
                cumulative += weights[index];
                return boundaryAssignment.startMs;
            }
            const proposedStartMs = pointAtWeightedRatio(allocationIntervals, cumulative / totalWeight);
            const minimumStartMs = index === 0 ? lowerBoundMs + effectiveGapMs : previousStartMs + effectiveGapMs;
            const maximumStartMs = upperBoundMs - effectiveGapMs * (group.entries.length - index);
            const startMs = Math.max(minimumStartMs, Math.min(proposedStartMs, maximumStartMs));
            previousStartMs = startMs;
            cumulative += weights[index];
            return startMs;
        });

        cumulative = 0;
        let previousChosenEndMs = lowerBoundMs;
        const groupEstimates = group.entries.map((entry, index) => {
            cumulative += weights[index];
            const rawEndMs = pointAtWeightedRatio(allocationIntervals, cumulative / totalWeight);
            const intervalEndMs = intervalEndAt(allocationIntervals, starts[index]);
            const nextStartMs = starts[index + 1] ?? upperBoundMs;
            let endMs = Math.min(rawEndMs, intervalEndMs, nextStartMs, upperBoundMs);
            if (endMs <= starts[index]) endMs = Math.min(upperBoundMs, starts[index] + minimumGapMs);
            const boundaryAssignment = boundaryOptimization?.assignments?.[index] || null;
            let chosenStartMs = boundaryAssignment?.startMs ?? starts[index];
            let chosenEndMs = boundaryAssignment?.endMs ?? endMs;
            let chosenMethod = method;
            const evidenceStartMs = Number(lexicalEligibility[index].selectedEvidenceStartMs);
            const evidenceEndMs = Number(lexicalEligibility[index].selectedEvidenceEndMs);
            const evidenceDurationMs = evidenceEndMs - evidenceStartMs;
            const evidenceFitsWindow = lexicalEligibility[index].eligible
                && Number.isFinite(evidenceStartMs) && Number.isFinite(evidenceEndMs)
                && evidenceDurationMs >= MIN_LINE_DURATION_MS
                && evidenceStartMs >= lowerBoundMs - THIRD_PASS_EVIDENCE_TOLERANCE_MS
                && evidenceEndMs <= upperBoundMs + THIRD_PASS_EVIDENCE_TOLERANCE_MS
                && evidenceStartMs >= previousChosenEndMs - THIRD_PASS_EVIDENCE_TOLERANCE_MS
                && evidenceEndMs <= nextStartMs + THIRD_PASS_EVIDENCE_TOLERANCE_MS;
            if (evidenceFitsWindow && !boundaryAssignment) {
                chosenStartMs = Math.max(lowerBoundMs, evidenceStartMs);
                chosenEndMs = Math.min(upperBoundMs, evidenceEndMs);
                chosenMethod = 'lexical_candidate';
            } else if (boundaryAssignment && recoveryEligibility[index]) {
                const hasTimedLexicalEvidence = lexicalEligibility[index].eligible
                    && lexicalEligibility[index].selectedEvidenceStartMs != null
                    && lexicalEligibility[index].selectedEvidenceEndMs != null;
                chosenMethod = hasTimedLexicalEvidence
                    ? 'lexical_candidate'
                    : 'vad_boundary_review';
            } else if (!lexicalEligibility[index].eligible && recoveryEligibility[index]) {
                chosenMethod = 'vad_ordered_review';
            }
            previousChosenEndMs = chosenEndMs;
            return {
                segment_id: entry.id,
                segmentIndex: entry.segmentIndex,
                text: entry.text,
                start_ms: Math.round(chosenStartMs),
                end_ms: Math.max(Math.round(chosenStartMs) + 80, Math.round(chosenEndMs)),
                confidence: 0,
                alignmentSource: 'anchor_interpolation',
                method: chosenMethod,
                quality_flags: chosenMethod === 'vad_boundary_review'
                    ? ['lexical_uncertain', 'vad_boundary_review', 'review_required']
                    : (chosenMethod === 'vad_ordered_review'
                        ? ['lexical_uncertain', 'vad_ordered_review', 'review_required']
                        : []),
                vadAssignment: boundaryAssignment ? {
                    regions: boundaryAssignment.regions,
                    startBoundary: boundaryAssignment.startBoundary,
                    endBoundary: boundaryAssignment.endBoundary,
                    lexicalDistanceMs: boundaryAssignment.lexicalDistanceMs,
                    skippedVocalMs: boundaryAssignment.skippedVocalMs,
                    boundaryGapAfterMs: boundaryAssignment.boundaryGapAfterMs,
                } : null,
                weight: weights[index],
                previousAnchor: group.previousAnchor,
                nextAnchor: group.nextAnchor,
                usedRegions: allocationIntervals,
                excludedNonLexicalRegions: nonLexicalVocalRegions,
                lexicalEligibility: lexicalEligibility[index],
                availableDurationMs: Math.round(availableDuration),
                requiredDurationMs: Math.round(requiredDurationMs),
                windowDensity: Math.round(windowDensity),
            };
        });
        const perLineDurationChecks = groupEstimates.map((estimate, index) => {
            const units = Math.max(1, weights[index]);
            const durationMs = estimate.end_ms - estimate.start_ms;
            const minimumDurationMs = Math.max(MIN_LINE_DURATION_MS, units * MIN_MS_PER_SINGABLE_UNIT);
            return {
                id: estimate.segment_id,
                durationMs,
                minimumDurationMs,
                plausible: durationMs >= minimumDurationMs,
            };
        });
        const invalidEstimateIndices = perLineDurationChecks
            .map((check, index) => recoveryEligibility[index] && !check.plausible ? index : null)
            .filter((index) => index != null);
        if (invalidEstimateIndices.length > 0) {
            const invalidEntries = invalidEstimateIndices.map((index) => group.entries[index]);
            rejectedGroups.push({
                segmentIds: invalidEntries.map((entry) => entry.id),
                entries: invalidEntries,
                previousAnchor: group.previousAnchor,
                nextAnchor: group.nextAnchor,
                skippedSoftAnchors: group.skippedSoftAnchors || [],
                usedRegions: allocationIntervals,
                excludedNonLexicalRegions: nonLexicalVocalRegions,
                method,
                weights: invalidEstimateIndices.map((index) => weights[index]),
                lexicalEligibility: invalidEstimateIndices.map((index) => lexicalEligibility[index]),
                perLineDurationChecks: invalidEstimateIndices.map((index) => perLineDurationChecks[index]),
                availableDurationMs: Math.round(availableDuration),
                requiredDurationMs: Math.round(requiredDurationMs),
                windowDensity: Math.round(windowDensity),
                rejectedReason: 'insufficient_per_line_duration',
            });
        }
        estimates.push(...groupEstimates.filter((_estimate, index) =>
            recoveryEligibility[index] && !invalidEstimateIndices.includes(index)));
    }
    return { estimates, rejectedGroups };
}

/** 추정이 물리적으로 불가능한 그룹은 타임코드를 만들지 않고 검토 상태로 남긴다. */
export function markRejectedEstimateGroups(segments, rejectedGroups) {
    const markedIds = [];
    for (const group of rejectedGroups || []) {
        for (const entry of group.entries || []) {
            const segment = segments?.[entry.segmentIndex];
            if (!segment || hasStoredTiming(segment)) continue;
            segment.start = 0;
            segment.end = 0;
            segment.approx = true;
            segment.confidence = 0;
            segment.alignmentTrust = 'estimated';
            segment.alignmentSource = 'unsynced_review';
            segment.qualityFlags = Array.from(new Set([
                ...(segment.qualityFlags || []),
                group.rejectedReason || 'estimate_rejected',
                ...(group.rejectedReason === 'no_lexical_evidence' ? ['lexical_uncertain'] : []),
            ]));
            markedIds.push(entry.id);
        }
    }
    return [...new Set(markedIds)];
}

/** 수동/기존 AI 타임은 건드리지 않고 완전 미싱크 세그먼트에만 추정값을 적용한다. */
export function applyEstimatedTimings(segments, estimates) {
    let applied = 0;
    for (const estimate of estimates || []) {
        const segment = segments?.[estimate.segmentIndex];
        if (!segment || hasStoredTiming(segment)) continue;
        if (!Number.isFinite(estimate.start_ms) || !Number.isFinite(estimate.end_ms)) continue;
        segment.start = Math.max(0, estimate.start_ms / 1000);
        segment.end = Math.max(segment.start + 0.08, estimate.end_ms / 1000);
        segment.approx = true;
        segment.confidence = 0;
        segment.alignmentTrust = 'estimated';
        segment.alignmentSource = estimate.method === 'vad_boundary_review'
            ? 'vad_boundary_review'
            : (estimate.method === 'vad_ordered_review'
                ? 'vad_ordered_review'
                : 'anchor_interpolation');
        if (estimate.vadAssignment) segment.vadAssignment = structuredClone(estimate.vadAssignment);
        segment.qualityFlags = Array.from(new Set([
            ...(segment.qualityFlags || []).filter((flag) => flag !== 'non_lexical_vocal_risk' && flag !== 'no_lexical_evidence'),
            ...(estimate.quality_flags || []),
        ]));
        applied++;
    }
    return applied;
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
        seg.alignmentTrust = line.alignment_trust || 'acoustic_strong';
        seg.gateDecision = line.gate_decision || 'accepted';
        seg.qualityFlags = Array.isArray(line.quality_flags) ? [...line.quality_flags] : [];
        if (typeof line.greedy_text_similarity === 'number') seg.greedyTextSimilarity = line.greedy_text_similarity;
        if (typeof line.ctc_end_ms === 'number') seg.ctcEnd = line.ctc_end_ms / 1000;
        if (typeof line.tail_extension_ms === 'number') seg.tailExtensionMs = line.tail_extension_ms;
        seg.lineKind = line.line_kind || entry.lineKind || classifyAlignmentLine(entry.text);
        if (line.repeated_lyric === true || entry.repeatedLyric === true) seg.repeatedLyric = true;
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
        if (aligned.start > 0 || aligned.end > 0) {
            original.start = aligned.start;
            original.end = aligned.end;
            original.approx = aligned.approx;
        } else if (aligned.alignmentSource === 'unsynced_review') {
            original.approx = true;
        }
        if (typeof aligned.confidence === 'number') original.confidence = aligned.confidence;
        if (aligned.alignmentSource) original.alignmentSource = aligned.alignmentSource;
        if (aligned.alignmentTrust) original.alignmentTrust = aligned.alignmentTrust;
        if (aligned.gateDecision) original.gateDecision = aligned.gateDecision;
        if (Array.isArray(aligned.qualityFlags)) original.qualityFlags = [...aligned.qualityFlags];
        if (typeof aligned.greedyTextSimilarity === 'number') original.greedyTextSimilarity = aligned.greedyTextSimilarity;
        if (typeof aligned.ctcEnd === 'number') original.ctcEnd = aligned.ctcEnd;
        if (typeof aligned.tailExtensionMs === 'number') original.tailExtensionMs = aligned.tailExtensionMs;
        if (aligned.lineKind) original.lineKind = aligned.lineKind;
        if (aligned.repeatedLyric === true) original.repeatedLyric = true;
        if (aligned.vadAssignment) original.vadAssignment = structuredClone(aligned.vadAssignment);
        if (aligned.syncAssistant) original.syncAssistant = structuredClone(aligned.syncAssistant);
        // 단어별 타임스탬프 — 모델이 Viterbi 백트레이스에서 이미 만든 값이다.
        // 여기서 들고 가지 않으면 사이드카 저장 단계까지 도달하지 못하고,
        // 줄 안 진행도는 선형 보간밖에 못 그린다.
        if (Array.isArray(aligned.words) && aligned.words.length > 0) {
            original.words = aligned.words.map((w) => ({
                word: String(w.word ?? w.text ?? ''),
                startMs: Number(w.start_ms ?? w.startMs) || 0,
                endMs: Number(w.end_ms ?? w.endMs) || 0,
            }));
        }
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
            lineKind: classifyAlignmentLine(t),
            skipPrimary,
            fallbackCandidate: skipPrimary && isEnglishLine(sourceText),
            repeatedLyric: false,
        });
        const synced = !(s.start === 0 && s.end === 0);
        // 이번/현재 세션에서 AI가 채운 approx 줄은 다음 정렬의 하드 앵커가
        // 아니다. 수동으로 확정한 시간만 전역 경로를 강제할 수 있다.
        const isManualAnchor = synced && !s.approx;
        if (isManualAnchor && typeof s.start === 'number' && s.start > 0) {
            anchors.push([idx, Math.round(s.start * 1000)]);
        }
    }
    const repeatCounts = new Map();
    const repeatKey = (text) => String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
    entries.forEach((entry) => {
        const key = repeatKey(entry.text);
        entry.repeatKey = key;
        if (key) repeatCounts.set(key, (repeatCounts.get(key) || 0) + 1);
    });
    entries.forEach((entry) => {
        entry.repeatedLyric = !!entry.repeatKey && repeatCounts.get(entry.repeatKey) > 1;
        const segment = segments?.[entry.segmentIndex];
        if (segment) segment.repeatedLyric = entry.repeatedLyric;
    });
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
    let segments = parseLrc(lrcContent, 0);
    let metadataRestore = { appliedCount: 0, skippedCount: 0, reason: 'load_failed' };
    try {
        const storedMetadata = await invoke('load_alignment_metadata', { audioPath: item.path });
        metadataRestore = applyAlignmentMetadata(segments, storedMetadata);
        segments = metadataRestore.segments;
    } catch (err) {
        console.warn('[AlignQueue] alignment metadata load failed:', err);
    }
    const restoredSegments = segments.map((segment) => ({ ...segment }));
    const automaticTimingsReset = resetAutomaticTimingsForRealignment(segments);
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
        alignmentPipelineRevision: ALIGNMENT_PIPELINE_REVISION,
        policy: {
            sourceOrder: 'immutable_segment_id',
            automaticAnchor: 'absolute_confidence_plus_lexical_nonrepeated',
            thirdPassLexicalEvidence: 'same_anchor_window_per_line',
            unsafeResult: 'unsynced_review',
        },
        audioPath: item.path,
        alignmentMode,
        markerSummary: markers,
        originalLrc: lrcContent,
        originalSegments: restoredSegments,
        metadataRestore,
        automaticTimingsReset,
        temporaryAlignmentSegments: workingSegments,
        alignmentEntries: entries,
        alignmentTexts: allTexts,
        inputSummary: traceInputSummary(allTexts, entries),
        segmentMap: traceSegmentMap(segments, workingSegments, entries),
        primarySkippedSegmentIds: entries.filter((entry) => entry.skipPrimary).map((entry) => entry.id),
        repeatedLyricIds: entries.filter((entry) => entry.repeatedLyric).map((entry) => entry.id),
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
    const hasPrimaryText = allTexts.some((text) => String(text || '').trim().length > 0);
    await traceAlignment(traceId, 'pipeline_plan', {
        alignmentMode,
        modelSpecs,
        primaryModelSpecs,
        primaryInput: traceInputSummary(allTexts, entries),
        primarySkippedBecauseEmpty: !hasPrimaryText,
        primarySkippedIds: entries.filter((entry) => entry.skipPrimary).map((entry) => entry.id),
        repeated_lyric: entries.filter((entry) => entry.repeatedLyric).map((entry) => entry.id),
        provisionalPass: alignmentMode === 'en-ko' && entries.some((entry) => entry.skipPrimary && entry.fallbackCandidate),
        fallbackEnabled: alignmentMode === 'en-ko' && prepared.entries?.some((entry) => entry.fallbackCandidate) === true,
    });
    const passResults = [];
    let primaryDiagnostics = null;
    if (!hasPrimaryText) {
        await traceAlignment(traceId, 'primary_model_skipped', {
            reason: 'no_primary_language_tokens',
            requestedIds: entries.map((entry) => entry.id),
            skippedIds: entries.filter((entry) => entry.skipPrimary).map((entry) => entry.id),
        });
    }
    for (let pi = 0; hasPrimaryText && pi < primaryModelSpecs.length; pi++) {
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
        if (pi === 0) primaryDiagnostics = result?.diagnostics || null;
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
    const sourceEvidenceGate = {
        accepted: [...primaryGate.accepted],
        rejected: [...primaryGate.rejected],
        confidenceFloor: primaryGate.confidenceFloor,
    };
    const lexicalEvidenceById = new Map();
    const nonLexicalVocalRegionCandidates = [];
    collectGateLexicalEvidence(primaryGate, lexicalEvidenceById, nonLexicalVocalRegionCandidates);
    markLexicalGateRejections(workingSegments, entries, primaryGate);
    lines = primaryGate.accepted;
    const acceptedAcousticLines = [...lines];
    await traceAlignment(traceId, 'primary_quality_gate', {
        confidenceFloor: primaryGate.confidenceFloor,
        accepted: primaryGate.accepted,
        rejected: primaryGate.rejected,
        summary: traceGateSummary(primaryGate),
        doubling_ambiguity: primaryGate.accepted
            .filter((line) => line.quality_flags?.includes('doubling_ambiguity'))
            .map((line) => line.segment_id),
        non_lexical_vocal_regions: primaryGate.nonLexicalVocalRegions || [],
    });
    let rejectedCount = primaryGate.rejected.length;
    let appliedCount = mergeAlignmentResult(workingSegments, lines, entries);

    // Optional per-line fallback: only English phonetic candidates with no
    // usable Korean-model result are retried, and only when the English model
    // is already installed. Batch processing never prompts for a download.
    const unavailableEnglishModelIds = [];
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
                    if (!primaryDiagnostics) primaryDiagnostics = provisionalResult?.diagnostics || null;
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
                        lineKind: entry.lineKind || classifyAlignmentLine(entry.text),
                    }));
                    const rawFallbackLines = attachMissingSegmentIds(
                        (fallbackResult && fallbackResult.lines) || [],
                        fallbackAlignmentEntries,
                    );
                    if (!primaryDiagnostics) primaryDiagnostics = fallbackResult?.diagnostics || null;
                    const fallbackGate = gateAlignmentLines(rawFallbackLines, fallbackAlignmentEntries, {
                        windowStartMs: fallbackWindow.windowStartMs,
                        windowEndMs: fallbackWindow.windowEndMs,
                        // The time window already prevents cross-verse
                        // placement, so allow a weaker individual line when
                        // neighboring lines provide the acoustic context.
                        confidenceScale: 0.25,
                    });
                    sourceEvidenceGate.accepted.push(...fallbackGate.accepted);
                    sourceEvidenceGate.rejected.push(...fallbackGate.rejected);
                    collectGateLexicalEvidence(fallbackGate, lexicalEvidenceById, nonLexicalVocalRegionCandidates);
                    markLexicalGateRejections(workingSegments, fallbackAlignmentEntries, fallbackGate);
                    const fallbackLines = fallbackGate.accepted;
                    acceptedAcousticLines.push(...fallbackLines);
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
        } else {
            unavailableEnglishModelIds.push(...prepared.entries
                .filter((entry) => entry.fallbackCandidate)
                .map((entry) => `segment:${entry.segmentIndex}`));
            await traceAlignment(traceId, 'english_fallback_unavailable', {
                reason: 'english_model_not_installed',
                segmentIds: unavailableEnglishModelIds,
                sourceTextPreserved: true,
            });
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
            return segment && !hasStoredTiming(segment);
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
            lineKind: entry.lineKind || classifyAlignmentLine(entry.text),
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
            sourceEvidenceGate.accepted.push(...rescueGate.accepted);
            sourceEvidenceGate.rejected.push(...rescueGate.rejected);
            collectGateLexicalEvidence(rescueGate, lexicalEvidenceById, nonLexicalVocalRegionCandidates);
            markLexicalGateRejections(workingSegments, alignmentEntries, rescueGate);
            const applied = applyFallbackLines(workingSegments, rescueWindow.entries, rescueGate.accepted);
            acceptedAcousticLines.push(...rescueGate.accepted);
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

    // 3차 안전망: 음향 필터와 local rescue를 모두 통과하지 못한 실제 가사만
    // 앞뒤 앵커 사이의 보컬 활동량에 따라 추정 배치한다. 기존 싱크와 원문은
    // 읽기 전용이며, 추정값은 강한 검토 대상으로 명시한다.
    const nonLexicalVocalRegions = mergeBlockedVocalRegions(nonLexicalVocalRegionCandidates);
    const estimateDiagnostics = {
        ...(primaryDiagnostics || {}),
        lexical_evidence_by_id: Object.fromEntries(lexicalEvidenceById),
        non_lexical_vocal_regions: nonLexicalVocalRegions,
    };
    const estimateGroups = buildFinalEstimateGroups(workingSegments, entries, markers);
    const estimateResult = estimateUnsyncedTimings(estimateGroups, estimateDiagnostics);
    const estimatedLines = estimateResult.estimates;
    const estimateRejectedGroups = estimateResult.rejectedGroups;
    const estimatedAppliedCount = applyEstimatedTimings(workingSegments, estimatedLines);
    const unsyncedReviewIds = markRejectedEstimateGroups(workingSegments, estimateRejectedGroups);
    appliedCount += estimatedAppliedCount;
    await traceAlignment(traceId, 'third_pass_estimate', {
        diagnostics: estimateDiagnostics,
        non_lexical_vocal_region: nonLexicalVocalRegions,
        groupCount: estimateGroups.length,
        groups: estimateGroups.map((group) => ({
            segmentIds: group.entries.map((entry) => entry.id),
            previousAnchor: group.previousAnchor,
            nextAnchor: group.nextAnchor,
            lowerBoundMs: group.lowerBoundMs,
            upperBoundMs: group.upperBoundMs,
            excludedInterludes: group.interludes,
            third_pass_lexical_eligibility: group.entries.map((entry) => ({
                id: entry.id,
                line_kind: entry.lineKind || classifyAlignmentLine(entry.text),
                evidence: lexicalEvidenceById.get(entry.id) || null,
            })),
            softAnchorSkipped: group.skippedSoftAnchors,
            repeated_lyric: group.entries.filter((entry) => entry.repeatedLyric).map((entry) => entry.id),
            anchor_trust: {
                previous: group.previousAnchor?.trust || null,
                next: group.nextAnchor?.trust || null,
            },
            soft_anchor_used: false,
            soft_anchor_skipped: group.skippedSoftAnchors,
        })),
        estimates: estimatedLines,
        rejectedGroups: estimateRejectedGroups,
        estimate_rejections: estimateRejectedGroups.map((group) => ({
            segment_ids: group.segmentIds,
            window_density: group.windowDensity,
            required_duration_ms: group.requiredDurationMs,
            available_duration_ms: group.availableDurationMs,
            estimate_rejected_reason: group.rejectedReason,
            third_pass_lexical_eligibility: group.lexicalEligibility || [],
        })),
        estimateRejectedReasons: estimateRejectedGroups.reduce((counts, group) => {
            counts[group.rejectedReason] = (counts[group.rejectedReason] || 0) + 1;
            return counts;
        }, {}),
        unsyncedReviewIds,
        unsynced_review_ids: unsyncedReviewIds,
        appliedCount: estimatedAppliedCount,
    });

    const finalTimelineDropped = enforceAiTimelineOrder(workingSegments);
    const finalTimelineUnsyncedIds = [];
    for (const dropped of finalTimelineDropped) {
        const segment = workingSegments?.[dropped.index];
        if (!segment) continue;
        segment.approx = true;
        segment.confidence = 0;
        segment.alignmentTrust = 'estimated';
        segment.alignmentSource = 'unsynced_review';
        segment.qualityFlags = Array.from(new Set([
            ...(segment.qualityFlags || []),
            dropped.reason || 'final_timeline_conflict',
        ]));
        finalTimelineUnsyncedIds.push(dropped.id);
    }
    if (finalTimelineDropped.length > 0) {
        appliedCount = Math.max(0, appliedCount - finalTimelineDropped.length);
        rejectedCount += finalTimelineDropped.length;
    }
    await traceAlignment(traceId, 'post_merge_timeline_gate', {
        phase: 'after_third_pass',
        dropped: finalTimelineDropped,
        droppedCount: finalTimelineDropped.length,
        unsynced_review_ids: finalTimelineUnsyncedIds,
        reason: finalTimelineDropped.length > 0 ? 'third_pass_reversed_original_order' : null,
    });

    const assistantRegions = primaryDiagnostics?.vocal_regions ?? primaryDiagnostics?.vocalRegions;
    const assistantDurationMs = Number(primaryDiagnostics?.audio_duration_ms
        ?? primaryDiagnostics?.audioDurationMs) || 0;
    const assistantResult = Array.isArray(assistantRegions)
        ? applyAlignmentAssistant(workingSegments, assistantRegions, assistantDurationMs)
        : { assessments: [], changes: [] };
    if (assistantResult.changes.length > 0) {
        await traceAlignment(traceId, 'alignment_assistant_validation', {
            changeCount: assistantResult.changes.length,
            changes: assistantResult.changes,
            vadRegionCount: assistantRegions.length,
            audioDurationMs: assistantDurationMs,
        });
    }

    const finalUnsyncedEntries = entries.filter((entry) => {
        const segment = workingSegments[entry.segmentIndex];
        return !segment || !hasStoredTiming(segment);
    });
    const finalUnsyncedCount = finalUnsyncedEntries.length;
    const recoverySummary = {
        directAcousticCount: workingSegments.filter((segment) =>
            hasStoredTiming(segment) && segment.alignmentTrust === 'acoustic_strong').length,
        acousticSoftCount: workingSegments.filter((segment) =>
            hasStoredTiming(segment) && segment.alignmentTrust === 'acoustic_soft').length,
        vadOrderedReviewCount: workingSegments.filter((segment) =>
            hasStoredTiming(segment) && segment.alignmentSource === 'vad_ordered_review').length,
        vadBoundaryReviewCount: workingSegments.filter((segment) =>
            hasStoredTiming(segment) && segment.alignmentSource === 'vad_boundary_review').length,
        blockedVocableRegionCount: nonLexicalVocalRegions.length,
        finalUnsyncedCount,
    };

    // 4. 저장 (마커 줄 보존)
    const beforeSaveSegments = segments.map((segment) => ({ ...segment }));
    const savedSegments = copyAlignmentTiming(segments, workingSegments);
    const content = encodeLrc(savedSegments, extractMarkerLines(lrcContent));
    const timingAudit = traceTimingAudit(beforeSaveSegments, savedSegments);
    if (!timingAudit.sourceTextOrderPreserved
        || !timingAudit.monotonicOrderPreserved
        || !timingAudit.durationSanityPreserved) {
        item.status = 'error';
        item.error = '최종 가사 순서·겹침·길이 감사에 실패해 저장하지 않았습니다.';
        await traceAlignment(traceId, 'stopped', {
            reason: 'final_timeline_integrity_failure',
            timingAudit,
            finalUnsyncedIds: finalUnsyncedEntries.map((entry) => entry.id),
        });
        return;
    }
    const lyricsSourceAssessment = assessLyricsSourceMismatch({
        entries,
        primaryGate: sourceEvidenceGate,
        timingAudit,
    });
    if (lyricsSourceAssessment.suspected) {
        await traceAlignment(traceId, 'lyrics_source_warning', {
            warning: 'verify_lyrics_source_or_song_version',
            ...lyricsSourceAssessment,
        });
    }
    await traceAlignment(traceId, 'before_save', {
        appliedCount,
        attemptRejectedCount: rejectedCount,
        finalUnsyncedCount,
        finalUnsyncedIds: finalUnsyncedEntries.map((entry) => entry.id),
        recoverySummary,
        unavailableEnglishModelIds,
        unsynced_review_ids: [...new Set([...unsyncedReviewIds, ...finalTimelineUnsyncedIds])],
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
                anchorTrust: {
                    previous: window.windowContext?.previousAnchor?.trust || null,
                    next: window.windowContext?.nextAnchor?.trust || null,
                },
                softAnchorSkipped: window.windowContext?.softAnchorSkipped || [],
                soft_anchor_used: false,
                soft_anchor_skipped: window.windowContext?.softAnchorSkipped || [],
            })),
            rescueAppliedCount,
            rescueRejectedCount,
        },
        thirdPass: {
            groupCount: estimateGroups.length,
            estimatedAppliedCount,
            methods: estimatedLines.reduce((counts, line) => {
                counts[line.method] = (counts[line.method] || 0) + 1;
                return counts;
            }, {}),
            estimatedIds: estimatedLines.map((line) => line.segment_id),
            rejectedGroups: estimateRejectedGroups,
            unsyncedReviewIds,
            unsynced_review_ids: unsyncedReviewIds,
        },
        timingAudit,
        lyricsSourceAssessment,
        finalOriginalSegments: savedSegments,
        outputLrc: content,
    });
    try {
        await invoke('save_alignment_metadata', {
            audioPath: item.path,
            // 보컬 활동 구간은 곡 단위 파생 데이터다 — 정렬이 이미 계산해
            // 놓고 여태 버려졌다. 편집기의 경계 스냅·구간 음영이 이걸 쓴다.
            metadata: buildAlignmentMetadata(savedSegments, {
                vocalRegions: primaryDiagnostics?.vocal_regions
                    ?? primaryDiagnostics?.vocalRegions,
            }),
        });
    } catch (err) {
        await traceAlignment(traceId, 'alignment_metadata_save_error', { error: String(err) });
        item.status = 'error';
        item.error = 'AI 정렬 신뢰도 메타데이터를 저장하지 못해 LRC 저장을 중단했습니다.';
        console.warn('[AlignQueue] alignment metadata save failed; LRC save stopped:', err);
        return;
    }
    await invoke('save_lrc_file', { audioPath: item.path, content });
    await traceAlignment(traceId, 'saved', {
        outputLrc: content,
        outputLineCount: content.split(/\r?\n/).filter(Boolean).length,
        timingAudit,
        recoverySummary,
    });

    // 라이브러리 카드의 가사 보유/싱크 상태 즉시 갱신
    const song = state.songLibrary.find((s) => s.path === item.path);
    if (song) {
        song.hasLyrics = true; song.has_lyrics = true;
        const syncStatus = finalUnsyncedCount > 0 ? 'unsynced' : 'synced';
        song.lyricSyncStatus = syncStatus; song.lyric_sync_status = syncStatus;
    }

    item.status = 'done';
    item.note = finalUnsyncedCount > 0
        ? `${appliedCount}줄 배치됨 · ${finalUnsyncedCount}줄 미싱크`
        : `${appliedCount}줄 배치됨`;
    if (unavailableEnglishModelIds.length > 0) {
        item.note += ` · 영어 모델 없음 ${unavailableEnglishModelIds.length}줄`;
    }
    if (lyricsSourceAssessment.suspected) {
        item.note += ' · 가사 원문 확인 권장';
        showNotification(
            '정렬 시간 구조는 정상이지만 여러 가사가 음향과 충분히 맞지 않습니다. 가사 원문·발음 표기·곡 버전 또는 정렬 모델 언어가 맞는지 다시 확인해 주세요.',
            'warning',
        );
    }

    // 이 곡이 지금 가사 싱크 에디터에 열려 있으면 결과를 즉시 반영.
    notifyItemComplete(item.path, [...acceptedAcousticLines, ...estimatedLines], savedSegments);
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
