/**
 * live-screen.js — 라이브(공연 리모컨) 화면
 *
 * claude.ai/design 시안(OSW UI)의 '라이브' 화면을 앱에 옮긴 것. 방송/공연 중에는
 * 작은 슬라이더를 정확히 집기 어려우므로, 자주 만지는 값(키·빠르기·가이드 보컬·
 * 볼륨)을 큰 버튼과 큰 숫자로 다시 배치했다.
 *
 * 설계 원칙 — 여기 있는 컨트롤은 **전부 실제로 동작**해야 한다. 그래서 새 상태를
 * 따로 만들지 않고, 이미 있는 도크의 슬라이더(pitch/tempo/보컬 밸런스/마스터 볼륨)를
 * 그대로 조작한다. 그러면 백엔드 호출·설정 저장·도크 UI 동기화가 기존 경로로
 * 한 번에 처리되고, 두 화면의 값이 어긋날 일이 없다.
 * (시안의 '가사 타이밍' 카드는 대응하는 기능이 앱에 없어, 실제로 동작하는
 *  '가이드 보컬'로 대체했다 — 눌러도 아무 일 없는 버튼을 두지 않기 위해.)
 */
import { state } from './state.js';
import { invoke } from './tauri-bridge.js';
import { formatTime, getThumbnailUrl } from './utils.js';

const WAVE_BARS = 84;
/** 반주(MR) 페이더는 도크에 대응 슬라이더가 없어 여기서 값을 들고 저장한다. */
const MR_FADER_KEY = 'liveMrFader';

let initialized = false;
let tickTimer = null;
let waveEls = [];
let waveSeedPath = null;

const $ = (id) => document.getElementById(id);

/** 곡 경로로 고정된 파형 모양을 만든다 — 같은 곡이면 항상 같은 그림이라
 *  재생 위치만 채워지는 것처럼 보인다(실제 파형 해석은 가사 싱크 탭에 있다). */
function waveHeights(path) {
  let h = 2166136261;
  for (let i = 0; i < (path || '').length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out = [];
  let s = h >>> 0 || 12345;
  for (let i = 0; i < WAVE_BARS; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const r = (s % 1000) / 1000;
    // 곡 중반이 더 크게 — 밋밋한 난수보다 파형처럼 보이도록 완만한 포락선을 곱한다.
    const env = 0.45 + 0.55 * Math.sin((i / WAVE_BARS) * Math.PI);
    out.push(Math.round((0.16 + r * 0.84) * env * 100));
  }
  return out;
}

function buildWave(path) {
  const wrap = $('live-wave');
  if (!wrap) return;
  const heights = waveHeights(path);
  wrap.innerHTML = heights
    .map((h) => `<div class="live-wave-bar" style="height:${Math.max(4, h)}%"></div>`)
    .join('');
  waveEls = Array.from(wrap.children);
  waveSeedPath = path;
}

function readMrFader() {
  const raw = parseFloat(localStorage.getItem(MR_FADER_KEY) || '100');
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100;
}

/** 도크 슬라이더를 프로그램적으로 움직인다 — input 이벤트를 직접 쏴서
 *  기존 리스너(백엔드 반영·설정 저장·도크 표시 갱신)가 그대로 돌게 한다. */
function driveSlider(id, value) {
  const el = $(id);
  if (!el) return null;
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el;
}

function stepSlider(id, delta, { min, max, decimals = 0 }) {
  const el = $(id);
  if (!el) return;
  const cur = parseFloat(el.value);
  const lo = min ?? parseFloat(el.min);
  const hi = max ?? parseFloat(el.max);
  let next = (Number.isFinite(cur) ? cur : lo) + delta;
  next = Math.max(lo, Math.min(hi, next));
  driveSlider(id, decimals > 0 ? next.toFixed(decimals) : Math.round(next));
}

/** 현재 곡 정보·재생 상태·조절값을 화면에 반영. 화면이 보일 때만 호출된다. */
function tick() {
  const track = state.currentTrack;

  const titleEl = $('live-title');
  const artistEl = $('live-artist');
  const artEl = $('live-art-img');
  if (titleEl) titleEl.textContent = track ? (track.title || '제목 없음') : '재생 중인 곡 없음';
  if (artistEl) {
    artistEl.textContent = track
      ? [track.artist, track.genre].filter(Boolean).join(' · ') || '가수 정보 없음'
      : '라이브러리에서 곡을 골라 주세요';
  }
  if (artEl) {
    const thumb = track ? getThumbnailUrl(track.thumbnail) : null;
    const next = thumb || './assets/images/app-icon.png';
    if (artEl.getAttribute('src') !== next) artEl.setAttribute('src', next);
  }

  // 배지 — 재생 중 표시와 MR(보컬 분리) 여부
  const badges = $('live-badges');
  if (badges) {
    const parts = [];
    if (state.isPlaying) {
      parts.push('<div class="live-badge playing"><span class="live-badge-dot"></span>지금 노래 중</div>');
    } else if (track) {
      parts.push('<div class="live-badge">멈춤</div>');
    }
    if (track && (track.hasMr || track.has_mr || track.mrReady)) {
      parts.push('<div class="live-badge">보컬 지움 · MR 준비됨</div>');
    }
    const html = parts.join('');
    if (badges.innerHTML !== html) badges.innerHTML = html;
  }

  // 파형 — 곡이 바뀌면 다시 그리고, 재생 위치까지 색을 채운다
  const path = track ? track.path : '';
  if (path !== waveSeedPath) buildWave(path);
  const dur = state.trackDurationMs || 0;
  const pos = state.currentProgressMs || 0;
  const ratio = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  const filled = Math.round(ratio * waveEls.length);
  for (let i = 0; i < waveEls.length; i++) {
    const on = i < filled;
    if (waveEls[i]._on !== on) {
      waveEls[i].classList.toggle('played', on);
      waveEls[i]._on = on;
    }
  }

  const posEl = $('live-pos');
  const durEl = $('live-dur');
  if (posEl) posEl.textContent = formatTime(pos / 1000);
  if (durEl) durEl.textContent = formatTime(dur / 1000);

  const playBtn = $('live-play');
  if (playBtn) playBtn.textContent = state.isPlaying ? '❚❚' : '▶';

  // 조절값 — 도크 슬라이더가 항상 진실의 원본
  const pitch = parseFloat($('pitch-slider')?.value ?? '0') || 0;
  const keyEl = $('live-key-val');
  if (keyEl) {
    keyEl.textContent = pitch > 0 ? `+${pitch}` : `${pitch}`;
    keyEl.classList.toggle('changed', pitch !== 0);
  }

  const ratioTempo = parseFloat($('tempo-slider')?.value ?? '1') || 1;
  const tempoPct = Math.round(ratioTempo * 100);
  const tempoEl = $('live-tempo-val');
  if (tempoEl) {
    tempoEl.textContent = String(tempoPct);
    tempoEl.classList.toggle('changed', tempoPct !== 100);
  }

  const guide = parseFloat($('vocal-balance')?.value ?? '0') || 0;
  const guideEl = $('live-guide-val');
  if (guideEl) {
    guideEl.textContent = String(Math.round(guide));
    guideEl.classList.toggle('changed', Math.round(guide) !== 0);
  }

  const mr = readMrFader();
  const mrVal = $('live-mr-val');
  const mrFill = $('live-mr-fill');
  if (mrVal) mrVal.textContent = String(Math.round(mr));
  if (mrFill) mrFill.style.width = `${mr}%`;

  const mon = parseFloat($('master-volume-slider')?.value ?? '100') || 0;
  const monVal = $('live-mon-val');
  const monFill = $('live-mon-fill');
  if (monVal) monVal.textContent = String(Math.round(mon));
  // 마스터 볼륨은 0~120이라 막대는 120 기준으로 채운다
  if (monFill) monFill.style.width = `${Math.min(100, (mon / 120) * 100)}%`;
}

/** 오른쪽 '다음 곡' 목록 — 지금 라이브러리 필터가 적용된 순서를 그대로 쓴다. */
export function renderLiveQueue() {
  const listEl = $('live-queue-list');
  const countEl = $('live-queue-count');
  if (!listEl) return;

  const tracks = (state.filteredTracks && state.filteredTracks.length)
    ? state.filteredTracks
    : (state.songLibrary || []).map((s, i) => ({ ...s, originalIndex: i }));

  const curPath = state.currentTrack?.path;
  const curIdx = tracks.findIndex((t) => t.path === curPath);
  // 현재 곡 다음부터 이어서 보여준다(끝나면 처음으로 돌아가는 재생 순서와 동일).
  const ordered = curIdx >= 0
    ? tracks.slice(curIdx).concat(tracks.slice(0, curIdx))
    : tracks;

  if (countEl) countEl.textContent = `${tracks.length}곡`;

  if (ordered.length === 0) {
    listEl.innerHTML = '<div class="live-q-empty">라이브러리가 비어 있습니다.<br>아래 “노래 추가”로 곡을 넣어 주세요.</div>';
    return;
  }

  const esc = (s) => {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  };

  listEl.innerHTML = ordered.slice(0, 40).map((t, i) => {
    const isCur = t.path === curPath;
    const ready = !!(t.hasMr || t.has_mr || t.mrReady);
    return `
      <div class="live-q-item${isCur ? ' current' : ''}" data-index="${t.originalIndex}">
        <div class="live-q-num">${isCur ? '▶' : i}</div>
        <div class="live-q-body">
          <div class="live-q-title">${esc(t.title)}</div>
          <div class="live-q-sub">${esc(t.artist || '가수 정보 없음')}</div>
        </div>
        <div class="live-q-badge${ready ? ' ready' : ''}">${ready ? 'MR' : '원곡'}</div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.live-q-item').forEach((el) => {
    el.onclick = async () => {
      const idx = parseInt(el.dataset.index, 10);
      if (!Number.isFinite(idx)) return;
      const { selectTrack } = await import('./player.js');
      selectTrack(idx);
    };
  });
}

/** 분리 진행 배너 — 실제로 돌고 있는 작업이 있을 때만 보인다. */
function renderSeparation() {
  const box = $('live-sep');
  if (!box) return;
  const tasks = Object.entries(state.activeTasks || {});
  if (tasks.length === 0) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  const [, first] = tasks[0];
  const pct = Math.round(first?.percentage || 0);
  const titleEl = $('live-sep-title');
  const subEl = $('live-sep-sub');
  const pctEl = $('live-sep-pct');
  if (titleEl) titleEl.textContent = `보컬 지우는 중 · ${tasks.length}곡`;
  if (subEl) subEl.textContent = first?.title || '';
  if (pctEl) pctEl.textContent = `${pct}%`;
}

export function initLiveScreen() {
  if (initialized) return;
  initialized = true;

  // ── 트랜스포트
  $('live-play')?.addEventListener('click', async () => {
    const { handlePlaybackToggle } = await import('./player.js');
    handlePlaybackToggle();
  });
  $('live-prev')?.addEventListener('click', async () => {
    const { handlePrevTrack } = await import('./player.js');
    handlePrevTrack();
  });
  $('live-next')?.addEventListener('click', async () => {
    const { handleNextTrack } = await import('./player.js');
    handleNextTrack();
  });

  // 파형 클릭 → 그 위치로 이동
  $('live-wave')?.addEventListener('click', async (e) => {
    const wrap = $('live-wave');
    const dur = state.trackDurationMs || 0;
    if (!wrap || dur <= 0) return;
    const rect = wrap.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const { seekTo } = await import('./audio.js');
    state.currentProgressMs = r * dur;
    seekTo(Math.floor(r * dur));
  });

  // ── 키 / 빠르기 / 가이드 보컬 (도크 슬라이더를 그대로 움직인다)
  $('live-key-down')?.addEventListener('click', () => stepSlider('pitch-slider', -1, {}));
  $('live-key-up')?.addEventListener('click', () => stepSlider('pitch-slider', +1, {}));
  $('live-key-val')?.addEventListener('click', () => driveSlider('pitch-slider', 0));

  $('live-tempo-down')?.addEventListener('click', () => stepSlider('tempo-slider', -0.05, { decimals: 2 }));
  $('live-tempo-up')?.addEventListener('click', () => stepSlider('tempo-slider', +0.05, { decimals: 2 }));
  $('live-tempo-val')?.addEventListener('click', () => driveSlider('tempo-slider', '1.00'));

  $('live-guide-down')?.addEventListener('click', () => stepSlider('vocal-balance', -10, {}));
  $('live-guide-up')?.addEventListener('click', () => stepSlider('vocal-balance', +10, {}));
  $('live-guide-val')?.addEventListener('click', () => driveSlider('vocal-balance', 0));

  // ── 볼륨 막대 (클릭한 지점 비율로 설정)
  const barRatio = (trackEl, e) => {
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  $('live-mr-track')?.addEventListener('click', async (e) => {
    const pct = Math.round(barRatio(e.currentTarget, e) * 100);
    localStorage.setItem(MR_FADER_KEY, String(pct));
    try {
      await invoke('set_track_fader', { track: 'inst', percent: pct });
    } catch (err) {
      console.error('[Live] set_track_fader failed:', err);
    }
    tick();
  });

  $('live-mon-track')?.addEventListener('click', (e) => {
    // 마스터 볼륨은 0~120 범위라 막대 100%가 120에 대응한다.
    const pct = Math.round(barRatio(e.currentTarget, e) * 120);
    driveSlider('master-volume-slider', pct);
    tick();
  });

  // ── 상단 바
  $('live-device')?.addEventListener('click', async () => {
    const { switchTab } = await import('./events/navigation.js');
    switchTab('settings');
    // 출력 장치는 설정 → 미디어·출력에 있다.
    document.querySelector('#settings-subtabs [data-scat="media"]')?.click();
  });

  $('live-open-overlay')?.addEventListener('click', async () => {
    const { switchTab } = await import('./events/navigation.js');
    switchTab('overlay');
  });

  $('live-ov-toggle')?.addEventListener('click', () => {
    // 오버레이 '상시 표시'는 설정 화면의 체크박스가 원본 — 그걸 그대로 토글한다.
    const box = $('toggle-overlay-force-visible');
    if (!box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    syncOverlayChip();
  });

  $('live-add-song')?.addEventListener('click', async () => {
    const { openAddSongModal } = await import('./ui/add-song-modal.js');
    openAddSongModal();
  });

  // 앱 시작 시 저장된 MR 페이더를 백엔드에 한 번 반영(재시작 후에도 유지되게).
  const mr = readMrFader();
  if (mr !== 100) {
    invoke('set_track_fader', { track: 'inst', percent: mr }).catch(() => {});
  }
}

/** 상단 '가사 화면' 칩을 오버레이 상시 표시 상태에 맞춘다. */
function syncOverlayChip() {
  const chip = $('live-ov-toggle');
  const text = $('live-ov-text');
  if (!chip || !text) return;
  const on = !!$('toggle-overlay-force-visible')?.checked;
  chip.classList.toggle('on', on);
  text.textContent = on ? '가사 화면 켜짐' : '가사 화면 꺼짐';
}

/** 상단 출력 장치 이름 — 설정에서 고른 값을 그대로 보여준다. */
async function syncDeviceChip() {
  const el = $('live-device-name');
  if (!el) return;
  try {
    const name = await invoke('get_output_device');
    el.textContent = name || '기본 장치';
  } catch (_) {
    el.textContent = '기본 장치';
  }
}

export function showLiveScreen() {
  initLiveScreen();
  syncOverlayChip();
  syncDeviceChip();
  renderLiveQueue();
  renderSeparation();
  tick();
  if (tickTimer) clearInterval(tickTimer);
  // 재생 위치·조절값을 주기적으로 따라간다(막대가 굵어 200ms로 충분).
  tickTimer = setInterval(() => {
    tick();
    renderSeparation();
  }, 200);
}

export function hideLiveScreen() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
