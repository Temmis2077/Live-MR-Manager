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
import { formatTime, getThumbnailUrl, showNotification } from './utils.js';
import { lineHtml, paintLiveLyricProgress } from './live-lyrics.js';
import { appendLiveHistory, buildPerformerLyricModel, isMrReady, moveQueueItem, resolveNextLiveQueuePath, takePreviousLivePath } from './live-performance.js';
import { pushLayer, popLayer } from './ui/layer-stack.js';
import { getSyncText } from './lrc-parser.js';
import { getLyricSyncStatus } from './library-filters.js';

const WAVE_BARS = 84;
/** 반주 ↔ 가이드 보컬 믹스(0 = 반주만, 100 = 보컬 100). 라이브가 값을 들고
 *  저장한다 — 음원 관리의 '보컬' 토글에 잠기지 않고 독립적으로 조작되어야 한다. */
const MIX_KEY = 'liveVocalMix';

let initialized = false;
let tickTimer = null;
let waveEls = [];
let waveSeedPath = null;
let waveLoadSequence = 0;
let waveHeights = [];
let waveDurationSec = 0;
let renderedMarkerKey = '';
let rawWavePoints = [];
let lastHealthFetch = 0;
let healthBusy = false;
let renderedKaraokeKey = '';
let detailedWaveWindow = { startSec: 0, endSec: 0 };

const CONTROLS_OPEN_KEY = 'liveControlsOpen';

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

export function reorderLiveQueue(fromIndex, toIndex) {
  const next = moveQueueItem(state.liveQueue, fromIndex, toIndex);
  if (next.join('\u0000') === (state.liveQueue || []).join('\u0000')) return false;
  state.liveQueue = next;
  saveQueue();
  renderLiveQueue();
  return true;
}

function summarizeWave(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  return Array.from({ length: Math.min(WAVE_BARS, points.length) }, (_, i) => {
    const start = Math.floor((i * points.length) / WAVE_BARS);
    const end = Math.max(start + 1, Math.floor(((i + 1) * points.length) / WAVE_BARS));
    let peak = 0;
    for (let j = start; j < end && j < points.length; j++) {
      const pair = points[j];
      const lo = Array.isArray(pair) ? Number(pair[0]) : 0;
      const hi = Array.isArray(pair) ? Number(pair[1]) : Number(pair);
      peak = Math.max(peak, Math.abs(lo) || 0, Math.abs(hi) || 0);
    }
    return Math.max(4, Math.min(100, Math.round(peak * 100)));
  });
}

function renderWave(heights, durationSec = 0) {
  const wrap = $('live-wave');
  if (!wrap) return;
  const markers = state.currentMarkers || {};
  const pct = (sec) => durationSec > 0
    ? Math.max(0, Math.min(100, (Number(sec) / durationSec) * 100))
    : 0;
  const regions = (markers.interludes || []).map((region) => {
    const left = pct(region.start);
    const width = Math.max(0, pct(region.end) - left);
    return `<div class="live-wave-region" style="left:${left}%;width:${width}%" title="전주/간주"></div>`;
  }).join('');
  const vocalStart = Number.isFinite(markers.vocalStartSec)
    ? `<div class="live-wave-vocal-start" style="left:${pct(markers.vocalStartSec)}%" title="보컬 시작"></div>`
    : '';
  const bars = heights
    .map((h) => `<div class="live-wave-bar" style="height:${Math.max(4, h)}%"></div>`)
    .join('');
  wrap.innerHTML = `${regions}${vocalStart}<div class="live-wave-bars">${bars}</div>`;
  waveEls = Array.from(wrap.querySelectorAll('.live-wave-bar'));
  renderedMarkerKey = JSON.stringify(markers);
}

function drawDetailedWaveform(positionSec) {
  const canvas = $('live-wave-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssWidth = Math.max(1, Math.round(rect.width));
  const cssHeight = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  if (!rawWavePoints.length || waveDurationSec <= 0) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || '#777';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('상세 파형 없음', cssWidth / 2, cssHeight / 2 + 4);
    return;
  }
  const before = 8;
  const after = 22;
  const startSec = Math.max(0, positionSec - before);
  const endSec = Math.min(waveDurationSec, positionSec + after);
  const range = Math.max(0.01, endSec - startSec);
  detailedWaveWindow = { startSec, endSec };
  const xAt = (sec) => ((sec - startSec) / range) * cssWidth;
  const rootStyle = getComputedStyle(document.documentElement);
  const color = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;

  // 초 단위 격자와 5초 라벨 — 진입까지 남은 거리를 눈금으로 읽을 수 있다.
  for (let sec = Math.ceil(startSec); sec <= endSec; sec++) {
    const x = xAt(sec);
    const major = sec % 5 === 0;
    ctx.strokeStyle = major ? 'rgba(148,163,184,.28)' : 'rgba(148,163,184,.1)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssHeight); ctx.stroke();
    if (major) {
      ctx.fillStyle = color('--text-dim', '#777');
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(formatTime(sec), x + 3, cssHeight - 5);
    }
  }

  // 확정된 전주·간주와 보컬 시작 마커.
  (state.currentMarkers?.interludes || []).forEach((region) => {
    if (region.end < startSec || region.start > endSec) return;
    const x1 = Math.max(0, xAt(region.start));
    const x2 = Math.min(cssWidth, xAt(region.end));
    ctx.fillStyle = 'rgba(245,158,11,.14)';
    ctx.fillRect(x1, 0, Math.max(0, x2 - x1), cssHeight);
    ctx.strokeStyle = 'rgba(245,158,11,.72)';
    ctx.strokeRect(x1, .5, Math.max(0, x2 - x1), cssHeight - 1);
  });

  // 현재 구간에 해당하는 실제 min/max 샘플을 세로선으로 그려 막대 요약보다
  // 작은 어택·쉼·보컬 진입 형태가 보존되게 한다.
  const firstPoint = Math.max(0, Math.floor((startSec / waveDurationSec) * rawWavePoints.length));
  const lastPoint = Math.min(rawWavePoints.length, Math.ceil((endSec / waveDurationSec) * rawWavePoints.length));
  const visiblePoints = Math.max(1, lastPoint - firstPoint);
  const centerY = cssHeight * .53;
  const ampHeight = cssHeight * .34;
  ctx.strokeStyle = color('--accent-secondary', '#8b5cf6');
  ctx.globalAlpha = .88;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < cssWidth; x++) {
    const a = firstPoint + Math.floor((x / cssWidth) * visiblePoints);
    const b = Math.min(lastPoint, firstPoint + Math.ceil(((x + 1) / cssWidth) * visiblePoints));
    let lo = 0;
    let hi = 0;
    for (let i = a; i < Math.max(a + 1, b); i++) {
      const pair = rawWavePoints[i] || [0, 0];
      lo = Math.min(lo, Number(pair[0]) || 0, Number(pair[1]) || 0);
      hi = Math.max(hi, Number(pair[0]) || 0, Number(pair[1]) || 0);
    }
    ctx.moveTo(x + .5, centerY - hi * ampHeight);
    ctx.lineTo(x + .5, centerY - lo * ampHeight);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 가사 구간을 상단 레인에 표시해 가사 싱크 화면과 같은 맥락을 제공한다.
  (state.currentLyrics || []).forEach((segment, index) => {
    const segStart = Number(segment.start) || 0;
    const segEnd = Number(segment.end) || segStart;
    if (segEnd < startSec || segStart > endSec || segEnd <= segStart) return;
    const x1 = Math.max(0, xAt(segStart));
    const x2 = Math.min(cssWidth, xAt(segEnd));
    ctx.fillStyle = index === state.currentLyricIndex ? 'rgba(139,92,246,.3)' : 'rgba(139,92,246,.12)';
    ctx.fillRect(x1, 1, Math.max(1, x2 - x1), 20);
    ctx.strokeStyle = index === state.currentLyricIndex ? color('--accent-secondary', '#8b5cf6') : 'rgba(139,92,246,.35)';
    ctx.strokeRect(x1, 1, Math.max(1, x2 - x1), 20);
    const label = String(getSyncText(segment) || '').trim();
    if (label && x2 - x1 > 34) {
      ctx.save(); ctx.beginPath(); ctx.rect(x1 + 3, 2, x2 - x1 - 6, 18); ctx.clip();
      ctx.fillStyle = color('--text-main', '#fff'); ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'left'; ctx.fillText(label, x1 + 5, 15); ctx.restore();
    }
  });

  const vocal = Number(state.currentMarkers?.vocalStartSec);
  if (Number.isFinite(vocal) && vocal >= startSec && vocal <= endSec) {
    const x = xAt(vocal);
    ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssHeight); ctx.stroke();
    ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 7, 0); ctx.lineTo(x, 8); ctx.fill();
  }

  const playX = xAt(positionSec);
  ctx.strokeStyle = color('--text-main', '#fff'); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, cssHeight); ctx.stroke();
  canvas.setAttribute('aria-valuenow', String(Math.round((positionSec / waveDurationSec) * 100)));
}

async function buildWave(path) {
  const sequence = ++waveLoadSequence;
  waveSeedPath = path;
  waveEls = [];
  const cue = $('live-wave-cue');
  if (!path) {
    waveHeights = [];
    waveDurationSec = 0;
    rawWavePoints = [];
    renderWave([]);
    if (cue) cue.textContent = '곡을 선택하면 실제 파형과 진입 구간을 표시합니다';
    return;
  }
  if (cue) cue.textContent = '실제 파형을 분석하고 있습니다';
  try {
    const summary = await invoke('get_waveform_summary', { audioPath: path });
    if (sequence !== waveLoadSequence || path !== state.currentTrack?.path) return;
    const durationSec = Number(summary?.duration_sec ?? summary?.durationSec) || (state.trackDurationMs / 1000);
    waveHeights = summarizeWave(summary?.points);
    rawWavePoints = Array.isArray(summary?.points) ? summary.points : [];
    waveDurationSec = durationSec;
    renderWave(waveHeights, waveDurationSec);
  } catch (err) {
    if (sequence !== waveLoadSequence) return;
    waveHeights = [];
    rawWavePoints = [];
    waveDurationSec = state.trackDurationMs / 1000;
    renderWave([], state.trackDurationMs / 1000);
    if (cue) cue.textContent = '실제 파형을 불러오지 못했습니다';
    console.warn('[Live] waveform unavailable:', err);
  }
}

function updateWaveCue(positionSec) {
  const cue = $('live-wave-cue');
  if (!cue) return;
  const markers = state.currentMarkers || {};
  const hasMarkers = (markers.vocalStartSec != null && Number.isFinite(Number(markers.vocalStartSec)))
    || (markers.interludes || []).length > 0;
  cue.classList.toggle('missing-marker', waveEls.length > 0 && !hasMarkers);
  const active = (markers.interludes || []).find((r) => positionSec >= r.start && positionSec < r.end);
  cue.classList.toggle('instrumental', !!active);
  cue.classList.remove('soon');
  if (active) {
    const left = Math.max(0, active.end - positionSec);
    cue.textContent = `${positionSec < (markers.vocalStartSec ?? -1) ? '전주' : '간주'} · ${Math.ceil(left)}초 남음`;
    return;
  }
  const vocalStart = Number(markers.vocalStartSec);
  if (Number.isFinite(vocalStart) && positionSec < vocalStart) {
    const left = vocalStart - positionSec;
    cue.classList.toggle('soon', left <= 10);
    cue.textContent = `보컬 진입까지 ${Math.ceil(left)}초`;
    return;
  }
  cue.textContent = waveEls.length
    ? (hasMarkers ? '실제 음원 파형 · 진입 마커 적용됨' : '실제 음원 파형 · 진입 마커 없음')
    : cue.textContent;
}

function renderPerformerView(positionSec) {
  const model = buildPerformerLyricModel(
    state.currentLyrics,
    state.currentLyricIndex,
    positionSec,
    state.currentMarkers,
  );
  const currentEl = $('live-current-lyric');
  const nextEl = $('live-next-lyric');
  const sectionEl = $('live-section-label');
  const countdownEl = $('live-entry-countdown');
  const timingEl = $('live-next-timing');

  if (currentEl) {
    if (!state.currentTrack) { currentEl.textContent = '곡을 선택하면 현재 가사가 표시됩니다'; renderedKaraokeKey = ''; }
    else if (!model.hasSyncedLyrics) { currentEl.textContent = '가사 싱크 없음'; renderedKaraokeKey = ''; }
    else if (model.sectionState.kind !== 'singing') { currentEl.textContent = model.sectionState.label; renderedKaraokeKey = ''; }
    else if (model.current) {
      const html = lineHtml(model.current);
      // 리드인과 가창은 같은 줄을 같은 자리에 그린다. 여기서 키를 나눠 두지
      // 않으면 부르기 시작하는 순간 내용이 같아 다시 그리지 않아도 되는데,
      // 상태 표시(.pending)만 어긋난 채 남는다.
      const key = `${model.pending ? 'pre' : 'sing'}|${html}`;
      if (renderedKaraokeKey !== key) {
        currentEl.innerHTML = `<span class="live-karaoke-base">${html}</span><span class="live-karaoke-fill" aria-hidden="true">${html}</span>`;
        renderedKaraokeKey = key;
      }
      currentEl.classList.toggle('pending', model.pending);
      currentEl.style.setProperty('--karaoke-progress', `${Math.round(model.progress * 1000) / 10}%`);
    } else { currentEl.textContent = '다음 가사 대기'; currentEl.classList.remove('pending'); renderedKaraokeKey = ''; }
  }
  if (nextEl) nextEl.innerHTML = model.next ? lineHtml(model.next) : '';
  if (sectionEl) {
    sectionEl.textContent = model.sectionState.label;
    sectionEl.dataset.kind = model.sectionState.kind;
  }
  if (countdownEl) {
    const remaining = model.sectionState.remainingSec;
    countdownEl.textContent = remaining == null ? '' : `${Math.ceil(remaining)}초`;
    countdownEl.classList.toggle('urgent', remaining != null && remaining <= 10);
  }
  if (timingEl) {
    // 리드인 중에는 "다음 줄이 언제인지"보다 "지금 이 줄을 언제 시작하는지"가
    // 부르는 사람에게 필요한 숫자다.
    if (model.pending && model.startsInSec != null) {
      timingEl.textContent = `${Math.ceil(model.startsInSec)}초 후 시작`;
    } else {
      timingEl.textContent = model.nextInSec != null && model.nextInSec > 0
        ? `다음 가사 ${Math.ceil(model.nextInSec)}초 후`
        : (model.hasSyncedLyrics ? '' : '가사 싱크 화면에서 타이밍을 준비하세요');
    }
  }
}

async function refreshLiveHealth() {
  if (healthBusy) return;
  healthBusy = true;
  try {
    const mix = await invoke('get_mix_state');
    const monLatency = Number(mix?.mon_est_latency_ms ?? mix?.monEstLatencyMs) || 0;
    const mrLatency = Number(mix?.mr_est_latency_ms ?? mix?.mrEstLatencyMs) || 0;
    const limiter = !!(mix?.limiter_enabled ?? mix?.limiterEnabled);
    const items = [];
    if (monLatency > 0) items.push({ text: `모니터 ${Math.round(monLatency)}ms`, warn: monLatency >= 80 });
    if (mrLatency > 0 && (mix?.mr_device ?? mix?.mrDevice)) items.push({ text: `MR ${Math.round(mrLatency)}ms`, warn: mrLatency >= 80 });
    items.push({ text: limiter ? '리미터 켜짐' : '리미터 꺼짐', warn: !limiter });
    const el = $('live-health');
    if (el) el.innerHTML = items.map((item) => `<span class="${item.warn ? 'warn' : ''}">${item.text}</span>`).join('');
  } catch (_) {
    const el = $('live-health');
    if (el) el.innerHTML = '<span class="warn">오디오 상태 확인 불가</span>';
  } finally {
    healthBusy = false;
  }
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
      ? [track.artist, track.genre].filter(Boolean).join(' · ') || '가수 미상'
      : '라이브러리에서 곡 선택';
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
    if (isMrReady(track)) {
      parts.push('<div class="live-badge">MR</div>');
    }
    const html = parts.join('');
    if (badges.innerHTML !== html) badges.innerHTML = html;
  }

  // 파형 — 곡이 바뀌면 다시 그리고, 재생 위치까지 색을 채운다
  const path = track ? track.path : '';
  if (path !== waveSeedPath) buildWave(path);
  const markerKey = JSON.stringify(state.currentMarkers || {});
  if (path === waveSeedPath && markerKey !== renderedMarkerKey) {
    renderWave(waveHeights, waveDurationSec || (state.trackDurationMs / 1000));
  }
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
  updateWaveCue(pos / 1000);
  drawDetailedWaveform(pos / 1000);
  renderPerformerView(pos / 1000);

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

  // 보컬 음원 on/off — 도크의 '보컬' 토글이 진실의 원본이다.
  const vocalOn = $('toggle-vocal')?.checked !== false;
  const vocalBtn = $('live-vocal-toggle');
  if (vocalBtn) {
    vocalBtn.classList.toggle('on', vocalOn);
    vocalBtn.setAttribute('aria-checked', vocalOn ? 'true' : 'false');
  }
  // 보컬이 꺼져 있으면 믹스 막대는 소리에 영향을 주지 않는다 — 흐리게 알린다.
  $('live-mix-track')?.classList.toggle('muted', !vocalOn);

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

  const summary = [
    ['live-summary-key', pitch > 0 ? `+${pitch}` : `${pitch}`, pitch !== 0],
    ['live-summary-tempo', `${tempoPct}`, tempoPct !== 100],
    ['live-summary-vocal', `${mix}`, !vocalOn || mix !== 0],
    ['live-summary-monitor', `${Math.round(mon)}`, mon !== 100],
  ];
  summary.forEach(([id, value, changed]) => {
    const el = $(id);
    const strong = el?.querySelector('strong');
    if (strong) strong.textContent = value;
    el?.classList.toggle('changed', changed);
    if (id === 'live-summary-vocal') el?.classList.toggle('muted', !vocalOn);
  });

  const now = Date.now();
  if (now - lastHealthFetch > 3000) {
    lastHealthFetch = now;
    refreshLiveHealth();
  }
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
  const curPath = state.currentTrack?.path;
  const curQueueIndex = queue.indexOf(curPath);
  const displayPaths = curQueueIndex >= 0
    ? [curPath, ...queue.slice(curQueueIndex + 1), ...queue.slice(0, curQueueIndex)]
    : (curPath ? [curPath, ...queue] : queue);
  const ordered = displayPaths.map((p) => byPath.get(p)).filter(Boolean);

  if (countEl) countEl.textContent = `${ordered.length}곡`;

  if (ordered.length === 0) {
    listEl.innerHTML = '<div class="live-q-empty">다음 곡이 비어 있습니다.<br>아래 대기열 버튼에서 곡을 담아 주세요.</div>';
    return;
  }

  const esc = (s) => {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  };

  listEl.innerHTML = ordered.slice(0, 40).map((t, i) => {
    const isCur = t.path === curPath;
    const ready = isMrReady(t);
    // 가사 상태는 앱 공용 판정을 쓴다. 예전에는 hasLyrics만 보고 상태를 정해
    // 싱크가 끝난 곡도 "가사 없음"으로 나왔고, 미싱크와 싱크 완료가 같은 라벨을
    // 달아 부를 때 따라오는지 아닌지를 구분할 수 없었다.
    const syncStatus = getLyricSyncStatus(t);
    const queueIndex = queue.indexOf(t.path);
    const processing = state.activeTasks?.[t.path];
    return `
      <div class="live-q-item${isCur ? ' current' : ''}" data-path="${esc(t.path)}"
           data-queue-index="${queueIndex}" tabindex="0">
        ${isCur ? '' : '<button type="button" class="live-q-drag-handle" data-q-drag aria-label="순서 끌어서 변경" title="끌어서 순서 변경">⠿</button>'}
        <div class="live-q-num">${isCur ? '▶' : i + 1}</div>
        <div class="live-q-body">
          <div class="live-q-title">${esc(t.title)}</div>
          <div class="live-q-sub">${esc(t.artist || '가수 미상')}</div>
          <div class="live-q-status">
            <span class="${ready ? 'ready' : 'warn'}">${ready ? 'MR' : '원곡'}</span>
            <span class="${syncStatus === 'synced' ? 'ready' : 'warn'}">${
              syncStatus === 'synced' ? '싱크' : (syncStatus === 'unsynced' ? '미싱크' : '가사 없음')
            }</span>
            ${processing ? `<span class="working">처리 ${Math.round(processing.percentage || 0)}%</span>` : ''}
          </div>
        </div>
        ${isCur ? '<div class="live-q-current-label">현재</div>' : `<div class="live-q-actions">
          <button type="button" data-q-action="play" aria-label="${esc(t.title)} 지금 재생">재생</button>
          <button type="button" data-q-action="next" aria-label="${esc(t.title)} 다음 곡으로 지정">다음</button>
          <button type="button" data-q-action="remove" aria-label="${esc(t.title)} 대기열에서 삭제">삭제</button>
        </div>`}
      </div>`;
  }).join('');

  listEl.querySelectorAll('.live-q-item').forEach((el) => {
    const queueIndex = () => Number.parseInt(el.dataset.queueIndex, 10);
    el.querySelector('[data-q-action="play"]')?.addEventListener('click', () => playLiveQueuePath(el.dataset.path));
    el.querySelector('[data-q-action="next"]')?.addEventListener('click', () => setAsNextLiveTrack(el.dataset.path));
    el.querySelector('[data-q-action="remove"]')?.addEventListener('click', () => removeFromLiveQueue(el.dataset.path));
    el.addEventListener('keydown', (event) => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const from = queueIndex();
      const to = Math.max(0, Math.min(queue.length - 1, from + (event.key === 'ArrowUp' ? -1 : 1)));
      reorderLiveQueue(from, to);
      listEl.querySelector(`[data-queue-index="${to}"]`)?.focus();
    });
  });

  // WebView의 HTML5 draggable은 행 안 버튼과 충돌해 dragstart가 자주 오지
  // 않는다. 전용 손잡이가 포인터를 캡처하고, 현재 포인터 아래 행을 직접 찾아
  // 마우스·펜·터치 모두 같은 경로로 순서를 바꾼다.
  listEl.querySelectorAll('[data-q-drag]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      const source = handle.closest('.live-q-item');
      const fromIndex = Number.parseInt(source?.dataset.queueIndex, 10);
      if (!source || !Number.isFinite(fromIndex)) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      source.classList.add('dragging');
      let targetIndex = fromIndex;
      let targetEl = source;

      const clearTarget = () => {
        listEl.querySelectorAll('.drag-target').forEach((item) => item.classList.remove('drag-target'));
      };
      const updateTarget = (clientX, clientY) => {
        const under = document.elementFromPoint(clientX, clientY)?.closest('.live-q-item');
        if (!under || !listEl.contains(under) || under === source) return;
        let candidate = Number.parseInt(under.dataset.queueIndex, 10);
        if (!Number.isFinite(candidate)) return;
        const currentIndex = (state.liveQueue || []).indexOf(state.currentTrack?.path);
        if (under.classList.contains('current') && currentIndex >= 0) candidate = Math.min(state.liveQueue.length - 1, currentIndex + 1);
        targetIndex = candidate;
        targetEl = under;
        clearTarget();
        under.classList.add('drag-target');
      };
      const move = (moveEvent) => updateTarget(moveEvent.clientX, moveEvent.clientY);
      const finish = (upEvent) => {
        // 일부 WebView/자동화 입력은 이동 중 pointermove를 생략하고 마지막
        // 좌표만 pointerup에 전달한다. 놓은 위치를 마지막으로 한 번 더 판정한다.
        updateTarget(upEvent.clientX, upEvent.clientY);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', cancel);
        try { handle.releasePointerCapture(upEvent.pointerId); } catch (_) {}
        source.classList.remove('dragging');
        clearTarget();
        if (targetEl !== source && targetIndex !== fromIndex) reorderLiveQueue(fromIndex, targetIndex);
      };
      const cancel = (cancelEvent) => {
        targetIndex = fromIndex;
        targetEl = source;
        finish(cancelEvent);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', cancel);
    });
  });
}

async function selectLiveTrack(path, { recordHistory = true } = {}) {
  const index = (state.songLibrary || []).findIndex((song) => song.path === path);
  if (index < 0) return false;
  const currentPath = state.currentTrack?.path;
  if (recordHistory && currentPath && currentPath !== path) {
    state.livePlaybackHistory = appendLiveHistory(state.livePlaybackHistory, currentPath, path);
  }
  const { selectTrack } = await import('./player.js');
  await selectTrack(index);
  renderLiveQueue();
  return true;
}

export async function playLiveQueuePath(path) {
  return selectLiveTrack(path);
}

export function setAsNextLiveTrack(path) {
  const queue = state.liveQueue || [];
  const from = queue.indexOf(path);
  if (from < 0 || path === state.currentTrack?.path) return false;
  const currentIndex = queue.indexOf(state.currentTrack?.path);
  let target = currentIndex >= 0 ? currentIndex + 1 : 0;
  if (from < target) target -= 1;
  const changed = reorderLiveQueue(from, target);
  if (changed) showNotification('다음 곡으로 지정했습니다.', 'success');
  return changed;
}

export async function playPreviousLiveTrack() {
  const available = new Set((state.songLibrary || []).map((song) => song.path));
  const result = takePreviousLivePath(state.livePlaybackHistory, available);
  state.livePlaybackHistory = result.history;
  return result.path ? selectLiveTrack(result.path, { recordHistory: false }) : false;
}

/** 라이브 대기열에서 현재 곡의 바로 다음 곡을 재생한다.
 * 현재 곡이 큐 밖이면 첫 대기곡을 시작한다. 완료한 현재 항목만 큐에서 뺀다. */
export async function playNextFromLiveQueue({ dropCurrentWithoutNext = false } = {}) {
  const queue = Array.isArray(state.liveQueue) ? state.liveQueue : [];
  const currentPath = state.currentTrack?.path;
  const currentQueueIndex = currentPath ? queue.indexOf(currentPath) : -1;
  const available = new Set((state.songLibrary || []).map((song) => song.path));
  const resolved = resolveNextLiveQueuePath(queue, currentPath, available);
  resolved.stalePaths.forEach((path) => removeFromLiveQueue(path));
  const nextPath = resolved.path;
  if (!nextPath) {
    // 자연 종료한 마지막 신청곡은 완료 처리한다. 수동 다음 버튼은 재생 중인
    // 마지막 곡을 큐에서 지우지 않도록 기본값을 false로 둔다.
    if (dropCurrentWithoutNext && currentQueueIndex >= 0) removeFromLiveQueue(currentPath);
    return false;
  }

  const libraryIndex = (state.songLibrary || []).findIndex((song) => song.path === nextPath);
  if (libraryIndex < 0) {
    removeFromLiveQueue(nextPath);
    return playNextFromLiveQueue();
  }
  if (currentQueueIndex >= 0) removeFromLiveQueue(currentPath);
  await selectLiveTrack(nextPath);
  renderLiveQueue();
  return true;
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
    if (!(await playPreviousLiveTrack())) showNotification('라이브 이전 곡 이력이 없습니다.', 'info');
  });
  $('live-next')?.addEventListener('click', async () => {
    const advanced = await playNextFromLiveQueue();
    if (!advanced) {
      showNotification('라이브 다음 곡 대기열이 비어 있습니다.', 'info');
    }
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

  const seekDetailedWave = async (clientX) => {
    const canvas = $('live-wave-canvas');
    if (!canvas || detailedWaveWindow.endSec <= detailedWaveWindow.startSec) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const sec = detailedWaveWindow.startSec + ratio * (detailedWaveWindow.endSec - detailedWaveWindow.startSec);
    const { seekTo } = await import('./audio.js');
    state.currentProgressMs = sec * 1000;
    seekTo(Math.floor(sec * 1000));
    tick();
  };
  $('live-wave-canvas')?.addEventListener('click', (event) => seekDetailedWave(event.clientX));
  $('live-wave-canvas')?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const sec = Math.max(0, Math.min((state.trackDurationMs || 0) / 1000, (state.currentProgressMs || 0) / 1000 + direction));
    const { left, width } = event.currentTarget.getBoundingClientRect();
    const ratio = (sec - detailedWaveWindow.startSec) / Math.max(.01, detailedWaveWindow.endSec - detailedWaveWindow.startSec);
    seekDetailedWave(left + Math.max(0, Math.min(1, ratio)) * width);
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

  // 요약 항목 → 조절 창에서 그 값을 만지는 컨트롤.
  // 요약 바에 따로 있던 '조절 펼치기' 버튼을 없앴다 — 키·속도·가이드·모니터
  // 항목 자체가 그 값을 여는 손잡이라, 여는 버튼이 하나 더 있을 이유가 없었다.
  const SUMMARY_TARGETS = {
    'live-summary-key': 'live-key-val',
    'live-summary-tempo': 'live-tempo-val',
    'live-summary-vocal': 'live-mix-track',
    'live-summary-monitor': 'live-mon-track',
  };

  /**
   * 지금 조절 창이 어느 항목의 것인가.
   *
   * 처음에는 창을 연 요약 항목만 기억했다. 그런데 '키'로 열어 놓고 창 안에서
   * 모니터를 만진 뒤 아래 '모니터'를 누르면, 방금 만지던 값인데도 닫히지 않고
   * 그 자리로 다시 옮겨가기만 했다. 창 안에서 만진 섹션이 곧 지금 항목이다.
   */
  let currentSummaryId = null;

  /** 아래 요약 바에서 지금 항목을 짚어 준다 — 어느 버튼이 닫는 버튼인지 보이게. */
  const markCurrentSummary = () => {
    Object.keys(SUMMARY_TARGETS).forEach((id) => {
      $(id)?.classList.toggle('is-current', id === currentSummaryId);
    });
  };

  const setCurrentSummary = (id) => {
    if (currentSummaryId === id) return;
    currentSummaryId = id;
    markCurrentSummary();
  };

  const setControlsOpen = (open, focusId = null) => {
    localStorage.setItem(CONTROLS_OPEN_KEY, open ? '1' : '0');
    const panel = $('live-controls-panel');
    if (panel) panel.hidden = !open;
    if (!open) setCurrentSummary(null);
    // 어느 항목을 눌러 열었든 네 항목 모두 같은 창을 가리키므로 상태를 함께 맞춘다.
    Object.keys(SUMMARY_TARGETS).forEach((id) => {
      $(id)?.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (open && focusId) {
      // 누른 항목의 컨트롤로 바로 데려간다 — 그래야 '모니터'를 누른 것과
      // '키'를 누른 것이 다른 의미를 갖는다.
      const target = $(focusId);
      if (target) {
        target.focus({ preventScroll: true });
        target.closest('.live-card')?.classList.add('just-opened');
        setTimeout(() => target.closest('.live-card')?.classList.remove('just-opened'), 900);
      }
    }
  };

  /** 요약 항목을 눌렀을 때 — 자기가 연 창이면 닫고, 아니면 열거나 그 컨트롤로 옮긴다. */
  const closeControls = () => {
    setControlsOpen(false);
    // 창을 닫으면 초점이 사라진 요소에 남지 않게 돌려놓는다.
    $('live-summary-key')?.focus({ preventScroll: true });
  };

  const toggleFromSummary = (id, focusId) => {
    const isOpen = $('live-controls-panel')?.hidden === false;
    if (isOpen && currentSummaryId === id) {
      // 지금 항목을 다시 누른 것 = 보고 있던 값을 덮겠다는 뜻.
      closeControls();
      $(id)?.focus({ preventScroll: true });
      return;
    }
    // 열려 있는데 다른 항목을 눌렀다면 닫을 이유가 없다 — 그 값으로 옮겨 준다.
    setCurrentSummary(id);
    setControlsOpen(true, focusId);
  };

  setControlsOpen(localStorage.getItem(CONTROLS_OPEN_KEY) === '1');

  Object.entries(SUMMARY_TARGETS).forEach(([id, focusId]) => {
    $(id)?.addEventListener('click', () => toggleFromSummary(id, focusId));
  });

  // 조절 창 안에서 만진 카드가 곧 지금 항목이 된다. 카드마다 컨트롤이 여럿이라
  // (버튼·슬라이더·토글) 하나씩 걸지 않고 창 전체에서 위임으로 받아 카드로 되짚는다.
  const cardToSummaryId = new Map();
  Object.entries(SUMMARY_TARGETS).forEach(([summaryId, controlId]) => {
    const card = $(controlId)?.closest('.live-card');
    if (card) cardToSummaryId.set(card, summaryId);
  });

  const trackTouchedCard = (event) => {
    const card = event.target?.closest?.('.live-card');
    const summaryId = card && cardToSummaryId.get(card);
    if (summaryId) setCurrentSummary(summaryId);
  };
  const controlsPanel = $('live-controls-panel');
  // pointerdown은 클릭·드래그, focusin은 Tab 이동, keydown/input/change는 실제
  // 값 조정을 잡는다. 한 가지만 걸면 놓치는 경로가 생긴다 — 슬라이더는 방향키로도
  // 움직이고, 초점 이벤트는 창이 활성 상태가 아니면 오지 않는다.
  ['pointerdown', 'focusin', 'keydown', 'input', 'change'].forEach((type) => {
    controlsPanel?.addEventListener(type, trackTouchedCard);
  });

  $('live-controls-close')?.addEventListener('click', closeControls);

  const setQueueDrawerOpen = (open) => {
    document.body.classList.toggle('live-queue-drawer-open', open);
    $('live-queue-drawer-toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  $('live-queue-drawer-toggle')?.addEventListener('click', () => {
    setQueueDrawerOpen(!document.body.classList.contains('live-queue-drawer-open'));
  });

  // ── 키 / 빠르기 / 가이드 보컬 (도크 슬라이더를 그대로 움직인다)
  $('live-key-down')?.addEventListener('click', () => stepSlider('pitch-slider', -1, {}));
  $('live-key-up')?.addEventListener('click', () => stepSlider('pitch-slider', +1, {}));
  $('live-key-val')?.addEventListener('click', () => driveSlider('pitch-slider', 0));

  // 보컬 음원 on/off — 도크의 '보컬' 체크박스를 그대로 움직인다.
  // 새 상태를 만들지 않아야 두 화면이 어긋나지 않는다.
  $('live-vocal-toggle')?.addEventListener('click', () => {
    const box = $('toggle-vocal');
    if (!box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    tick();
  });

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

  // 바깥 클릭으로 닫기 (ESC는 ui/layer-stack.js가 맡는다)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.live-device-wrap')) closeDeviceMenu();
  });

  document.addEventListener('keydown', async (event) => {
    if (state.activeView !== 'live') return;
    const target = event.target;
    const editing = target?.matches?.('input, textarea, select, [contenteditable="true"]');
    const modalOpen = !$('live-picker')?.hidden || !$('live-device-menu')?.hidden;
    if (editing || modalOpen || event.ctrlKey || event.metaKey || event.altKey) return;
    if (target?.closest?.('button, [role="slider"]') && event.key !== 'Escape') return;
    if (event.code === 'Space') {
      event.preventDefault();
      const { handlePlaybackToggle } = await import('./player.js');
      handlePlaybackToggle();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 5000 : -5000;
      const next = Math.max(0, Math.min(state.trackDurationMs || 0, (state.currentProgressMs || 0) + delta));
      const { seekTo } = await import('./audio.js');
      state.currentProgressMs = next;
      seekTo(Math.floor(next));
      tick();
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (!(await playNextFromLiveQueue())) showNotification('라이브 다음 곡 대기열이 비어 있습니다.', 'info');
    } else if (event.key.toLowerCase() === 'c') {
      event.preventDefault();
      setControlsOpen($('live-controls-panel')?.hidden !== false, 'live-key-val');
    } else if (event.key === 'Escape' && $('live-controls-panel')?.hidden === false) {
      // 떠 있는 창은 Esc로도 빠져나올 수 있어야 한다.
      event.preventDefault();
      setControlsOpen(false);
      $('live-summary-key')?.focus({ preventScroll: true });
    }
  });

  // ── 가사 타이밍 보정 — 값은 lyric-drawer.js가 들고 적용한다.
  const bumpOffset = async (delta) => {
    const m = await import('./lyric-drawer.js');
    const next = delta === 0 ? 0 : m.getLyricOffsetMs() + delta;
    m.setLyricOffsetMs(next);
    syncOffsetChip();
    // 설정 화면의 슬라이더도 같은 값으로 — 두 곳이 어긋나면 안 된다.
    const slider = $('lyric-offset-slider');
    if (slider) {
      slider.value = String(m.getLyricOffsetMs());
      const label = $('lyric-offset-val');
      const v = m.getLyricOffsetMs();
      if (label) label.textContent = `${v > 0 ? '+' : ''}${v} ms`;
    }
  };
  $('live-offset-down')?.addEventListener('click', () => bumpOffset(-50));
  $('live-offset-up')?.addEventListener('click', () => bumpOffset(+50));
  $('live-offset-val')?.addEventListener('click', () => bumpOffset(0));

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

  // 앱 시작 시 저장된 믹스를 백엔드에 한 번 반영(재시작 후에도 유지되게).
  const savedMix = readMix();
  if (savedMix !== 0) {
    invoke('set_vocal_balance', { balance: savedMix }).catch(() => {});
  }
}

/* ── 다음 곡 담기 패널 ──────────────────────────────────────
   라이브 중에 화면을 떠나지 않고 저장된 곡에서 골라 큐에 넣는다.
   이미 담긴 곡은 목록에 남되 '담김'으로 표시하고 다시 담지 않는다. */

let pickerLayer = null;

function openPicker() {
  const host = $('live-picker');
  if (!host) return;
  // 이미 열려 있으면 레이어를 또 올리지 않는다(앞 핸들을 잃고 스택에 남는다).
  if (!host.hidden) return;
  host.hidden = false;
  $('live-queue-add')?.setAttribute('aria-expanded', 'true');
  const input = $('live-picker-input');
  if (input) { input.value = ''; input.focus(); }
  renderPicker();
  // 초점은 위에서 검색창에 직접 준다(바로 타이핑할 수 있게) — 레이어는
  // Esc 처리와 닫은 뒤 초점 복귀만 맡는다.
  pickerLayer = pushLayer({ id: 'live-picker', el: host, close: closePicker, autoFocus: false });
}

function closePicker() {
  const host = $('live-picker');
  if (!host || host.hidden) return;
  host.hidden = true;
  $('live-queue-add')?.setAttribute('aria-expanded', 'false');
  popLayer(pickerLayer);
  pickerLayer = null;
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
    const ready = isMrReady(s);
    return `
      <button type="button" class="live-picker-item${already ? ' queued' : ''}"
              data-path="${esc(s.path)}"${already ? ' aria-disabled="true"' : ''}>
        <span class="live-picker-info">
          <span class="live-picker-name">${esc(s.title || '제목 없음')}</span>
          <span class="live-picker-meta">${esc(s.artist || '가수 미상')}${s.duration ? ' · ' + esc(s.duration) : ''}</span>
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

/** 상단 '가사 보정' 칩 — 지금 걸린 보정값을 보여준다. 0이면 조용히. */
async function syncOffsetChip() {
  const el = $('live-offset-val');
  if (!el) return;
  const { getLyricOffsetMs } = await import('./lyric-drawer.js');
  const v = getLyricOffsetMs();
  el.textContent = v === 0 ? '가사 0ms' : `가사 ${v > 0 ? '+' : ''}${v}ms`;
  el.classList.toggle('changed', v !== 0);
}

/** 상단 '가사 화면' 칩을 오버레이 상시 표시 상태에 맞춘다. */
function syncOverlayChip() {
  // 칩 갱신 로직은 ui/playback-sync.js 한 곳에만 둔다. 같은 표시를 두 파일이
  // 각자 그리면 한쪽만 고쳤을 때 조용히 어긋난다.
  import('./ui/playback-sync.js').then((m) => m.syncPlaybackUI()).catch(() => {});
}

/* ── 소리 보내는 곳 (출력 장치) ────────────────────────────
   라이브 중에는 설정 화면으로 보내지 않는다. 여기서 바로 고른다.
   백엔드는 설정 화면과 같은 것(list_output_devices / set_output_device)을
   쓰고, 바꾼 뒤에는 설정의 <select>도 맞춰 둔다 — 두 곳이 어긋나면 안 된다. */

let deviceBusy = false;

let deviceMenuLayer = null;

function closeDeviceMenu() {
  const menu = $('live-device-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('live-device')?.setAttribute('aria-expanded', 'false');
  popLayer(deviceMenuLayer);
  deviceMenuLayer = null;
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
  // 목록은 아래에서 비동기로 채워지므로 초점은 옮기지 않는다.
  deviceMenuLayer = pushLayer({
    id: 'live-device-menu', el: menu, close: closeDeviceMenu,
    trapFocus: false, autoFocus: false,
  });

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

  menu.innerHTML = `<div class="live-device-label">출력 장치</div>`
    + row('', '시스템 기본 장치', '', !anyActive)
    + devices.map((d) => row(d.name, d.name, d.config || '', !!d.isActive)).join('')
    + '';

  menu.querySelectorAll('[data-device]').forEach((item) => {
    item.addEventListener('click', () => selectDevice(item.dataset.device));
  });
  menu.querySelector('.live-device-item')?.focus();
}

async function selectDevice(name) {
  if (deviceBusy) return;
  deviceBusy = true;
  try {
    if (state.isPlaying) showNotification('재생 중 출력 장치를 전환합니다. 순간적으로 소리가 끊길 수 있습니다.', 'info');
    const resolved = await invoke('set_output_device', { name });
    closeDeviceMenu();
    const el = $('live-device-name');
    if (el) el.textContent = resolved || '기본 장치';
    // 설정 화면의 <select>도 같은 값으로 — 두 곳이 어긋나면 안 된다.
    import('./audio-devices.js').then((m) => m.refreshOutputDevices()).catch(() => {});
    const { showNotification } = await import('./utils.js');
    showNotification(`출력: ${resolved}`, 'success');
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
  syncOffsetChip();
  // 지금 곡의 가사를 패널에 즉시 반영 — 라이브에 들어온 순간부터 보여야 한다.
  import('./live-lyrics.js').then((m) => m.refreshLiveLyrics()).catch(() => {});
  renderLiveQueue();
  renderSeparation();
  tick();
  if (tickTimer) clearInterval(tickTimer);
  // 재생 위치·조절값을 주기적으로 따라간다(막대가 굵어 200ms로 충분).
  tickTimer = setInterval(() => {
    tick();
    renderSeparation();
  }, 200);

  // 가사 진행도만 따로 rAF로 돈다.
  //
  // 200ms 틱으로 칠하면 와이프가 초당 다섯 번만 움직여 뚝뚝 끊긴다. 진행도
  // 계산과 style 대입 두 번은 프레임마다 해도 싸다 — 무거운 갱신(파형·큐·
  // 분리 진행)만 200ms에 남긴다.
  startLyricProgressLoop();
}

let lyricRafId = null;

/**
 * 현재 줄의 진행도를 프레임마다 칠한다(중앙 큰 가사 + 오른쪽 패널).
 *
 * 위치는 state.currentProgressMs를 쓴다 — player.js가 tempo까지 반영해
 * 프레임 단위로 보간해 둔 값이라, 백엔드 폴링(100ms)의 계단이 없다.
 * 진행도 계산은 buildPerformerLyricModel → lineProgress 한 곳에서만 한다.
 */
function startLyricProgressLoop() {
  if (lyricRafId != null) return;
  const frame = () => {
    lyricRafId = requestAnimationFrame(frame);
    const curEl = document.getElementById('live-current-lyric');
    if (!curEl) return;

    const model = buildPerformerLyricModel(
      state.currentLyrics,
      state.currentLyricIndex,
      (state.currentProgressMs || 0) / 1000,
      state.currentMarkers,
    );
    if (!model.hasSyncedLyrics || model.sectionState.kind !== 'singing' || !model.current) return;

    const pct = `${(model.progress * 100).toFixed(2)}%`;
    if (curEl.style.getPropertyValue('--karaoke-progress') !== pct) {
      curEl.style.setProperty('--karaoke-progress', pct);
    }
    paintLiveLyricProgress(model.progress);
  };
  lyricRafId = requestAnimationFrame(frame);
}

function stopLyricProgressLoop() {
  if (lyricRafId == null) return;
  cancelAnimationFrame(lyricRafId);
  lyricRafId = null;
}

export function hideLiveScreen() {
  stopLyricProgressLoop();
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
