// v2: 줄마다 단어별 타임스탬프(words)를 함께 저장한다.
// v1 사이드카는 words가 없을 뿐 나머지는 같은 뜻이라, 버전이 낮아도 거부하지
// 않고 읽어서 쓴다(거부하면 예전에 정렬한 곡의 신뢰도 정보까지 잃는다).
const ALIGNMENT_METADATA_SCHEMA_VERSION = 2;
const SUPPORTED_METADATA_SCHEMA_VERSIONS = [1, 2];
const TIMING_TOLERANCE_CENTISECONDS = 1;

const METADATA_FIELDS = [
  'approx',
  'alignmentTrust',
  'alignmentSource',
  'gateDecision',
  'confidence',
  'greedyTextSimilarity',
  'lineKind',
  'repeatedLyric',
];

function sourceIdentity(segment) {
  if (segment && Object.prototype.hasOwnProperty.call(segment, 'original')) {
    return [
      String(segment.original || ''),
      String(segment.pronunciation || ''),
      String(segment.translation || ''),
    ];
  }
  return [String(segment?.text || '')];
}

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const character of String(text || '')) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function sourceFingerprint(segments) {
  return fnv1a64(JSON.stringify((segments || []).map(sourceIdentity)));
}

function startCentiseconds(segment) {
  return Math.round((Number(segment?.start) || 0) * 100);
}

/**
 * 단어별 타임스탬프를 저장 가능한 형태로 줄인다.
 *
 * 정렬 모델(Viterbi 백트레이스)이 이미 만들어 주는 값인데 LRC는 줄당
 * 타임스탬프 하나만 담을 수 있어 여태 버려졌다. 이게 있어야 줄 안 진행도를
 * 선형 보간이 아니라 실제 발음 시점으로 그릴 수 있다.
 *
 * 키를 짧게(t/s/e) 쓰는 이유는 한 곡에 단어가 수백 개라 파일이 금세 커지기
 * 때문이다. 시간은 ms 정수로 반올림한다 — 소수점은 의미가 없다.
 */
function copyWordTimings(segment) {
  const words = segment?.words;
  if (!Array.isArray(words) || words.length === 0) return null;
  const out = [];
  for (const w of words) {
    const text = String(w?.word ?? w?.text ?? '').trim();
    const s = Number(w?.startMs ?? w?.start_ms ?? (Number(w?.start) * 1000));
    const e = Number(w?.endMs ?? w?.end_ms ?? (Number(w?.end) * 1000));
    if (!text || !Number.isFinite(s) || !Number.isFinite(e) || e < s) continue;
    out.push({ t: text, s: Math.round(s), e: Math.round(e) });
  }
  return out.length > 0 ? out : null;
}

function copyPersistedMetadata(segment) {
  const metadata = {};
  for (const field of METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(segment || {}, field)) {
      metadata[field] = segment[field];
    }
  }
  if (Array.isArray(segment?.qualityFlags)) {
    metadata.qualityFlags = [...new Set(segment.qualityFlags.map(String))];
  }
  if (segment?.approx === false) {
    metadata.approx = false;
    metadata.alignmentTrust = 'manual';
    metadata.alignmentSource = 'manual';
  }
  return metadata;
}

/**
 * 보컬 활동 구간을 저장 가능한 형태로 줄인다.
 *
 * 정렬이 20ms 프레임 활동도를 구간으로 압축해 이미 만들어 두는 값
 * (AlignmentDiagnostics.vocal_regions)인데, 정렬이 끝나면 버려졌다.
 * 곡 단위 값이라 줄이 아니라 사이드카 최상위에 둔다.
 *
 * 키를 짧게(s/e/a) 쓰는 이유는 줄 단위 words와 같다 — 구간이 수백 개다.
 */
function copyVocalRegions(regions) {
  if (!Array.isArray(regions)) return null;
  const out = [];
  for (const r of regions) {
    const s = Number(r?.start_ms ?? r?.startMs);
    const e = Number(r?.end_ms ?? r?.endMs);
    const a = Number(r?.activity);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    out.push({ s: Math.round(s), e: Math.round(e), a: Number.isFinite(a) ? Number(a.toFixed(3)) : 0 });
  }
  return out.length > 0 ? out : null;
}

/**
 * Build a sidecar that preserves timing provenance without modifying LRC text.
 *
 * @param {Array} segments 줄 목록
 * @param {object} [extras] 곡 단위 파생 데이터. `vocalRegions`를 받는다.
 */
export function buildAlignmentMetadata(segments, extras = {}) {
  const values = segments || [];
  const vocalRegions = copyVocalRegions(extras?.vocalRegions);
  return {
    schemaVersion: ALIGNMENT_METADATA_SCHEMA_VERSION,
    sourceFingerprint: sourceFingerprint(values),
    segmentCount: values.length,
    // 곡 단위 — 줄과 무관하므로 sourceFingerprint 검사에 걸리지 않는다.
    // 가사를 고쳐 줄이 바뀌어도 오디오가 그대로면 이 값은 유효하다.
    ...(vocalRegions ? { vocalRegions } : {}),
    segments: values.map((segment, index) => ({
      id: `segment:${index}`,
      sourceKey: fnv1a64(JSON.stringify(sourceIdentity(segment))),
      startCentiseconds: startCentiseconds(segment),
      metadata: copyPersistedMetadata(segment),
      // 단어 타임은 metadata와 성격이 달라 따로 둔다 — metadata는 사람이 고친
      // 흔적(provenance)이고, 이건 모델이 낸 파생 데이터다.
      words: copyWordTimings(segment),
    })),
  };
}

/**
 * Restore only provenance fields. Text and timing always remain owned by the LRC.
 * A changed source/order rejects the whole sidecar; a changed timestamp skips only
 * that line so an external edit is conservatively treated as manual.
 */
export function applyAlignmentMetadata(segments, sidecar) {
  const restored = (segments || []).map((segment) => ({ ...segment }));
  if (!sidecar || !SUPPORTED_METADATA_SCHEMA_VERSIONS.includes(sidecar.schemaVersion)) {
    return { segments: restored, appliedCount: 0, skippedCount: 0, reason: 'missing_or_unsupported' };
  }
  if (sidecar.segmentCount !== restored.length
      || sidecar.sourceFingerprint !== sourceFingerprint(restored)
      || !Array.isArray(sidecar.segments)) {
    return { segments: restored, appliedCount: 0, skippedCount: restored.length, reason: 'source_mismatch' };
  }

  let appliedCount = 0;
  let skippedCount = 0;
  sidecar.segments.forEach((entry, index) => {
    const segment = restored[index];
    const expectedId = `segment:${index}`;
    const sourceKey = fnv1a64(JSON.stringify(sourceIdentity(segment)));
    const timestampMatches = Math.abs(Number(entry?.startCentiseconds) - startCentiseconds(segment))
      <= TIMING_TOLERANCE_CENTISECONDS;
    if (!segment || entry?.id !== expectedId || entry?.sourceKey !== sourceKey || !timestampMatches) {
      skippedCount++;
      return;
    }
    const metadata = entry?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      skippedCount++;
      return;
    }
    for (const field of METADATA_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(metadata, field)) segment[field] = metadata[field];
    }
    if (Array.isArray(metadata.qualityFlags)) segment.qualityFlags = [...metadata.qualityFlags];
    // 단어 타임 복원 — 줄 안 진행도(가라오케 와이프)가 쓴다. v1 사이드카에는
    // 없으므로 있을 때만 붙인다.
    if (Array.isArray(entry.words) && entry.words.length > 0) {
      segment.words = entry.words.map((w) => ({
        word: String(w?.t ?? ''),
        startMs: Number(w?.s) || 0,
        endMs: Number(w?.e) || 0,
      }));
    }
    appliedCount++;
  });
  return { segments: restored, appliedCount, skippedCount, reason: skippedCount ? 'partial' : 'applied' };
}

/**
 * 한 줄 안에서 지금 어디까지 불렀는지 0~1로.
 *
 * 단어 타임이 있으면 그걸 쓰고, 없으면 줄 start/end 선형 보간으로 물러난다.
 * 없다고 아무것도 안 그리면 예전보다 나빠진다 — 예전에 정렬한 곡, 손으로 쓴
 * LRC, 다른 앱에서 가져온 가사가 전부 그쪽이다.
 *
 * 단어 사이 빈 구간(숨 쉬는 자리)에서는 직전 단어 끝에 머문다. 그 사이를
 * 이어서 채우면 아직 부르지 않은 글자가 미리 칠해진다.
 *
 * @param {object} segment  start/end(초)와 선택적 words(ms)를 가진 줄
 * @param {number} positionMs 현재 재생 위치(ms)
 * @returns {number} 0~1
 */
export function readVocalRegions(sidecar) {
  const raw = sidecar?.vocalRegions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({ startMs: Number(r?.s) || 0, endMs: Number(r?.e) || 0, activity: Number(r?.a) || 0 }))
    .filter((r) => r.endMs > r.startMs);
}

/**
 * 주어진 시각 근처의 보컬 시작·끝 지점 중 가장 가까운 것을 찾는다.
 *
 * 편집기에서 경계를 끌 때 "노래가 실제로 시작하는 자리"에 붙이는 데 쓴다.
 * 지금은 ms를 눈과 손으로 맞춰야 한다.
 *
 * @param {Array} regions readVocalRegions() 결과
 * @param {number} timeMs 기준 시각
 * @param {number} toleranceMs 이 안에 후보가 없으면 스냅하지 않는다
 * @returns {number|null} 붙일 시각(ms). 없으면 null — 호출부는 원래 값을 쓴다.
 */
export function snapToVocalEdge(regions, timeMs, toleranceMs = 120) {
  if (!Array.isArray(regions) || regions.length === 0) return null;
  if (!Number.isFinite(timeMs)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const r of regions) {
    for (const edge of [r.startMs, r.endMs]) {
      const d = Math.abs(edge - timeMs);
      if (d < bestDist) { bestDist = d; best = edge; }
    }
  }
  return bestDist <= toleranceMs ? best : null;
}

export function lineProgress(segment, positionMs) {
  if (!segment) return 0;
  const pos = Number(positionMs);
  if (!Number.isFinite(pos)) return 0;

  const startMs = (Number(segment.start) || 0) * 1000;
  const endMs = (Number(segment.end) || 0) * 1000;

  if (pos <= startMs) return 0;
  if (endMs > startMs && pos >= endMs) return 1;

  const words = Array.isArray(segment.words) ? segment.words : null;
  if (words && words.length > 0) {
    // 글자 수로 가중치를 준다 — 단어 개수로 나누면 긴 단어가 순식간에 칠해진다.
    const lens = words.map((w) => Math.max(1, String(w.word || '').length));
    const total = lens.reduce((a, b) => a + b, 0);
    let done = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const ws = Number(w.startMs) || 0;
      const we = Number(w.endMs) || 0;
      if (pos >= we) { done += lens[i]; continue; }
      if (pos <= ws) break;               // 단어 사이 빈 구간 — 여기서 멈춘다
      const span = we - ws;
      if (span > 0) done += lens[i] * ((pos - ws) / span);
      break;
    }
    return Math.max(0, Math.min(1, done / total));
  }

  if (endMs > startMs) return Math.max(0, Math.min(1, (pos - startMs) / (endMs - startMs)));
  return 0;
}

export { ALIGNMENT_METADATA_SCHEMA_VERSION, SUPPORTED_METADATA_SCHEMA_VERSIONS };
