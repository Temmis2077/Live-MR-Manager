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
import { getDisplayLines } from './lrc-parser.js';

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

/**
 * 한 줄에 표시할 HTML. 3줄 모드(원문/차음/번역)는 설정에 따라 함께 보여준다.
 *
 * 예전에는 seg.text만 읽어서, 일본어 곡처럼 3줄로 저장된 가사는 원문(한자)만
 * 나오고 차음·번역이 사라졌다. 어떤 줄을 보여줄지는 lrc-parser의
 * getDisplayLines가 인앱 표시 설정('app' 스코프)을 보고 정한다 — 드로어·
 * 오버레이와 같은 규칙을 써야 화면마다 다르게 보이지 않는다.
 */
export function lineHtml(seg) {
  if (seg == null) return '';
  if (typeof seg === 'string') return esc(seg);

  const lines = getDisplayLines(seg, 'app').filter(Boolean);
  if (lines.length === 0) return '';
  const [first, ...rest] = lines;
  if (rest.length === 0) return esc(first);
  // 원문을 크게, 차음·번역은 작고 흐리게 — 부를 때 눈이 원문으로 먼저 간다.
  const restHtml = rest
    .map((l) => `<span class="live-lyric-sub">${esc(l)}</span>`)
    .join('');
  return `${esc(first)}${restHtml}`;
}

export function getSide() {
  return localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right';
}

export function isHidden() {
  // 기본은 접힌 상태다. 중앙에 큰 현재 가사가 이미 있고, 전체 목록은 필요할
  // 때만 보면 된다 — 상시로 펼쳐 두면 300px이 중앙 가사에서 빠진다.
  return localStorage.getItem(HIDDEN_KEY) !== '0';
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
  const centralToggle = $('live-full-lyrics-toggle');
  if (centralToggle) {
    centralToggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    centralToggle.textContent = hidden ? '전체 가사' : '전체 가사 닫기';
  }
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
        싱크된 가사 없음<br>
        음원 관리의 <strong>싱크 가사 가져오기</strong> 또는 가사 싱크 화면에서 맞춥니다.
      </div>`;
    return;
  }

  // 현재 줄에만 진행도를 칠할 수 있게, 줄마다 겹침 요소를 함께 넣는다.
  // (중앙 큰 가사와 같은 방식 — .live-karaoke-base / .live-karaoke-fill)
  body.innerHTML = segments
    .map((s, i) => {
      const html = lineHtml(s);
      return `<div class="live-lyric-line" data-index="${i}">`
        + `<span class="live-lyric-base">${html}</span>`
        + `<span class="live-lyric-fill" aria-hidden="true">${html}</span>`
        + `</div>`;
    })
    .join('');
}

/**
 * 현재 줄의 진행도를 칠한다. 라이브 화면의 tick이 프레임마다 부른다.
 *
 * 계산은 alignment-metadata.js의 lineProgress 한 곳에서만 한다 — 중앙 큰
 * 가사·오버레이와 같은 규칙이어야 세 화면이 어긋나지 않는다.
 */
export function paintLiveLyricProgress(ratio) {
  const body = $('live-lyrics-body');
  if (!body || activeIndex < 0) return;
  const cur = body.querySelectorAll('.live-lyric-line')[activeIndex];
  if (!cur) return;
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  cur.style.setProperty('--lyric-progress', `${(pct * 100).toFixed(2)}%`);
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

  $('live-full-lyrics-toggle')?.addEventListener('click', () => {
    localStorage.setItem(HIDDEN_KEY, isHidden() ? '0' : '1');
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
