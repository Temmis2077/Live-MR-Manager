/**
 * Alignment request identity and conservative acceptance policy.
 *
 * These helpers deliberately never modify lyric text or segment order. A
 * rejected result simply remains unsynced, which is safer than inventing a
 * timestamp that can pull every following lyric out of place.
 */
import { getSyncText, isStructureDirective } from './lrc-parser.js';

// Singing CTC posterior scores are commonly much lower than speech scores.
// The relative per-song floor remains the main guard; this only rejects lines
// with effectively no acoustic support.
const ABSOLUTE_CONFIDENCE_FLOOR = 0.005;
const MIN_TOKEN_COVERAGE = 0.75;
const MIN_VOCAL_ACTIVITY = 0.02;
const MIN_DURATION_MS = 80;
const MAX_DURATION_MS = 15_000;
const DURATION_UNIT_MS = 1_800;
const MIN_DURATION_SANITY_CAP_MS = 4_000;
const WEAK_DURATION_CONFIDENCE = 0.12;
const WEAK_DURATION_MARGIN = 0.30;
const ORDER_TOLERANCE_MS = 80;
// Forced alignment의 절대 posterior는 노래 후렴·고음에서 매우 낮아질 수 있다.
// 시간/보컬/토큰 증거가 모두 정상인 줄을 confidence 하나로 버리지 않는다.
const CORROBORATED_MIN_TOKEN_COVERAGE = 0.95;
const CORROBORATED_MIN_VOCAL_ACTIVITY = 0.25;
const CORROBORATED_MIN_ACOUSTIC_MARGIN = 0.08;
// High vocal energy with a near-zero posterior is not independent support for
// the lyric identity. It commonly appears with doubled vocals/repeated hooks.
const DOUBLING_AMBIGUITY_MAX_CONFIDENCE = 0.001;
const DOUBLING_AMBIGUITY_MIN_VOCAL_ACTIVITY = 0.75;
const LEXICAL_MISMATCH_SIMILARITY = 0.15;
const SOFT_ACCEPT_MIN_SIMILARITY = 0.15;
const VOCABLE_MIN_SIMILARITY = 0.50;
const NON_LEXICAL_REGION_MIN_ACTIVITY = 0.25;
const VOCABLE_MAX_DURATION_MS = 8_000;

const VOCABLE_TOKENS = new Set([
  'ah', 'oh', 'ooh', 'uh', 'um', 'mm', 'hmm', 'hey', 'yeah', 'yo', 'woo', 'woah',
  '아', '아아', '어', '어어', '오', '오오', '우', '우우', '음', '흠', '예', '야', '헤이', '워',
]);

function normalizedLineTokens(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Explicit short non-lexical lines only. Ordinary written onomatopoeia such
 * as 빵빵/쿵쿵 remains a normal lyric and uses the regular lexical gate. */
export function classifyAlignmentLine(text) {
  const tokens = normalizedLineTokens(text);
  const compact = tokens.join('');
  if (!tokens.length || Array.from(compact).length > 12) return 'lyric';
  const listed = tokens.every((token) => VOCABLE_TOKENS.has(token));
  const repeatedUnit = tokens.length === 1
    && /^([아어오우음흠워aeiouhmw])\1+$/u.test(compact)
    && Array.from(compact).length >= 2;
  return listed || repeatedUnit ? 'vocable' : 'lyric';
}

function normalizedAlignmentCharacters(text) {
  return Array.from(String(text || '').normalize('NFD').toLowerCase())
    .filter((char) => /[\p{L}\p{N}]/u.test(char));
}

/** JS compatibility implementation of the Rust NFD Levenshtein metric. */
export function alignmentTextSimilarity(target, extracted) {
  const left = normalizedAlignmentCharacters(target);
  const right = normalizedAlignmentCharacters(extracted);
  const denominator = Math.max(left.length, right.length);
  if (denominator === 0) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  left.forEach((leftChar, leftIndex) => {
    const current = new Array(right.length + 1).fill(0);
    current[0] = leftIndex + 1;
    right.forEach((rightChar, rightIndex) => {
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (leftChar === rightChar ? 0 : 1),
      );
    });
    previous = current;
  });
  return Math.max(0, Math.min(1, 1 - previous[right.length] / denominator));
}

export function segmentId(index) {
  return `segment:${index}`;
}

export function segmentIndexFromId(id) {
  const match = /^segment:(\d+)$/.exec(String(id || ''));
  return match ? Number(match[1]) : null;
}

/** Builds the only mapping used for a forced-alignment request. */
export function buildAlignmentEntries(segments) {
  const entries = [];
  for (let segmentIndex = 0; segmentIndex < (segments || []).length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const text = getSyncText(segment).trim();
    if (!text || isStructureDirective(text)) continue;
    entries.push({
      id: segmentId(segmentIndex),
      segmentIndex,
      text,
      lineKind: classifyAlignmentLine(text),
      isSynced: !(segment.start === 0 && segment.end === 0),
    });
  }
  return entries;
}

/** Backward compatibility for cached/older backend results that predate IDs. */
export function attachMissingSegmentIds(lines, entries) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const safeEntries = Array.isArray(entries) ? entries : [];
  // Positional recovery is safe only when the backend returned one row for
  // every requested line. With blank placeholders or untokenizable lines the
  // lengths can differ; assigning by result index would then attach a later
  // lyric to the wrong original segment.
  const canUsePosition = safeLines.length === safeEntries.length;
  return safeLines.map((line, index) => {
    const derivedSimilarity = typeof line?.greedy_text_similarity === 'number'
      ? line.greedy_text_similarity
      : (line?.text != null && line?.extracted_text != null
        ? alignmentTextSimilarity(line.text, line.extracted_text)
        : undefined);
    return {
      ...line,
      segment_id: line?.segment_id
        || (Number.isInteger(line?.input_index) ? safeEntries[line.input_index]?.id : '')
        || (canUsePosition ? safeEntries[index]?.id : '')
        || '',
      // Older desktop backends did not expose these quality fields. Keep their
      // historical successful path usable while new results are gated strictly.
      confidence: typeof line?.confidence === 'number' ? line.confidence : 1,
      emission_confidence: typeof line?.emission_confidence === 'number'
        ? line.emission_confidence : (typeof line?.confidence === 'number' ? line.confidence : 1),
      acoustic_margin: typeof line?.acoustic_margin === 'number' ? line.acoustic_margin : 1,
      token_coverage: typeof line?.token_coverage === 'number' ? line.token_coverage : 1,
      greedy_text_similarity: derivedSimilarity,
    };
  });
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function lineScore(line) {
  return (Number(line.confidence) || 0)
    * (Number(line.acoustic_margin ?? 1) || 0)
    * (Number(line.token_coverage ?? 1) || 0)
    * (Number(line.vocal_activity ?? 1) || 0)
    * (Number(line.greedy_text_similarity ?? 1) || 0);
}

function mergeNonLexicalVocalRegions(rejected) {
  const raw = (rejected || []).map(({ line, reasons }) => {
    const startMs = Number(line?.start_ms);
    const endMs = Number(line?.end_ms);
    const activity = Number(line?.vocal_activity);
    // 일반 가사의 ASR 문자 불일치는 모델 인식 실패일 수 있으며 추임새라는
    // 증거가 아니다. 명시적 vocable이 실제 소리와도 불일치할 때만 차단한다.
    if (line?.line_kind !== 'vocable' || !(reasons || []).includes('vocable_mismatch')
      || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
      || !Number.isFinite(activity) || activity < NON_LEXICAL_REGION_MIN_ACTIVITY) return null;
    return {
      startMs,
      endMs,
      activity,
      segmentIds: [line.segment_id].filter(Boolean),
      reason: 'non_lexical_vocal_region',
    };
  }).filter(Boolean).sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const region of raw) {
    const previous = merged.at(-1);
    if (previous && region.startMs - previous.endMs <= 200) {
      previous.endMs = Math.max(previous.endMs, region.endMs);
      previous.activity = Math.max(previous.activity, region.activity);
      previous.segmentIds.push(...region.segmentIds);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

// A CTC path can make one lyric consume an instrumental gap. Do not reject a
// genuinely sustained line solely because it is long; only apply this sanity
// check when the acoustic evidence is weak as well. The cap is based on lyric
// units rather than a fixed per-song duration so short English/Korean phrases
// are treated more strictly than long lines.
function durationSanityCapMs(text, lineKind = 'lyric') {
  if (lineKind === 'vocable') return VOCABLE_MAX_DURATION_MS;
  const value = String(text || '').trim();
  const compact = value.replace(/\s+/g, '');
  const words = value ? value.split(/\s+/).length : 0;
  const units = Math.max(words, Math.ceil(Array.from(compact).length / 4));
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_SANITY_CAP_MS, units * DURATION_UNIT_MS));
}

function hasWeakDurationEvidence(line, duration, lineKind = 'lyric') {
  if (duration <= durationSanityCapMs(line?.text, lineKind)) return false;
  const confidence = Number(line?.confidence ?? 0);
  const margin = Number(line?.acoustic_margin ?? 1);
  return !Number.isFinite(confidence) || !Number.isFinite(margin)
    || confidence < WEAK_DURATION_CONFIDENCE
    || margin < WEAK_DURATION_MARGIN;
}

/**
 * Returns only acoustic results safe to save. `rejected` is retained for UI
 * diagnostics but must never be converted into a guessed timestamp.
 */
export function gateAlignmentLines(lines, entries, {
  windowStartMs = null,
  windowEndMs = null,
  confidenceScale = 0.60,
} = {}) {
  const entryOrder = new Map((entries || []).map((entry, index) => [entry.id, index]));
  const entryById = new Map((entries || []).map((entry) => [entry.id, entry]));
  const allowedIds = new Set(entryOrder.keys());
  // The request's segment order is authoritative. A backend result array is
  // not allowed to reorder repeated lyrics or influence the chronology gate.
  const candidates = (lines || [])
    .filter((line) => allowedIds.has(line.segment_id))
    .sort((a, b) => entryOrder.get(a.segment_id) - entryOrder.get(b.segment_id));
  const confidenceValues = candidates
    .map((line) => Number(line.confidence))
    .filter((value) => Number.isFinite(value) && value > 0);
  // Per-song/model relative threshold, bounded by an absolute floor/ceiling.
  const relativeFloor = Math.min(0.16, percentile(confidenceValues, 0.20) * confidenceScale);
  const confidenceFloor = Math.max(ABSOLUTE_CONFIDENCE_FLOOR, relativeFloor);
  const accepted = [];
  const rejected = [];
  const softAccepted = [];
  const acceptedIds = new Set();

  for (const line of candidates) {
    const reasons = [];
    if (acceptedIds.has(line.segment_id)) reasons.push('duplicate_id');
    const start = Number(line.start_ms);
    const end = Number(line.end_ms);
    const duration = end - start;
    const coverage = Number(line.token_coverage ?? 1);
    const activity = Number(line.vocal_activity ?? 1);
    const confidence = Number(line.confidence ?? 0);
    const margin = Number(line.acoustic_margin ?? 1);
    const entry = entryById.get(line.segment_id);
    const lineKind = entry?.lineKind || classifyAlignmentLine(entry?.text || line.text);
    const hasLexicalEvidence = typeof line.greedy_text_similarity === 'number'
      && Number.isFinite(line.greedy_text_similarity);
    const lexicalSimilarity = hasLexicalEvidence ? Number(line.greedy_text_similarity) : null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) reasons.push('duration');
    if (Number.isFinite(duration) && hasWeakDurationEvidence(line, duration, lineKind)) reasons.push('duration_sanity');
    if (Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs)
      && (start < windowStartMs - ORDER_TOLERANCE_MS || end > windowEndMs + ORDER_TOLERANCE_MS)) {
      reasons.push('outside_window');
    }
    if (!Number.isFinite(coverage) || coverage < MIN_TOKEN_COVERAGE) reasons.push('token_coverage');
    if (!Number.isFinite(confidence) || confidence < confidenceFloor) reasons.push('confidence');
    // Old backends omit vocal_activity; only evaluate an explicitly supplied value.
    if (line.vocal_activity != null && (!Number.isFinite(activity) || activity < MIN_VOCAL_ACTIVITY)) reasons.push('vocal_silence');
    if (hasLexicalEvidence && lineKind === 'lyric' && lexicalSimilarity < LEXICAL_MISMATCH_SIMILARITY) {
      reasons.push('lexical_mismatch');
    }
    if (hasLexicalEvidence && lineKind === 'vocable' && lexicalSimilarity < VOCABLE_MIN_SIMILARITY) {
      reasons.push('vocable_mismatch');
    }
    const confidenceOnly = reasons.length === 1 && reasons[0] === 'confidence';
    const hasRegularLexicalEvidence = lineKind === 'lyric'
      && hasLexicalEvidence && lexicalSimilarity >= SOFT_ACCEPT_MIN_SIMILARITY;
    const hasVocableLexicalEvidence = lineKind === 'vocable'
      && hasLexicalEvidence && lexicalSimilarity >= VOCABLE_MIN_SIMILARITY;
    const hasCorroboratingTimingEvidence = confidenceOnly
      && line.vocal_activity != null
      && Number.isFinite(coverage) && coverage >= CORROBORATED_MIN_TOKEN_COVERAGE
      && Number.isFinite(activity) && activity >= CORROBORATED_MIN_VOCAL_ACTIVITY
      && Number.isFinite(margin) && margin >= CORROBORATED_MIN_ACOUSTIC_MARGIN
      && hasRegularLexicalEvidence;
    const hasVocableSoftEvidence = confidenceOnly
      && line.vocal_activity != null
      && Number.isFinite(coverage) && coverage >= MIN_TOKEN_COVERAGE
      && Number.isFinite(activity) && activity >= MIN_VOCAL_ACTIVITY
      && hasVocableLexicalEvidence;
    let candidate = { ...line, line_kind: lineKind };
    let wasSoftAccepted = false;
    if (hasCorroboratingTimingEvidence || hasVocableSoftEvidence) {
      reasons.length = 0;
      wasSoftAccepted = true;
      const doublingAmbiguity = confidence <= DOUBLING_AMBIGUITY_MAX_CONFIDENCE
        && activity >= DOUBLING_AMBIGUITY_MIN_VOCAL_ACTIVITY;
      candidate = {
        ...line,
        line_kind: lineKind,
        gate_decision: 'low_confidence_corroborated',
        alignment_trust: 'acoustic_soft',
        repeated_lyric: entryById.get(line.segment_id)?.repeatedLyric === true,
        quality_flags: [
          ...(line.quality_flags || []),
          'low_confidence_corroborated',
          ...(lineKind === 'vocable' ? ['explicit_vocable'] : []),
          ...(doublingAmbiguity ? ['doubling_ambiguity'] : []),
        ],
      };
    }
    if (reasons.length) {
      rejected.push({
        line: {
          ...line,
          line_kind: lineKind,
          quality_flags: [
            ...(line.quality_flags || []),
            ...(reasons.includes('lexical_mismatch') ? ['lexical_uncertain'] : []),
            ...(reasons.includes('vocable_mismatch') ? ['non_lexical_vocal_risk'] : []),
          ],
        },
        reasons,
      });
      continue;
    }

    if (!wasSoftAccepted) {
      const legacyNoLexicalEvidence = !hasLexicalEvidence;
      candidate = {
        ...candidate,
        gate_decision: line.gate_decision || 'accepted',
        alignment_trust: legacyNoLexicalEvidence ? 'acoustic_soft' : 'acoustic_strong',
        repeated_lyric: entryById.get(line.segment_id)?.repeatedLyric === true,
        quality_flags: [
          ...(line.quality_flags || []),
          ...(legacyNoLexicalEvidence ? ['legacy_no_lexical_evidence'] : []),
          ...(lineKind === 'vocable' ? ['explicit_vocable'] : []),
        ],
      };
      wasSoftAccepted = legacyNoLexicalEvidence;
    }

    // A stronger current line may displace more than one weaker reversed
    // predecessor. Re-check against the whole accepted stack; comparing only
    // once can leave [10s, 5s] in the final accepted list after popping 30s.
    let keepCurrent = true;
    while (accepted.length > 0) {
      const previous = accepted.at(-1);
      if (start >= Number(previous.start_ms) - ORDER_TOLERANCE_MS) break;
      if (lineScore(candidate) > lineScore(previous)) {
        accepted.pop();
        acceptedIds.delete(previous.segment_id);
        rejected.push({ line: previous, reasons: ['out_of_order'] });
      } else {
        rejected.push({ line: candidate, reasons: ['out_of_order'] });
        keepCurrent = false;
        break;
      }
    }
    if (!keepCurrent) continue;
    accepted.push(candidate);
    acceptedIds.add(candidate.segment_id);
    if (wasSoftAccepted) softAccepted.push(candidate);
  }
  return {
    accepted,
    rejected,
    softAccepted,
    confidenceFloor,
    nonLexicalVocalRegions: mergeNonLexicalVocalRegions(rejected),
  };
}
