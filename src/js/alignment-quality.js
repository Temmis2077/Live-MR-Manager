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
  return safeLines.map((line, index) => ({
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
  }));
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
    * (Number(line.vocal_activity ?? 1) || 0);
}

// A CTC path can make one lyric consume an instrumental gap. Do not reject a
// genuinely sustained line solely because it is long; only apply this sanity
// check when the acoustic evidence is weak as well. The cap is based on lyric
// units rather than a fixed per-song duration so short English/Korean phrases
// are treated more strictly than long lines.
function durationSanityCapMs(text) {
  const value = String(text || '').trim();
  const compact = value.replace(/\s+/g, '');
  const words = value ? value.split(/\s+/).length : 0;
  const units = Math.max(words, Math.ceil(Array.from(compact).length / 4));
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_SANITY_CAP_MS, units * DURATION_UNIT_MS));
}

function hasWeakDurationEvidence(line, duration) {
  if (duration <= durationSanityCapMs(line?.text)) return false;
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
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) reasons.push('duration');
    if (Number.isFinite(duration) && hasWeakDurationEvidence(line, duration)) reasons.push('duration_sanity');
    if (Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs)
      && (start < windowStartMs - ORDER_TOLERANCE_MS || end > windowEndMs + ORDER_TOLERANCE_MS)) {
      reasons.push('outside_window');
    }
    if (!Number.isFinite(coverage) || coverage < MIN_TOKEN_COVERAGE) reasons.push('token_coverage');
    if (!Number.isFinite(confidence) || confidence < confidenceFloor) reasons.push('confidence');
    // Old backends omit vocal_activity; only evaluate an explicitly supplied value.
    if (line.vocal_activity != null && (!Number.isFinite(activity) || activity < MIN_VOCAL_ACTIVITY)) reasons.push('vocal_silence');
    const confidenceOnly = reasons.length === 1 && reasons[0] === 'confidence';
    const hasCorroboratingTimingEvidence = confidenceOnly
      && line.vocal_activity != null
      && Number.isFinite(coverage) && coverage >= CORROBORATED_MIN_TOKEN_COVERAGE
      && Number.isFinite(activity) && activity >= CORROBORATED_MIN_VOCAL_ACTIVITY
      && Number.isFinite(margin) && margin >= CORROBORATED_MIN_ACOUSTIC_MARGIN;
    let candidate = line;
    let wasSoftAccepted = false;
    if (hasCorroboratingTimingEvidence) {
      reasons.length = 0;
      wasSoftAccepted = true;
      candidate = {
        ...line,
        gate_decision: 'low_confidence_corroborated',
        quality_flags: [...(line.quality_flags || []), 'low_confidence_corroborated'],
      };
    }
    if (reasons.length) {
      rejected.push({ line, reasons });
      continue;
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
  return { accepted, rejected, softAccepted, confidenceFloor };
}
