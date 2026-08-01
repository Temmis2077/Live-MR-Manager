/**
 * live-lyrics.js — 라이브 화면의 가사 패널
 *
 * 라이브 화면에서 가사를 볼 곳이 없었다. 화면 오른쪽에 붙어 있던 LYRICS 서랍을
 * 걷어낸 뒤로 인앱에서 싱크 결과를 확인할 자리가 가사 싱크 편집기밖에 남지
 * 않았는데, 공연 중에 편집기를 열 수는 없다.
 *
 * 데이터는 새로 읽지 않는다. 재생 위치 → 현재 줄 계산은 lyric-drawer.js가
 * 한 곳에서 담당하고(그래야 오버레이와 어긋나지 않는다), 여기서는 그 결과를
 * 받아 그리기만 한다.
 */
const $ = (id) => document.getElementById(id);

const SIDE_KEY = 'liveLyricsSide';     // 'left' | 'right'
const HIDDEN_KEY = 'liveLyricsHidden'; // '1' | '0'

let segments = [];
let activeIndex = -1;

function panel() {
  return $('live-lyrics');
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/** 세그먼트에서 화면에 쓸 텍스트. 3줄 모드(원문/차음/번역)는 줄바꿈으로 합쳐진다. */
function lineText(seg) {
  if (seg == null) return '';
  if (typeof seg === 'string') return seg;
  return seg.text ?? '';
}

export function getSide() {
  return localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right';
}

export function isHidden() {
  return localStorage.getItem(HIDDEN_KEY) === '1';
}

function applyLayout() {
  const el = panel();
  if (!el) return;
  const side = getSide();
  const hidden = isHidden();

  el.dataset.side = side;
  el.hidden = hidden;
  // 라이브 본문이 패널 자리를 비켜 주도록 body에 표시 — CSS가 order로 좌우를 바꾼다.
  document.body.classList.toggle('live-lyrics-left', side === 'left' && !hidden);
  document.body.classList.toggle('live-lyrics-on', !hidden);

  const sideBtn = $('live-lyrics-side');
  if (sideBtn) {
    sideBtn.textContent = side === 'left' ? '오른쪽으로' : '왼쪽으로';
    sideBtn.title = side === 'left'
      ? '가사 패널을 오른쪽으로 옮깁니다'
      : '가사 패널을 왼쪽으로 옮깁니다';
  }

  const showBtn = $('live-lyrics-show');
  if (showBtn) showBtn.hidden = !hidden;
}

/** 전체 가사 목록을 다시 그린다. lyric-drawer.js의 updateLyrics가 호출한다. */
export function renderLiveLyrics(list) {
  segments = Array.isArray(list) ? list : [];
  activeIndex = -1;

  const body = $('live-lyrics-body');
  if (!body) return;

  if (segments.length === 0) {
    body.innerHTML = `
      <div class="live-lyrics-empty">
        이 곡에는 싱크된 가사가 없습니다.<br>
        음원 관리에서 <strong>싱크 가사 가져오기</strong>를 누르거나,
        가사 싱크 화면에서 직접 맞출 수 있습니다.
      </div>`;
    return;
  }

  body.innerHTML = segments
    .map((s, i) => `<div class="live-lyric-line" data-index="${i}">${esc(lineText(s))}</div>`)
    .join('');
}

/** 현재 부르는 줄 표시. 인덱스가 -1이면 표시를 지운다. */
export function highlightLiveLyric(index) {
  const body = $('live-lyrics-body');
  if (!body || activeIndex === index) return;
  activeIndex = index;

  const lines = body.querySelectorAll('.live-lyric-line');
  lines.forEach((el, i) => el.classList.toggle('active', i === index));

  const cur = lines[index];
  // 공연 중에는 눈을 떼지 않아도 되게 현재 줄을 가운데로 붙든다.
  if (cur) cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

let inited = false;

export function initLiveLyrics() {
  if (inited) return;
  const el = panel();
  if (!el) return;
  inited = true;

  $('live-lyrics-side')?.addEventListener('click', () => {
    localStorage.setItem(SIDE_KEY, getSide() === 'left' ? 'right' : 'left');
    applyLayout();
  });

  $('live-lyrics-hide')?.addEventListener('click', () => {
    localStorage.setItem(HIDDEN_KEY, '1');
    applyLayout();
  });

  $('live-lyrics-show')?.addEventListener('click', () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    applyLayout();
  });

  applyLayout();
}

/** 라이브 화면에 들어올 때 — 지금 곡의 가사를 즉시 반영한다. */
export function refreshLiveLyrics() {
  initLiveLyrics();
  applyLayout();
  import('./state.js').then(({ state }) => {
    renderLiveLyrics(state.currentLyrics || []);
    if (state.currentLyricIndex >= 0) highlightLiveLyric(state.currentLyricIndex);
  }).catch(() => {});
}
