/**
 * lrc-parser.js - Pure LRC parsing (no Tauri dependency)
 */

// Standalone time-region markers (vocal start point, instrumental interlude
// bounds). Unlike section tags these don't own a lyric line, so they're
// encoded as their own marker-only lines, e.g. `[00:12.34][vocalstart]`, and
// parsed separately from `parseLrc()`'s segment list via `parseMarkers()`.
const MARKER_TAGS = ['vocalstart', 'ilstart', 'ilend'];
const markerAlternation = MARKER_TAGS.join('|');
const markerLineRegex = new RegExp(`^\\[(\\d{2}):(\\d{2}\\.\\d{2,3})\\]\\[(${markerAlternation})\\]\\s*$`);
const markerOnlyRegex = new RegExp(`^\\[(${markerAlternation})\\]\\s*$`);

function isMarkerOnlyLine(timeStrippedRest) {
  return markerOnlyRegex.test(timeStrippedRest.trim());
}

/**
 * Extracts the vocal-start anchor and instrumental-interlude regions from
 * raw LRC text. Returns `{ vocalStartSec: number|null, interludes: {start,end}[] }`.
 * `ilstart`/`ilend` markers are paired in chronological order; an unpaired
 * trailing `ilstart` (e.g. file edited by hand) is dropped rather than
 * producing a broken open-ended region.
 */
export function parseMarkers(lrcContent) {
  const result = { vocalStartSec: null, interludes: [] };
  if (!lrcContent) return result;

  const lines = lrcContent.replace(/\r\n/g, '\n').split('\n');
  const ilStarts = [];
  const ilEnds = [];

  lines.forEach((line) => {
    const match = markerLineRegex.exec(line.trim());
    if (!match) return;
    const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
    const tag = match[3];
    if (tag === 'vocalstart') {
      result.vocalStartSec = time;
    } else if (tag === 'ilstart') {
      ilStarts.push(time);
    } else if (tag === 'ilend') {
      ilEnds.push(time);
    }
  });

  ilStarts.sort((a, b) => a - b);
  ilEnds.sort((a, b) => a - b);
  const pairCount = Math.min(ilStarts.length, ilEnds.length);
  for (let i = 0; i < pairCount; i++) {
    if (ilEnds[i] > ilStarts[i]) {
      result.interludes.push({ start: ilStarts[i], end: ilEnds[i] });
    }
  }
  return result;
}

export function formatMarkerLine(sec, tag) {
  const min = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `[${min}:${s}][${tag}]`;
}

/**
 * 마커 시간 입력 파싱 — 사용자가 마커 목록에서 직접 시각을 고칠 때 사용.
 * `mm:ss`, `mm:ss.xx`, 초 단독("83", "83.5") 모두 허용. 무효 입력은 null.
 */
export function parseTimeInput(str) {
  const t = (str || '').trim();
  if (!t) return null;
  const colon = /^(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(t);
  if (colon) {
    const sec = Number(colon[2]);
    if (sec >= 60) return null;
    return Number(colon[1]) * 60 + sec;
  }
  const plain = /^\d+(?:\.\d{1,3})?$/.exec(t);
  if (plain) return Number(t);
  return null;
}

/** 한 줄이 한글 위주인지 — 3줄(원문/차음/번역) 그룹핑에서 차음/번역 줄 판별용.
 *  한글 음절/자모 수가 그 외 스크립트 글자(가나·한자·라틴 등) 수보다 많으면 true. */
export function isHangulDominant(text) {
  let hangul = 0;
  let other = 0;
  for (const c of text || '') {
    const cp = c.codePointAt(0);
    if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x3131 && cp <= 0x318e)) hangul++;
    else if (/\p{L}/u.test(c)) other++;
  }
  return hangul > 0 && hangul >= other;
}

/**
 * 3줄(원문/차음/번역) 모드 가사 그룹핑 — 스크립트 인식.
 *
 * 단순히 3줄씩 자르면 일본어 곡에 영어 소절이 섞였을 때(영어는 차음/번역
 * 없이 원문 1줄만 있는 경우가 많음) 그 뒤 모든 그룹이 밀린다. 대신:
 * 비(非)한글 줄을 원문으로 시작하고, 바로 뒤따르는 한글 위주 줄을 차음,
 * 그 다음 한글 위주 줄을 번역으로 붙인다. 뒤에 한글 줄이 없으면 원문
 * 1줄짜리 그룹(영어 소절 등)으로 처리한다.
 *
 * @param lines 공백 줄이 제거된 가사 줄 배열
 * @returns [{original, pronunciation, translation, text}] (start/end 없음)
 */
export function groupTripletLines(lines) {
  const cues = [];
  let i = 0;
  const arr = lines || [];
  while (i < arr.length) {
    const original = arr[i++];
    let pronunciation = '';
    let translation = '';
    if (!isHangulDominant(original)) {
      if (i < arr.length && isHangulDominant(arr[i])) {
        pronunciation = arr[i++];
        if (i < arr.length && isHangulDominant(arr[i])) {
          translation = arr[i++];
        }
      }
    }
    if (pronunciation) {
      cues.push({ text: original, original, pronunciation, translation });
    } else {
      // 차음이 없는 줄(영어 소절, 순한글 줄 등)은 일반 줄로 —
      // 트리플렛로 만들면 싱크 기준(차음)이 비어 정렬/탭에서 빠진다.
      cues.push({ text: original });
    }
  }
  return cues;
}

/** 마커 시간 표시 포맷 — `mm:ss.xx` (parseTimeInput과 라운드트립). */
export function formatTimeInput(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const min = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${min}:${s}`;
}

function normalizeLyricText(text = '') {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Triplet cues (\uC6D0\uBB38/\uCC28\uC74C/\uBC88\uC5ED \u2014 original/pronunciation/translation), used for
// e.g. Japanese lyrics where one sung moment needs three lines: the original
// script, a Hangul phonetic reading, and a Korean translation. Unlike section
// tags these three lines share ONE timestamp and collapse into a single
// segment. Encoded as three consecutive tagged lines:
//   [00:12.34][orig]<original>
//   [00:12.34][pron]<pronunciation>
//   [00:12.34][tran]<translation>
// Grouping keys off seeing `orig` (always starts a new cue) rather than
// timestamp equality, since unsynced cues all sit at `00:00.00` and would
// otherwise collide into one group.
const TRIPLET_FIELD_BY_TAG = { orig: 'original', pron: 'pronunciation', tran: 'translation' };
const tripletTagRegex = /^\[(orig|pron|tran)\]([\s\S]*)$/;

export function isTriplet(seg) {
  return !!(seg && (seg.original !== undefined || seg.pronunciation !== undefined || seg.translation !== undefined));
}

/** The text sync tools (tap/grid/AI-align) should match against \u2014 pronunciation for
 * triplet cues (closest to the actual sung audio), plain `text` otherwise. */
export function getSyncText(seg) {
  if (!seg) return '';
  return isTriplet(seg) ? (seg.pronunciation || '') : (seg.text || '');
}

// Per-surface triplet line visibility. 'app' covers the sync editor preview
// + the in-app lyric drawer; 'overlay' covers the OBS-facing overlay only —
// letting users show e.g. only 차음 on stream while keeping 원문+차음 in-app,
// or any other combination of 원문/차음/번역 per surface.
const LINE_VISIBILITY_KEY_PREFIX = 'lyricsLineVisibility_';
const DEFAULT_LINE_VISIBILITY = { original: true, pronunciation: true, translation: false };

export function getLineVisibility(scope = 'app') {
  const raw = localStorage.getItem(LINE_VISIBILITY_KEY_PREFIX + scope);
  if (!raw) return { ...DEFAULT_LINE_VISIBILITY };
  try {
    return { ...DEFAULT_LINE_VISIBILITY, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_LINE_VISIBILITY };
  }
}

export function setLineVisibility(scope, key, value) {
  const current = getLineVisibility(scope);
  current[key] = value;
  localStorage.setItem(LINE_VISIBILITY_KEY_PREFIX + scope, JSON.stringify(current));
}

/** Back-compat helpers for the sync editor's single "번역 보기" quick toggle —
 * scoped to 'app' since that toggle only ever affected the in-app preview. */
export function getShowTranslation(scope = 'app') {
  return getLineVisibility(scope).translation;
}

export function setShowTranslation(show, scope = 'app') {
  setLineVisibility(scope, 'translation', show);
}

/** Builds the display lines for a segment per-surface visibility settings.
 * Plain (non-triplet) segments always just return their `text`. If a triplet
 * cue's visible set is empty (user turned everything off for this surface),
 * falls back to the pronunciation line (or whatever's available) rather than
 * rendering nothing. */
export function getDisplayLines(seg, scope = 'app') {
  if (!isTriplet(seg)) return [seg?.text || ''];
  const vis = getLineVisibility(scope);
  const lines = [];
  if (vis.original && seg.original) lines.push(seg.original);
  if (vis.pronunciation && seg.pronunciation) lines.push(seg.pronunciation);
  if (vis.translation && seg.translation) lines.push(seg.translation);
  if (lines.length === 0) {
    const fallback = seg.pronunciation || seg.original || seg.translation || '';
    if (fallback) lines.push(fallback);
  }
  return lines;
}

/**
 * 정렬된 세그먼트로부터 "노래 시작(보컬 시작)" 후보 시각을 계산한다.
 * MV 인트로(영상/대사) 다음에 실제 노래가 시작하는 지점 = 가장 이른 싱크
 * 줄의 시작 시각. 약간의 리드인을 빼고(leadIn), 인트로가 유의미하게 길 때만
 * (minSec 이상) 제안한다. 제안할 값이 없으면 null.
 *  - `minSec`: 이보다 짧은 인트로는 굳이 마커를 만들 필요 없어 무시(기본 3s).
 *  - `leadIn`: 첫 소리 직전 살짝 앞에서 시작하도록 빼는 여유(기본 0.3s).
 */
export function suggestVocalStartFromSegments(segments, { minSec = 3, leadIn = 0.3 } = {}) {
  if (!Array.isArray(segments)) return null;
  let earliest = Infinity;
  for (const s of segments) {
    const start = s && s.start;
    if (typeof start === 'number' && start > 0 && start < earliest) earliest = start;
  }
  if (!Number.isFinite(earliest) || earliest < minSec) return null;
  return Math.max(0, earliest - leadIn);
}

/**
 * 인트로 자동 건너뛰기의 목표 지점을 계산한다.
 *
 * 보컬시작 마커는 "진짜 목소리가 나오는 시작"만 의미한다. 뮤비형 곡은
 * [영상/대사 인트로 → 간주(전주 음악) → 보컬] 구조라서, 보컬 시작으로 바로
 * 점프하면 전주 간주가 잘려 나간다. 그래서 보컬 시작 **이전에 끝나는 간주
 * 구간**([ilstart]/[ilend])이 마킹돼 있으면, 건너뛰기는 그 간주의 시작
 * 지점(= 음악이 시작하는 곳)으로만 이동한다. 그런 간주가 없으면 기존처럼
 * 보컬 시작으로 이동. 마커 자체가 없으면 null(건너뛰기 안 함).
 *
 * @param markers parseMarkers 결과 ({vocalStartSec, interludes})
 * @param toleranceSec 간주 끝이 보컬 시작을 살짝 넘어도 전주로 인정할 여유(기본 1s)
 */
export function getIntroSkipTargetSec(markers, toleranceSec = 1) {
  if (!markers || typeof markers.vocalStartSec !== 'number') return null;
  const vocalStart = markers.vocalStartSec;
  let target = vocalStart;
  (markers.interludes || []).forEach((il) => {
    if (!il || typeof il.start !== 'number' || typeof il.end !== 'number') return;
    // 보컬 시작 이전(허용 오차 내)에 끝나는 간주 = 전주. 가장 이른 시작 채택.
    if (il.start < vocalStart && il.end <= vocalStart + toleranceSec && il.start < target) {
      target = il.start;
    }
  });
  return target;
}

/**
 * Merges AI forced-alignment results into lyric segments. Non-destructive:
 * only segments that are still fully unsynced (start===0 && end===0) are
 * filled in, matched to alignment lines by sync text (차음 for triplets),
 * and marked `approx: true` so the UI can flag them for manual review.
 * Shared by the interactive editor (alignment-viewer.js) and the headless
 * batch queue (alignment-queue.js) — keep both paths on this one function.
 * Returns the number of segments updated.
 */
/**
 * 곡 구조 지시어 — 실제로 불리지 않는 라벨. 백엔드
 * `alignment.rs::is_structure_directive`와 **같은 목록을 유지해야 한다**
 * (아래 normalizeForMatch가 백엔드 clean_lyrics와 같은 결과를 내야 하므로).
 */
const STRUCTURE_DIRECTIVES = new Set([
  'verse', 'chorus', 'pre-chorus', 'prechorus', 'post-chorus', 'postchorus',
  'bridge', 'intro', 'outro', 'hook', 'refrain', 'interlude', 'instrumental',
  'ad-lib', 'adlib', 'rap', 'spoken', 'guitar solo', 'solo', 'drop',
  'build-up', 'buildup', 'breakdown', 'fade out', 'fade in', 'repeat',
  '인트로', '벌스', '후렴', '브릿지', '간주', '아웃트로', '랩', '훅',
  '프리코러스', '포스트코러스', '코러스', '절', '다리', '전주', '후주',
  '애드립', '간주중', '반복',
]);

function isStructureDirective(inner) {
  // 뒤에 붙는 숫자/공백 허용("verse 2", "후렴 1") — 백엔드와 동일 규칙.
  const base = (inner || '').trim().toLowerCase().replace(/[\s\d]+$/, '');
  return STRUCTURE_DIRECTIVES.has(base);
}

/**
 * 정렬 결과 매칭용 텍스트 정규화.
 *
 * 백엔드(alignment.rs::clean_lyrics)는 정렬 전 가사에서 `?!.,-+_~` 등을 공백으로
 * 치환하고, 토크나이저는 따옴표("")·특수기호도 걷어낸다. 그래서 백엔드가
 * 돌려주는 줄 텍스트는 원본 LRC 세그먼트 텍스트와 문장부호가 달라, 예전엔
 * 문장부호가 든 줄(따옴표로 감싼 줄, `don't`, `baby,`, `faith-departed` 등)이
 * 정확히 일치하지 않아 정렬이 병합되지 않았다. 양쪽을 같은 규칙으로 정규화해
 * 비교한다: 소문자화 → 괄호 처리 → 글자/숫자 외 문자를 공백으로 → 공백 정리.
 *
 * **괄호 처리는 백엔드 clean_lyrics와 반드시 일치해야 한다.** 곡 구조
 * 지시어([Chorus]/(Intro))만 통째로 지우고, 그 외 괄호(실제로 불리는 코러스
 * 가사 — "God mercy (God mercy on this ground)")는 표시만 벗기고 안의 텍스트를
 * 남긴다. 예전엔 여기서 괄호 내용을 무조건 지웠는데, 백엔드가 내용을 남기도록
 * 바뀌면서 양쪽 키가 어긋나 그런 줄이 아예 배치되지 않았다.
 */
function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[[({<]([^[\](){}<>]*)[\])}>]/g, (_m, inner) =>
      isStructureDirective(inner) ? ' ' : ` ${inner} `)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')      // 글자·숫자 외(문장부호·따옴표·기호) → 공백
    .trim()
    .replace(/\s+/g, ' ');
}

export function mergeAlignmentResult(segments, lines) {
  if (!Array.isArray(segments) || !Array.isArray(lines) || lines.length === 0) return 0;
  const used = new Array(lines.length).fill(false);
  const lineKeys = lines.map((l) => normalizeForMatch(l.text));
  let appliedCount = 0;
  segments.forEach((seg) => {
    if (!(seg.start === 0 && seg.end === 0)) return; // 이미 싱크된 줄은 보존
    const text = getSyncText(seg).trim();
    if (!text) return;
    const key = normalizeForMatch(text);
    if (!key) return;
    const idx = lineKeys.findIndex((lk, i) => !used[i] && lk === key);
    if (idx === -1) return;
    used[idx] = true;
    const line = lines[idx];
    seg.start = Math.max(0, line.start_ms / 1000);
    seg.end = Math.max(seg.start + 0.05, line.end_ms / 1000);
    seg.approx = true;
    // 정렬 신뢰도(0~1, 표시 전용). UI가 낮은 줄을 "검토 필요"로 강조한다.
    if (typeof line.confidence === 'number') seg.confidence = line.confidence;
    appliedCount++;
  });
  return appliedCount;
}

/**
 * Serializes lyric segments (+ optional standalone marker lines) to LRC text.
 *
 * 가사 줄은 **세그먼트 순서 그대로** 기록한다 — 시간순으로 정렬하면 미싱크
 * 줄(전부 00:00.00)이 저장할 때마다 파일 맨 위로 몰려서, 부분 싱크된 곡의
 * 가사 순서가 저장·재로드 시 뒤섞이는 버그가 있었음. parseLrc는 파일 순서를
 * 세그먼트 순서로 쓰므로 원래 텍스트 순서가 그대로 보존된다.
 * 마커 줄([vocalstart]/[ilstart]/[ilend])은 파싱이 위치와 무관하므로
 * (parseMarkers는 전체 스캔, parseLrc는 마커 전용 줄을 무시) 파일 끝에
 * 시간순으로 붙인다.
 *
 * @param segments 세그먼트 배열 ({text|original/pronunciation/translation, start})
 * @param markerLines 마커 문자열 배열 (formatMarkerLine 결과), 시간순 정렬됨
 */
export function encodeLrc(segments, markerLines = []) {
  const lines = [];
  (segments || []).forEach((s) => {
    const min = Math.floor(s.start / 60).toString().padStart(2, '0');
    const sec = (s.start % 60).toFixed(2).padStart(5, '0');
    const ts = `[${min}:${sec}]`;
    if (isTriplet(s)) {
      lines.push(`${ts}[orig]${s.original || ''}`);
      lines.push(`${ts}[pron]${s.pronunciation || ''}`);
      lines.push(`${ts}[tran]${s.translation || ''}`);
    } else if ((s.text || '').trim()) {
      lines.push(`${ts}${s.text}`);
    }
  });
  (markerLines || []).forEach((m) => lines.push(m));
  return lines.join('\n');
}

export function parseLrc(lrcContent, duration = 0) {
  if (!lrcContent) return [];

  const lines = lrcContent.replace(/\r\n/g, '\n').split('\n');
  const segments = [];
  const timeRegex = /\[(\d{2}):(\d{2}\.\d{2,3})\]/;
  const metadataRegex = /^\[[a-zA-Z]{2,8}\s*:[^\]]*\]$/;

  let pendingTriplet = null;
  const flushTriplet = () => {
    if (pendingTriplet) {
      pendingTriplet.text = pendingTriplet.original;
      segments.push(pendingTriplet);
      pendingTriplet = null;
    }
  };

  lines.forEach((line) => {
    const match = timeRegex.exec(line);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseFloat(match[2]);
      const start = min * 60 + sec;
      const timeStr = match[0];
      const rest = line.replace(timeStr, '');
      if (isMarkerOnlyLine(rest)) return; // vocalstart/ilstart/ilend — not a lyric line

      const tripletMatch = tripletTagRegex.exec(rest.trimStart());
      if (tripletMatch) {
        const field = TRIPLET_FIELD_BY_TAG[tripletMatch[1]];
        const text = normalizeLyricText(tripletMatch[2]);
        if (tripletMatch[1] === 'orig' || !pendingTriplet) {
          flushTriplet();
          pendingTriplet = { original: '', pronunciation: '', translation: '', start, end: 0 };
        }
        pendingTriplet[field] = text;
        pendingTriplet.start = start;
        return;
      }

      flushTriplet();
      const text = normalizeLyricText(rest);
      if (text) {
        segments.push({ text, start, end: 0 });
      }
    } else if (line.trim()) {
      flushTriplet();
      const normalized = normalizeLyricText(line);
      if (!normalized) return;
      if (metadataRegex.test(normalized)) return;
      segments.push({ text: normalized, start: 0, end: 0 });
    }
  });
  flushTriplet();

  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].start > 0 && segments[i + 1].start > 0) {
      segments[i].end = segments[i + 1].start;
    } else {
      segments[i].end = 0;
    }
  }

  if (segments.length > 0) {
    segments[segments.length - 1].end = duration > 0 ? duration : 0;
  }

  return segments;
}
