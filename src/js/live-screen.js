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
 * 예외 — 반주↔가이드 보컬 믹스는 도크 입력을 거치지 않고 백엔드를 직접 부른다.
 * 도크의 '보컬' 토글이 꺼져 있으면 그 입력이 잠겨서, 라이브에서 믹스를 만질 수
 * 없었기 때문이다. 두 화면의 조작이 서로를 막아서는 안 된다.
 */
import { state } from './state.js';
import { invoke } from './tauri-bridge.js';
import { formatTime, getThumbnailUrl } from './utils.js';

const WAVE_BARS = 84;
/** 반주 ↔ 가이드 보컬 믹스(0 = 반주만, 100 = 보컬 100). 라이브가 값을 들고
 *  저장한다 — 음원 관리의 '보컬' 토글에 잠기지 않고 독립적으로 조작되어야 한다. */
const MIX_KEY = 'liveVocalMix';

let initialized = false;
let tickTimer = null;
let waveEls = [];
let waveSeedPath = null;

const $ = (id) => document.getElementById(id);

function saveQueue() {
  try { localStorage.setItem('liveQueue', JSON.stringify(state.liveQueue || [])); } catch (_) {}
}

/** 라이브 '다음 곡'에 담는다. 이미 있으면 중복으로 넣지 않는다. */
export function addToLiveQueue(path) {
  if (!path) return false;
  if (!Array.isArray(state.liveQueue)) state.liveQueue = [];
  if (state.liveQueue.includes(path)) return false;
  state.liveQueue.push(path);
  saveQueue();
  renderLiveQueue();
  return true;
}

export function removeFromLiveQueue(path) {
  if (!Array.isArray(state.liveQueue)) return;
  state.liveQueue = state.liveQueue.filter((p) => p !== path);
  saveQueue();
  renderLiveQueue();
}

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

  // 반주 ↔ 가이드 보컬 믹스 (0 = 반주만, 100 = 보컬 100)
  const savedMix = Number(localStorage.getItem(MIX_KEY));
  const mix = Number.isFinite(savedMix) ? Math.max(0, Math.min(100, savedMix)) : 0;
  const mixVal = $('live-mix-val');
  const mixFill = $('live-mix-fill');
  if (mixVal) mixVal.textContent = String(mix);
  if (mixFill) mixFill.style.width = `${mix}%`;
  $('live-mix-track')?.setAttribute('aria-valuenow', String(mix));

  const mon = parseFloat($('master-volume-slider')?.value ?? '100') || 0;
  const monVal = $('live-mon-val');
  const monFill = $('live-mon-fill');
  if (monVal) monVal.textContent = String(Math.round(mon));
  // 마스터 볼륨은 0~120이라 막대는 120 기준으로 채운다
  if (monFill) monFill.style.width = `${Math.min(100, (mon / 120) * 100)}%`;
  $('live-mon-track')?.setAttribute('aria-valuenow', String(Math.round(mon)));

  // 재생 위치도 스크린리더가 읽을 수 있게 퍼센트로 알린다.
  $('live-wave')?.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
}

/** 오른쪽 '다음 곡' 목록.
 *
 *  라이브러리 전체를 자동으로 밀어 넣지 않는다 — 방송에서 부를 곡은
 *  라이브러리에 있는 곡 전부가 아니라 그날 고른 몇 곡이다. 비어 있는 채로
 *  시작하고 사용자가 담는다(docs/UI_DESIGN_GUIDELINES.md).
 *  나중에 신청곡 연동으로 자동으로 붙는 것도 이 큐에 들어온다. */
export function renderLiveQueue() {
  const listEl = $('live-queue-list');
  const countEl = $('live-queue-count');
  if (!listEl) return;

  const queue = state.liveQueue || [];
  const byPath = new Map((state.songLibrary || []).map((s, i) => [s.path, { ...s, originalIndex: i }]));
  // 라이브러리에서 사라진 곡은 큐에서도 조용히 뺀다.
  const ordered = queue.map((p) => byPath.get(p)).filter(Boolean);

  const curPath = state.currentTrack?.path;

  if (countEl) countEl.textContent = `${ordered.length}곡`;

  if (ordered.length === 0) {
    listEl.innerHTML = '<div class="live-q-empty">다음 곡이 비어 있습니다.<br>음원 관리에서 곡을 골라 담아 주세요.</div>';
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
  const seekToRatio = async (r) => {
    const dur = state.trackDurationMs || 0;
    if (dur <= 0) return;
    const clamped = Math.max(0, Math.min(1, r));
    const { seekTo } = await import('./audio.js');
    state.currentProgressMs = clamped * dur;
    seekTo(Math.floor(clamped * dur));
    tick();
  };

  $('live-wave')?.addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekToRatio((e.clientX - rect.left) / rect.width);
  });

  // 키보드로도 이동 — 마우스 없이 핵심 조작이 가능해야 한다(기준서 7).
  $('live-wave')?.addEventListener('keydown', (e) => {
    const dur = state.trackDurationMs || 0;
    if (dur <= 0) return;
    const step = 5000 / dur; // 5초
    if (e.key === 'ArrowRight') { e.preventDefault(); seekToRatio((state.currentProgressMs / dur) + step); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekToRatio((state.currentProgressMs / dur) - step); }
    else if (e.key === 'Home') { e.preventDefault(); seekToRatio(0); }
  });

  // ── 키 / 빠르기 / 가이드 보컬 (도크 슬라이더를 그대로 움직인다)
  $('live-key-down')?.addEventListener('click', () => stepSlider('pitch-slider', -1, {}));
  $('live-key-up')?.addEventListener('click', () => stepSlider('pitch-slider', +1, {}));
  $('live-key-val')?.addEventListener('click', () => driveSlider('pitch-slider', 0));

  $('live-tempo-down')?.addEventListener('click', () => stepSlider('tempo-slider', -0.05, { decimals: 2 }));
  $('live-tempo-up')?.addEventListener('click', () => stepSlider('tempo-slider', +0.05, { decimals: 2 }));
  $('live-tempo-val')?.addEventListener('click', () => driveSlider('tempo-slider', '1.00'));

  // ── 반주 ↔ 가이드 보컬 믹스
  //
  // 예전에는 '가이드 보컬'(도크의 vocal-balance)과 '반주 소리'(inst 페이더)를
  // 따로 조절했다. 둘은 결국 같은 믹스의 양쪽 끝이라 하나의 막대로 합쳤다.
  //
  // 도크의 vocal-balance 입력을 거치지 않고 백엔드를 직접 부른다 — 예전에는
  // 음원 관리의 '보컬' 토글이 꺼져 있으면 그 입력이 잠겨서, 라이브에서
  // 믹스를 못 만졌다. 두 화면의 조작이 서로를 막지 않아야 한다.
  const readMix = () => {
    const saved = Number(localStorage.getItem(MIX_KEY));
    return Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 0;
  };

  const applyMix = async (pct) => {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    localStorage.setItem(MIX_KEY, String(v));
    try {
      await invoke('set_vocal_balance', { balance: v });
    } catch (err) {
      console.error('[Live] set_vocal_balance failed:', err);
    }
    // 음원 관리 쪽 표시도 같은 값으로 맞춘다(소리는 하나뿐이라 값은 공유한다).
    const dockInput = $('vocal-balance');
    if (dockInput) {
      dockInput.value = String(v);
      const label = $('vocal-balance-val');
      if (label) label.textContent = `${v}%`;
    }
    tick();
  };

  // ── 막대 조절 — 클릭뿐 아니라 끌어서도 바뀌게 (포인터 드래그)
  const barRatio = (trackEl, clientX) => {
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  /** 막대 하나를 드래그 가능한 슬라이더로 만든다. 키보드 조작은 그대로. */
  const makeDraggable = (trackEl, max, apply) => {
    if (!trackEl) return;
    let dragging = false;

    const setFrom = (clientX) => apply(barRatio(trackEl, clientX) * max);

    trackEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      dragging = true;
      // 포인터를 잡아 두면 막대 밖으로 나가도 계속 따라온다.
      trackEl.setPointerCapture(e.pointerId);
      trackEl.classList.add('dragging');
      setFrom(e.clientX);
      e.preventDefault();
    });

    trackEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setFrom(e.clientX);
    });

    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      trackEl.classList.remove('dragging');
      try { trackEl.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    trackEl.addEventListener('pointerup', stop);
    trackEl.addEventListener('pointercancel', stop);
  };

  makeDraggable($('live-mix-track'), 100, applyMix);
  $('live-mix-track')?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); applyMix(readMix() + 5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); applyMix(readMix() - 5); }
  });

  // 마스터 볼륨은 0~120 범위라 막대 100%가 120에 대응한다.
  const applyMon = (v) => {
    driveSlider('master-volume-slider', Math.max(0, Math.min(120, Math.round(v))));
    tick();
  };
  const curMon = () => parseFloat($('master-volume-slider')?.value ?? '100') || 0;

  makeDraggable($('live-mon-track'), 120, applyMon);
  $('live-mon-track')?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); applyMon(curMon() + 5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); applyMon(curMon() - 5); }
  });

  // ── 상단 바
  $('live-device')?.addEventListener('click', () => toggleDeviceMenu());

  // 바깥 클릭·ESC로 닫기
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.live-device-wrap')) closeDeviceMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDeviceMenu();
  });

  $('live-open-overlay')?.addEventListener('click', async () => {
    // 라이브를 떠나지 않는다 — 설정 UI를 라이브 위에 띄운다.
    const { openOverlayFloat } = await import('./ui/overlay-float.js');
    openOverlayFloat();
  });

  $('live-ov-toggle')?.addEventListener('click', () => {
    // 오버레이 '상시 표시'는 설정 화면의 체크박스가 원본 — 그걸 그대로 토글한다.
    const box = $('toggle-overlay-force-visible');
    if (!box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    syncOverlayChip();
  });

  // '다음 곡 담기' — 저장된 곡에서 골라 큐에 넣는다.
  // (새 곡을 받아오는 '노래 추가'는 상단 앱바에 따로 있다.)
  $('live-queue-add')?.addEventListener('click', () => openPicker());
  $('live-picker')?.querySelectorAll('[data-picker-close]').forEach((el) => {
    el.addEventListener('click', closePicker);
  });
  $('live-picker-input')?.addEventListener('input', renderPicker);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('live-picker')?.hidden) closePicker();
  });

  // 앱 시작 시 저장된 믹스를 백엔드에 한 번 반영(재시작 후에도 유지되게).
  const savedMix = readMix();
  if (savedMix !== 0) {
    invoke('set_vocal_balance', { balance: savedMix }).catch(() => {});
  }
}

/* ── 다음 곡 담기 패널 ──────────────────────────────────────
   라이브 중에 화면을 떠나지 않고 저장된 곡에서 골라 큐에 넣는다.
   이미 담긴 곡은 목록에 남되 '담김'으로 표시하고 다시 담지 않는다. */

function openPicker() {
  const host = $('live-picker');
  if (!host) return;
  host.hidden = false;
  $('live-queue-add')?.setAttribute('aria-expanded', 'true');
  const input = $('live-picker-input');
  if (input) { input.value = ''; input.focus(); }
  renderPicker();
}

function closePicker() {
  const host = $('live-picker');
  if (!host || host.hidden) return;
  host.hidden = true;
  $('live-queue-add')?.setAttribute('aria-expanded', 'false');
  $('live-queue-add')?.focus();
}

function renderPicker() {
  const listEl = $('live-picker-list');
  const footEl = $('live-picker-foot');
  if (!listEl) return;

  const q = ($('live-picker-input')?.value || '').toLowerCase().trim();
  const queued = new Set(state.liveQueue || []);
  const all = state.songLibrary || [];

  const hit = all.filter((s) => {
    if (!q) return true;
    return (s.title || '').toLowerCase().includes(q)
      || (s.artist || '').toLowerCase().includes(q)
      || (s.genre || '').toLowerCase().includes(q)
      || (s.tags || []).some((t) => String(t).toLowerCase().includes(q));
  });

  const esc = (v) => {
    const d = document.createElement('div');
    d.textContent = v || '';
    return d.innerHTML;
  };

  if (footEl) {
    footEl.textContent = all.length === 0
      ? '저장된 곡이 없습니다.'
      : `${hit.length}곡 / 전체 ${all.length}곡 · 담긴 곡 ${queued.size}곡`;
  }

  if (hit.length === 0) {
    listEl.innerHTML = `<div class="live-picker-empty">${all.length === 0
      ? '먼저 음원 관리에서 곡을 추가해 주세요.'
      : '검색 결과가 없습니다.'}</div>`;
    return;
  }

  listEl.innerHTML = hit.slice(0, 100).map((s) => {
    const already = queued.has(s.path);
    const ready = !!(s.isSeparated || s.is_separated || s.isMr || s.is_mr || s.mr_path);
    return `
      <button type="button" class="live-picker-item${already ? ' queued' : ''}"
              data-path="${esc(s.path)}"${already ? ' aria-disabled="true"' : ''}>
        <span class="live-picker-info">
          <span class="live-picker-name">${esc(s.title || '제목 없음')}</span>
          <span class="live-picker-meta">${esc(s.artist || '가수 정보 없음')}${s.duration ? ' · ' + esc(s.duration) : ''}</span>
        </span>
        <span class="live-picker-tags">
          ${ready ? '<span class="live-picker-chip on">MR</span>' : '<span class="live-picker-chip">원곡만</span>'}
          <span class="live-picker-add">${already ? '담김' : '담기'}</span>
        </span>
      </button>`;
  }).join('');

  listEl.querySelectorAll('[data-path]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      addToLiveQueue(btn.dataset.path);
      // 패널은 열어 둔다 — 보통 여러 곡을 이어서 담는다.
      renderPicker();
    });
  });
}

/** 상단 '가사 화면' 칩을 오버레이 상시 표시 상태에 맞춘다. */
function syncOverlayChip() {
  const chip = $('live-ov-toggle');
  const text = $('live-ov-text');
  if (!chip || !text) return;
  const on = !!$('toggle-overlay-force-visible')?.checked;
  chip.classList.toggle('on', on);
  chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  // 색만이 아니라 문구로도 상태를 알린다(기준서 3 · 7).
  text.textContent = on ? '가사 화면 켜짐' : '가사 화면 꺼짐';
}

/* ── 소리 보내는 곳 (출력 장치) ────────────────────────────
   라이브 중에는 설정 화면으로 보내지 않는다. 여기서 바로 고른다.
   백엔드는 설정 화면과 같은 것(list_output_devices / set_output_device)을
   쓰고, 바꾼 뒤에는 설정의 <select>도 맞춰 둔다 — 두 곳이 어긋나면 안 된다. */

let deviceBusy = false;

function closeDeviceMenu() {
  const menu = $('live-device-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('live-device')?.setAttribute('aria-expanded', 'false');
}

async function toggleDeviceMenu() {
  const menu = $('live-device-menu');
  const btn = $('live-device');
  if (!menu || !btn) return;
  if (!menu.hidden) {
    closeDeviceMenu();
    return;
  }

  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  menu.innerHTML = '<div class="live-device-empty">장치를 찾는 중…</div>';

  let devices = [];
  try {
    devices = await invoke('list_output_devices');
  } catch (err) {
    menu.innerHTML = '<div class="live-device-empty">장치 목록을 가져오지 못했습니다.</div>';
    return;
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const anyActive = devices.some((d) => d.isActive);
  const row = (name, label, sub, active) => `
    <button type="button" class="live-device-item${active ? ' active' : ''}" role="menuitem"
            data-device="${esc(name)}">
      <span class="live-device-check" aria-hidden="true">${active ? '✓' : ''}</span>
      <span class="live-device-text">
        <span class="live-device-name">${esc(label)}</span>
        ${sub ? `<span class="live-device-sub">${esc(sub)}</span>` : ''}
      </span>
    </button>`;

  menu.innerHTML = `<div class="live-device-label">소리 보내는 곳</div>`
    + row('', '시스템 기본 장치', '윈도우에서 고른 장치를 따라갑니다', !anyActive)
    + devices.map((d) => row(d.name, d.name, d.config || '', !!d.isActive)).join('')
    + `<div class="live-device-note">재생 중에도 바로 바뀝니다.</div>`;

  menu.querySelectorAll('[data-device]').forEach((item) => {
    item.addEventListener('click', () => selectDevice(item.dataset.device));
  });
  menu.querySelector('.live-device-item')?.focus();
}

async function selectDevice(name) {
  if (deviceBusy) return;
  deviceBusy = true;
  try {
    const resolved = await invoke('set_output_device', { name });
    closeDeviceMenu();
    const el = $('live-device-name');
    if (el) el.textContent = resolved || '기본 장치';
    // 설정 화면의 <select>도 같은 값으로 — 두 곳이 어긋나면 안 된다.
    import('./audio-devices.js').then((m) => m.refreshOutputDevices()).catch(() => {});
    const { showNotification } = await import('./utils.js');
    showNotification(`소리 보내는 곳: ${resolved}`, 'success');
  } catch (err) {
    const { showNotification } = await import('./utils.js');
    showNotification('장치를 바꾸지 못했습니다: ' + err, 'error');
    syncDeviceChip();
  } finally {
    deviceBusy = false;
  }
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
