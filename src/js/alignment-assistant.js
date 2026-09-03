const MIN_TIMING_MS = 80;
const LEXICAL_SUPPORT_FLOOR = 0.45;

function toRegion(region) {
    const startMs = Number(region?.start_ms ?? region?.startMs);
    const endMs = Number(region?.end_ms ?? region?.endMs);
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
        ? { startMs, endMs, activity: Number(region?.activity) || 0 }
        : null;
}

function overlapMs(startMs, endMs, regions) {
    return regions.reduce((sum, region) =>
        sum + Math.max(0, Math.min(endMs, region.endMs) - Math.max(startMs, region.startMs)), 0);
}

function nearestDistanceMs(startMs, endMs, regions) {
    if (!regions.length) return null;
    return Math.min(...regions.map((region) => {
        if (region.endMs < startMs) return startMs - region.endMs;
        if (region.startMs > endMs) return region.startMs - endMs;
        return 0;
    }));
}

function isAutomatic(segment) {
    return segment?.approx === true || ['estimated', 'acoustic_soft', 'acoustic_strong'].includes(segment?.alignmentTrust);
}

function isEstimated(segment) {
    return ['anchor_interpolation', 'vad_ordered_review', 'vad_boundary_review'].includes(segment?.alignmentSource)
        || segment?.alignmentTrust === 'estimated';
}

function hasLexicalSupport(segment) {
    return segment?.alignmentTrust === 'acoustic_strong'
        || (Number.isFinite(Number(segment?.greedyTextSimilarity))
            && Number(segment.greedyTextSimilarity) >= LEXICAL_SUPPORT_FLOOR);
}

function candidateRegionsFor(index, segments, regions) {
    const previous = segments.slice(0, index).reverse().find((item) => Number(item?.end) > Number(item?.start));
    const next = segments.slice(index + 1).find((item) => Number(item?.end) > Number(item?.start));
    const lowerMs = previous ? Math.round(Number(previous.end) * 1000) : 0;
    const upperMs = next ? Math.round(Number(next.start) * 1000) : Number.POSITIVE_INFINITY;
    return regions.filter((region) => {
        if (!(region.startMs >= lowerMs && region.endMs <= upperMs)) return false;
        return !segments.some((item, itemIndex) => {
            if (itemIndex === index) return false;
            const itemStart = Math.round((Number(item?.start) || 0) * 1000);
            const itemEnd = Math.round((Number(item?.end) || 0) * 1000);
            return itemEnd > itemStart
                && Math.min(itemEnd, region.endMs) > Math.max(itemStart, region.startMs);
        });
    });
}

export function assessAlignmentSegments(segments, vocalRegions, audioDurationMs = 0) {
    const regions = (vocalRegions || []).map(toRegion).filter(Boolean)
        .sort((left, right) => left.startMs - right.startMs);
    const sourceUnavailable = regions.length === 0;
    return (segments || []).map((segment, index) => {
        const startMs = Math.round((Number(segment?.start) || 0) * 1000);
        const endMs = Math.round((Number(segment?.end) || 0) * 1000);
        const durationMs = Math.max(0, endMs - startMs);
        const automatic = isAutomatic(segment);
        const estimated = isEstimated(segment);
        const lexicalSupport = hasLexicalSupport(segment);
        const vocalOverlapMs = durationMs > 0 ? overlapMs(startMs, endMs, regions) : 0;
        const vocalOverlapRatio = durationMs > 0 ? vocalOverlapMs / durationMs : 0;
        const reasons = [];
        let status = automatic ? 'assisted' : 'confirmed';

        if (!(durationMs >= MIN_TIMING_MS)) {
            status = 'unsynced_review';
            reasons.push('missing_or_short_timing');
        } else if (audioDurationMs > 0 && (startMs < 0 || endMs > audioDurationMs)) {
            status = 'unsynced_review';
            reasons.push('outside_audio_range');
        } else if (sourceUnavailable && estimated && !lexicalSupport) {
            status = 'source_unavailable';
            reasons.push('no_vocal_regions');
        } else if (automatic && vocalOverlapMs === 0 && !lexicalSupport) {
            status = 'invalid_silence';
            reasons.push('no_vocal_or_lexical_evidence');
        } else if (!automatic && vocalOverlapMs === 0 && regions.length > 0) {
            // 사용자가 확정한 값은 이동하지 않되, 현재 보컬 소스와 충돌한다는
            // 사실은 숨기지 않는다.
            reasons.push('manual_vad_disagreement');
        } else if (estimated || (automatic && !lexicalSupport)) {
            status = 'estimated_review';
            reasons.push(estimated ? 'estimated_timing' : 'weak_lexical_evidence');
        }

        const candidates = status === 'invalid_silence' || reasons.includes('manual_vad_disagreement')
            ? candidateRegionsFor(index, segments, regions)
            : [];
        const suggestedRange = candidates.length === 1
            ? { startMs: candidates[0].startMs, endMs: candidates[0].endMs }
            : null;
        return {
            status,
            reasonCodes: reasons,
            vocalOverlapMs: Math.round(vocalOverlapMs),
            vocalOverlapRatio,
            nearestVocalDistanceMs: nearestDistanceMs(startMs, endMs, regions),
            suggestedRange,
            autoFixSafe: automatic && status === 'invalid_silence' && !!suggestedRange,
        };
    });
}

/** 자동·추정 블록만 교정한다. 수동 블록은 진단만 기록한다. */
export function applyAlignmentAssistant(segments, vocalRegions, audioDurationMs = 0) {
    const assessments = assessAlignmentSegments(segments, vocalRegions, audioDurationMs);
    const changes = [];
    assessments.forEach((assessment, index) => {
        const segment = segments?.[index];
        if (!segment) return;
        segment.syncAssistant = assessment;
        if (!isAutomatic(segment)) return;
        if (assessment.autoFixSafe) {
            const before = { start: segment.start, end: segment.end };
            segment.start = assessment.suggestedRange.startMs / 1000;
            segment.end = assessment.suggestedRange.endMs / 1000;
            segment.alignmentSource = 'vad_boundary_review';
            segment.qualityFlags = [...new Set([...(segment.qualityFlags || []), 'assistant_repositioned', 'review_required'])];
            segment.syncAssistant = {
                ...assessment,
                status: 'estimated_review',
                reasonCodes: ['assistant_repositioned'],
                previousRange: { startMs: Math.round(before.start * 1000), endMs: Math.round(before.end * 1000) },
            };
            changes.push({ index, action: 'repositioned', before, after: { start: segment.start, end: segment.end } });
        } else if (assessment.status === 'invalid_silence' || assessment.status === 'source_unavailable') {
            const before = { start: segment.start, end: segment.end };
            segment.start = 0;
            segment.end = 0;
            segment.approx = true;
            segment.alignmentTrust = 'estimated';
            segment.alignmentSource = 'unsynced_review';
            segment.qualityFlags = [...new Set([
                ...(segment.qualityFlags || []),
                ...assessment.reasonCodes,
                'review_required',
            ])];
            changes.push({ index, action: 'cleared', before, after: { start: 0, end: 0 } });
        }
    });
    return { assessments, changes };
}
