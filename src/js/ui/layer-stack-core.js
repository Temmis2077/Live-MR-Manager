/**
 * layer-stack-core.js — 레이어 스택의 판단 로직 (DOM 없음)
 *
 * ui/layer-stack.js에서 "쌓고 빼고 고르는" 규칙만 떼어냈다. DOM을 만지는 부분
 * (포커스 이동·Tab 순환·Escape 수신)은 그쪽에 남는다.
 *
 * 왜 나눴나 — 이 규칙에서 실제로 사고가 났다. 레이어를 올린 쪽이 pop을 빠뜨리면
 * 스택이 영영 비지 않았고, `hasOpenLayer()`를 가드로 쓰는 가사 싱크 편집기의
 * 키가 통째로 죽었다. 화면에 아무 표시가 없어 원인을 찾기 어려운 종류였다.
 * 규칙만 떼어 두면 이 저장소의 다른 순수 모듈들처럼 테스트로 묶어 둘 수 있다.
 */

/**
 * 화면에서 이미 사라진 레이어를 걷어낸 스택을 돌려준다.
 *
 * "떠 있다"의 근거를 스택이 아니라 **실제 상태**(isAlive)에 두는 것이 핵심이다.
 * 누수는 여전히 버그이므로 조용히 넘어가지 않고, 걷어낸 것을 함께 알려 준다.
 *
 * @param {object[]} stack
 * @param {(handle:object)=>boolean} isAlive
 * @returns {{stack: object[], dropped: object[]}}
 */
export function pruneStack(stack, isAlive) {
  const alive = [];
  const dropped = [];
  for (const handle of stack) {
    if (isAlive(handle)) alive.push(handle);
    else dropped.push(handle);
  }
  // 걷어낼 게 없으면 원래 배열을 그대로 준다(불필요한 교체를 피한다).
  return dropped.length ? { stack: alive, dropped } : { stack, dropped };
}

/** 살아 있는 것 중 최상단. 없으면 null. */
export function topOf(stack, isAlive) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (isAlive(stack[i])) return stack[i];
  }
  return null;
}

/** 살아 있는 레이어가 하나라도 있는지. */
export function hasLive(stack, isAlive) {
  return topOf(stack, isAlive) !== null;
}

/**
 * 핸들 하나를 뺀 스택. 스택에 없거나 이미 뺀 핸들이면 원래 스택 그대로.
 *
 * @returns {{stack: object[], removedIndex: number}} removedIndex가 -1이면 아무것도 안 뺐다.
 */
export function removeHandle(stack, handle) {
  const idx = stack.indexOf(handle);
  if (idx === -1) return { stack, removedIndex: -1 };
  return { stack: [...stack.slice(0, idx), ...stack.slice(idx + 1)], removedIndex: idx };
}

/**
 * 뺀 자리가 최상단이었는지 — 그때만 포커스를 원래 자리로 돌린다.
 * 아래쪽이 닫히면서 위 레이어의 포커스를 빼앗아 가면 안 된다.
 */
export function wasTop(removedIndex, stackLengthAfterRemoval) {
  return removedIndex === stackLengthAfterRemoval;
}
