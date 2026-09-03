/**
 * nav-history.js — 화면 이동 히스토리 (뒤로/앞으로)
 *
 * 이 앱에는 라우터도 URL도 없다. switchTab()이 페이지 div의 display를 직접
 * 토글하는 방식이라, 화면을 옮기면 이전 화면으로 돌아올 길이 없었다. 특히
 * 라이브러리에서 한참 내려가 곡을 찾은 뒤 가사 싱크에 들렀다 오면 목록이
 * 맨 위로 돌아가 있어서 하던 일을 다시 찾아야 했다.
 *
 * 그래서 브라우저 히스토리와 같은 모양의 스택을 직접 둔다. DOM을 전혀
 * 만지지 않는 순수 모듈이라 단위 테스트가 가능하다 — 화면을 실제로 바꾸는
 * 일은 events/navigation.js가 맡는다.
 */

/** 스택 상한. 오래 켜 두는 앱이라 무한히 쌓이지 않게 앞쪽부터 버린다. */
export const MAX_ENTRIES = 50;

let entries = [];
let cursor = -1;

/**
 * 새 화면을 히스토리에 쌓는다. 앞으로(forward) 갈 수 있던 항목은 버려진다 —
 * 브라우저에서 뒤로 간 뒤 다른 링크를 누르면 앞 기록이 사라지는 것과 같다.
 * 같은 화면을 연속으로 밀면 무시한다(같은 탭 버튼을 두 번 눌렀을 때 등).
 */
export function pushEntry(view) {
  if (!view) return current();
  if (cursor >= 0 && entries[cursor].view === view) return entries[cursor];

  entries = entries.slice(0, cursor + 1);
  entries.push({ view, scroll: 0 });

  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  cursor = entries.length - 1;
  return entries[cursor];
}

/** 현재 항목에 스크롤 위치를 기록한다. 화면을 떠나기 직전에 부른다. */
export function rememberScroll(px) {
  if (cursor < 0) return;
  const value = Number(px);
  entries[cursor].scroll = Number.isFinite(value) && value > 0 ? value : 0;
}

export function canGoBack() {
  return cursor > 0;
}

export function canGoForward() {
  return cursor >= 0 && cursor < entries.length - 1;
}

/** 뒤로 한 칸. 이동한 항목을 반환하고, 갈 곳이 없으면 null. */
export function back() {
  if (!canGoBack()) return null;
  cursor -= 1;
  return entries[cursor];
}

/** 앞으로 한 칸. 이동한 항목을 반환하고, 갈 곳이 없으면 null. */
export function forward() {
  if (!canGoForward()) return null;
  cursor += 1;
  return entries[cursor];
}

export function current() {
  return cursor >= 0 ? entries[cursor] : null;
}

/** 테스트와 재초기화용. */
export function reset() {
  entries = [];
  cursor = -1;
}

/** 디버깅·테스트용 스냅샷(내부 배열을 그대로 넘기지 않는다). */
export function snapshot() {
  return { cursor, entries: entries.map((e) => ({ ...e })) };
}
