/**
 * segment-bounds.js — 가사 줄 경계를 옮길 때의 규칙 (DOM 없음)
 *
 * 규칙이 한 곳에 있어야 하는 이유 — 예전에는 Shift+Enter(끝 지정)와 방향키
 * 미세조정이 **정반대**로 동작했다. 끝 지정은 다음 줄 시작 앞에서 잘라 버려
 * AI 정렬 뒤엔 아무것도 못 넘겼고, 방향키는 이웃을 마음대로 침범했다.
 *
 * 정한 규칙:
 *   - 끝을 뒤로 밀면 **다음 줄 시작도 같이 밀린다.** 사용자가 "여기까지가 이
 *     줄"이라고 말한 것이므로 다음 줄이 물러나는 게 맞다.
 *   - 시작을 앞으로 당기면 **앞 줄 끝도 같이 당겨진다.** (앞뒤 대칭)
 *   - 다만 이웃을 통째로 삼키지는 않는다. 이웃도 최소 길이는 남긴다.
 *   - 아직 안 찍은 줄(start<=0)은 벽이 아니다 — 손으로 처음 찍어 나갈 때
 *     뒤에 있는 빈 줄들이 길을 막으면 안 된다.
 */

/** 줄 하나가 가질 수 있는 최소 길이(초). */
export const MIN_SEGMENT_LEN = 0.05;

/** 뒤쪽에서 실제로 시각이 찍혀 있는 첫 줄. 없으면 null. */
export function findNextStarted(segments, idx) {
  for (let j = idx + 1; j < segments.length; j += 1) {
    if (segments[j].start > 0) return segments[j];
  }
  return null;
}

/** 앞쪽에서 실제로 시각이 찍혀 있는 첫 줄. 없으면 null. */
export function findPrevStarted(segments, idx) {
  for (let j = idx - 1; j >= 0; j -= 1) {
    if (segments[j].start > 0) return segments[j];
  }
  return null;
}

/**
 * 끝을 옮길 때 실제로 적용될 값과, 다음 줄을 밀어야 하는지를 계산한다.
 *
 * @returns {{applied:number, pushNextStartTo:number|null}|null}
 *          자리가 없으면 null.
 */
export function planSegmentEnd({ seg, next, duration, requestedEnd }) {
  const lower = seg.start + MIN_SEGMENT_LEN;
  // 다음 줄이 있으면 그 줄의 '끝'까지가 한계다(그 줄도 최소 길이를 남긴다).
  const upper = next ? Math.max(lower, next.end - MIN_SEGMENT_LEN) : duration;
  if (upper <= lower) return null;

  const applied = Math.max(lower, Math.min(requestedEnd, upper));
  return {
    applied,
    pushNextStartTo: next && applied > next.start ? applied : null,
  };
}

/**
 * 시작을 옮길 때 실제로 적용될 값과, 앞 줄을 당겨야 하는지를 계산한다.
 *
 * @returns {{applied:number, pullPrevEndTo:number|null}|null}
 */
export function planSegmentStart({ seg, prev, requestedStart }) {
  const upper = seg.end - MIN_SEGMENT_LEN;
  const lower = prev ? Math.min(upper, prev.start + MIN_SEGMENT_LEN) : 0;
  if (upper <= lower) return null;

  const applied = Math.max(lower, Math.min(requestedStart, upper));
  return {
    applied,
    pullPrevEndTo: prev && applied < prev.end ? applied : null,
  };
}
