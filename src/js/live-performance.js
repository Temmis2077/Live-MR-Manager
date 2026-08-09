/** Pure live-performance helpers. Kept DOM-free so timing and queue behavior
 * can be verified without a Tauri window. */
import { lineProgress } from './alignment-metadata.js';

/**
 * MR(반주)이 준비된 곡인가.
 *
 * 앱 여러 곳이 저마다 다른 필드를 보고 있었다 — 라이브 배지와 큐는
 * hasMr/mrReady만 봐서, 실제로 분리가 끝난 곡(isSeparated/mr_path)이 큐에서
 * "원곡"으로 표시됐다. 판정은 한 곳에서만 한다.
 */
export function isMrReady(song) {
  if (!song) return false;
  return !!(song.isSeparated || song.is_separated || song.isMr || song.is_mr
    || song.mr_path || song.hasMr || song.has_mr || song.mrReady);
}

/**
 * 한 줄의 진행도를 그릴 구간(초)을 정한다.
 *
 * 진행도를 그리는 화면이 둘이다 — 라이브 본문과 OBS 오버레이. 두 화면이 구간을
 * 각자 정하면 같은 줄인데 채워진 정도가 다르게 보인다(실제로 그랬다).
 * 그래서 이 규칙은 여기 한 곳에만 둔다.
 *
 * - 끝 시각이 없으면(LRC로 가져온 가사는 흔하다) 다음 줄 시작까지로 본다.
 * - 그 간격이 너무 길면 상한을 쓴다. 마지막 줄이나 간주 앞 줄은 다음 줄까지가
 *   수십 초라, 그대로 두면 진행도가 기어가듯 움직인다.
 * - 0은 "아직 안 정해짐" 센티널이라 값으로 치지 않는다(definedTime).
 *
 * @returns {{startSec: number|null, endSec: number|null}}
 */
export function resolveLineWindow(current, upcoming) {
  const startSec = definedTime(current?.start);
  const upcomingStart = definedTime(upcoming?.start);
  const rawEnd = definedTime(current?.end)
    ?? (startSec != null && upcomingStart != null && upcomingStart > startSec ? upcomingStart : null);
  const endSec = rawEnd == null || startSec == null
    ? rawEnd
    : Math.min(rawEnd, startSec + MAX_SWEEP_SEC);
  return { startSec, endSec };
}

const validTime = (value) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * 시각 필드를 "정해진 값"으로만 인정한다.
 *
 * 앱은 0을 "아직 안 정해짐" 센티널로 써 왔다(lyric-drawer의 `s.end === 0`,
 * hasSyncedLyrics의 `start > 0`). 그런데 validTime은 0을 유한값이라 그대로
 * 돌려줘서, `validTime(end) ?? nextStart` 폴백이 한 번도 살지 않았다.
 * LRC로 가져온 가사(끝 시각 없음)는 진행도가 계속 0%에 멈춰 있었다.
 */
const definedTime = (value) => {
  const n = validTime(value);
  return n === null || n <= 0 ? null : n;
};

/** 끝 시각이 없어 다음 줄 시작으로 대신할 때, 쓸어내는 구간의 상한.
 *  줄 뒤에 긴 간주가 붙으면 진행바가 30초에 걸쳐 기어가 노래와 어긋난다. */
const MAX_SWEEP_SEC = 10;

/**
 * 줄이 끝난 뒤에도 화면에 붙들어 두는 시간.
 *
 * 정렬이 주는 end는 그 줄의 토큰이 끝나는 시점이라, 부르는 사람이 끝음을
 * 끄는 동안 이미 지나간다. 그때 바로 다음 줄로 넘기면 아직 부르고 있는데
 * 화면에는 다음 가사가 떠 있다.
 */
const HOLD_AFTER_END_SEC = 1.5;

/**
 * 다음 줄을 미리 띄우기 시작하는 시점(그 줄 시작까지 남은 시간).
 *
 * 간주 내내 다음 줄을 띄워 두면 "지금 부르는 줄"이 있어야 할 자리에 한참
 * 뒤의 가사가 10초씩 앉아 있다. 곧 부를 때만 바꾼다.
 */
const LEAD_IN_SEC = 4;

/**
 * 지금 시각 이후에 처음 시작하는 줄의 인덱스. 없으면 -1.
 *
 * "부르는 줄이 없을 때 다음 줄이 무엇인가"를 라이브 화면과 OBS 오버레이가
 * 따로 계산하다가 양쪽 다 곡의 첫 줄(list[0])을 집는 같은 버그를 냈다.
 * 줄 사이 간주마다 1절 첫 줄이 "다음 가사"로 떠 있었다. 판정은 여기 한 곳에서만.
 */
/**
 * 이미 시작한 줄 중 가장 마지막 것 = 지금 부르고 있거나 방금 부른 줄.
 *
 * 끝났는지는 보지 않는다. 끝난 뒤에도 다음 줄로 넘어가기 전까지는 이 줄이
 * "지금 부르는 줄" 자리를 지켜야 하기 때문이다 — 언제 넘길지는 부르는 쪽
 * (buildPerformerLyricModel)이 HOLD/LEAD_IN으로 정한다.
 */
function findRecentlySungSegment(list, pos) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const start = definedTime(list[i]?.start);
    if (start != null && start <= pos) return list[i];
  }
  return null;
}

export function findUpcomingIndex(segments, positionSec) {
  const list = Array.isArray(segments) ? segments : [];
  const pos = Number(positionSec) || 0;
  return list.findIndex((segment) => {
    const start = definedTime(segment?.start);
    return start != null && start > pos;
  });
}

export function getLiveSectionState(positionSec, markers = {}) {
  const position = Math.max(0, Number(positionSec) || 0);
  const vocalStart = validTime(markers.vocalStartSec);
  const activeInterlude = (markers.interludes || []).find((region) => {
    const start = validTime(region?.start);
    const end = validTime(region?.end);
    return start != null && end != null && position >= start && position < end;
  });

  if (activeInterlude) {
    const beforeVocal = vocalStart != null && position < vocalStart;
    return {
      kind: beforeVocal ? 'intro' : 'interlude',
      label: beforeVocal ? '전주' : '간주',
      remainingSec: Math.max(0, Number(activeInterlude.end) - position),
    };
  }
  if (vocalStart != null && position < vocalStart) {
    return { kind: 'vocal-countdown', label: '보컬 진입', remainingSec: vocalStart - position };
  }
  return { kind: 'singing', label: '가창', remainingSec: null };
}

export function buildPerformerLyricModel(segments, currentIndex, positionSec, markers = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const index = Number.isInteger(currentIndex) ? currentIndex : -1;
  const pos = Number(positionSec) || 0;

  // 줄 사이 간주에서 lyric-drawer는 index로 -1을 준다. 예전에는 다음 줄을
  // list[index + 1]로 잡아 index가 -1일 때 list[0] — 곡의 첫 줄이 나왔고,
  // 뒤에 붙은 폴백은 list[0]이 참이라 한 번도 실행되지 않았다. 그래서 노래
  // 중반 간주에도 "다음 가사"가 1절 첫 줄로 굳고 카운트다운은 0초였다.
  const upcomingIndex = index >= 0 ? index + 1 : findUpcomingIndex(list, pos);
  const upcoming = upcomingIndex >= 0 ? list[upcomingIndex] || null : null;

  // "지금 부르는 줄" 자리는 부르고 있는 줄, 또는 방금 부른 줄이 지킨다.
  //
  // 예전에는 부르는 줄이 없기만 하면(index === -1) 곧바로 다음 줄을 올렸다.
  // 그런데 정렬의 end는 토큰이 끝나는 시점이라 끝음을 끄는 동안 이미 지나가고,
  // 줄 사이 간격이 길면 한참 뒤의 가사가 10초씩 그 자리에 앉아 있었다 —
  // 아직 이 줄을 부르는데 화면에는 다음 가사가 떠 있었다.
  //
  // 그래서 두 단계를 둔다: 끝난 뒤 잠깐은 그대로 붙들고(HOLD_AFTER_END_SEC),
  // 다음 줄이 곧 시작할 때만(LEAD_IN_SEC) 미리 바꿔 준다.
  const sung = index >= 0 ? list[index] || null : null;
  const justSung = sung ?? findRecentlySungSegment(list, pos);
  const upcomingStartSec = definedTime(upcoming?.start);
  const leadInDue = upcomingStartSec != null && upcomingStartSec - pos <= LEAD_IN_SEC;
  // 방금 끝난 줄은 잠깐 더 붙든다 — end는 끝음을 끄는 시간을 담지 않는다.
  const justSungEnd = definedTime(justSung?.end);
  const stillHolding = justSungEnd != null && pos - justSungEnd < HOLD_AFTER_END_SEC;
  // 아직 아무 줄도 안 부른 곡 첫머리에는 붙들 것이 없으니 다음 줄을 보여 준다.
  const pending = sung == null && upcoming != null
    && (justSung == null || (leadInDue && !stillHolding));
  const current = pending ? upcoming : justSung;
  const next = pending ? (list[upcomingIndex + 1] || null) : upcoming;

  const nextStartSec = definedTime(next?.start);
  const { startSec: currentStart, endSec: currentEnd } = resolveLineWindow(current, upcoming);

  // 진행도 계산은 lineProgress 한 곳에서만 한다.
  //
  // 예전에는 여기서 (pos - start) / (end - start)를 따로 계산했다. 그래서
  // 단어 타임이 있어도 못 쓰고, 오버레이(같은 규칙을 쓰는)와 라이브 화면의
  // 진행도가 서로 달랐다 — 편집기에서 맞춘 타이밍과도 어긋나 보였다.
  //
  // MAX_SWEEP_SEC 상한은 여기서만 필요하다: 끝 시각이 없는 줄(LRC로 가져온
  // 가사)의 폴백 구간이 너무 길어지지 않게 하는 장치다. 단어 타임이 있으면
  // 실제 끝을 알기 때문에 상한이 필요 없고, lineProgress가 알아서 쓴다.
  let progress = 0;
  if (!pending && currentStart != null && currentEnd != null && currentEnd > currentStart) {
    progress = lineProgress(
      { start: currentStart, end: currentEnd, words: current?.words },
      pos * 1000,
    );
  }

  return {
    current,
    next,
    /** 아직 부르기 전(리드인)으로 미리 띄운 줄인가. */
    pending,
    /** 지금 줄을 부르기 시작할 때까지 남은 시간. 리드인일 때만 값이 있다. */
    startsInSec: pending && currentStart != null ? Math.max(0, currentStart - pos) : null,
    nextStartSec,
    nextInSec: nextStartSec == null ? null : Math.max(0, nextStartSec - pos),
    progress,
    sectionState: getLiveSectionState(pos, markers),
    hasSyncedLyrics: list.some((segment) => Number(segment?.start) > 0),
  };
}

export function moveQueueItem(queue, fromIndex, toIndex) {
  const copy = Array.isArray(queue) ? [...queue] : [];
  if (fromIndex < 0 || fromIndex >= copy.length || toIndex < 0 || toIndex >= copy.length || fromIndex === toIndex) return copy;
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, item);
  return copy;
}

export function nextLiveQueuePath(queue, currentPath) {
  const list = Array.isArray(queue) ? queue : [];
  const index = currentPath ? list.indexOf(currentPath) : -1;
  if (index < 0) return list[0] || null;
  if (list.length <= 1) return null;
  return list[index + 1] || list.find((path) => path !== currentPath) || null;
}

export function resolveNextLiveQueuePath(queue, currentPath, availablePaths) {
  const available = availablePaths instanceof Set ? availablePaths : new Set(availablePaths || []);
  const list = Array.isArray(queue) ? queue : [];
  if (!list.length) return { path: null, stalePaths: [] };
  const start = Math.max(-1, list.indexOf(currentPath));
  const candidates = start >= 0
    ? [...list.slice(start + 1), ...list.slice(0, start)]
    : [...list];
  const stalePaths = candidates.filter((path) => path !== currentPath && !available.has(path));
  return { path: candidates.find((path) => path !== currentPath && available.has(path)) || null, stalePaths };
}

export function appendLiveHistory(history, currentPath, nextPath, limit = 50) {
  const copy = Array.isArray(history) ? [...history] : [];
  if (!currentPath || currentPath === nextPath || copy.at(-1) === currentPath) return copy;
  copy.push(currentPath);
  return copy.slice(-limit);
}

export function takePreviousLivePath(history, availablePaths) {
  const copy = Array.isArray(history) ? [...history] : [];
  const available = availablePaths instanceof Set ? availablePaths : new Set(availablePaths || []);
  while (copy.length) {
    const path = copy.pop();
    if (available.has(path)) return { path, history: copy };
  }
  return { path: null, history: copy };
}
