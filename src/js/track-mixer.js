/**
 * 트랙 믹서 (개발용 최소 UI) — 보컬/MR 독립 페이더 + 음소거 + 솔로.
 *
 * 백엔드 set_track_fader / set_track_mute / set_track_solo와 연결. 최종 게인은
 * 볼륨·밸런스·페이더·음소거·솔로를 종합해 백엔드 recompute_mix가 계산한다.
 */
import { state } from './state.js';
import { audioDeviceService } from '../ipc/services/audio.js';
import { mixerService } from '../ipc/services/mixer.js';

// --- 탭 템포 ---
// 자동 탐지 BPM을 "평균의 시작점"으로 두고, 사용자가 두드린 간격으로 보정한다.
// 탭이 3회 이상 쌓이면 자동 탐지값을 버리고 순수 탭 평균으로 완전히 덮어쓴다
// (자동 탐지가 틀렸을 때 사용자가 오버라이드할 수 있게).
let tapTimes = [];
const TAP_RESET_MS = 2000; // 이 이상 쉬면 새로 시작
const MAX_TAPS = 8;

function autoDetectedBpm() {
  const b = Number(state.currentTrack?.bpm);
  return Number.isFinite(b) && b > 0 ? b : 0;
}

async function onTap() {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > TAP_RESET_MS) tapTimes = [];
  tapTimes.push(now);
  if (tapTimes.length > MAX_TAPS + 1) tapTimes.shift();

  const intervals = [];
  for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);

  const seed = autoDetectedBpm();
  const seedInterval = seed > 0 ? 60000 / seed : null;

  // 탭 간격이 3개 미만이면 자동 탐지값을 평균에 섞고, 충분히 쌓이면 순수 탭.
  let samples;
  if (intervals.length >= 3) {
    samples = intervals;
  } else if (seedInterval) {
    samples = [seedInterval, ...intervals];
  } else {
    samples = intervals;
  }
  if (!samples.length) return; // 첫 탭 & 시드 없음

  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  let bpm = Math.round(60000 / avg);
  bpm = Math.min(300, Math.max(30, bpm));

  const bpmInput = document.getElementById('metro-bpm');
  if (bpmInput) bpmInput.value = bpm;
  await pushMetronome();
}

function setFaderVal(track, pct) {
  const el = document.querySelector(`.track-fader-val[data-track="${track}"]`);
  if (el) el.textContent = `${Math.round(pct)}%`;
}

export async function refreshMixerState() {
  let s;
  try {
    s = await mixerService.getState();
  } catch (err) {
    return; // 오디오 핸들러 미초기화 등 — 조용히 무시
  }
  const map = {
    vocal: { fader: s.vocalFader, muted: s.vocalMuted, solo: s.vocalSolo },
    backing: { fader: s.backingFader, muted: s.backingMuted, solo: s.backingSolo },
    inst: { fader: s.instFader, muted: s.instMuted, solo: s.instSolo },
  };
  for (const track of ['vocal', 'backing', 'inst']) {
    const st = map[track];
    const fader = document.querySelector(`.track-fader[data-track="${track}"]`);
    if (fader) fader.value = st.fader;
    setFaderVal(track, st.fader);
    document.querySelector(`.track-mute[data-track="${track}"]`)?.classList.toggle('active', st.muted);
    document.querySelector(`.track-solo[data-track="${track}"]`)?.classList.toggle('active', st.solo);
  }
  const backingAvailable = s.backingAvailable === true;
  document.querySelectorAll('[data-mixer-track="backing"] input, [data-mixer-track="backing"] button, [data-source="backing"]').forEach((el) => {
    el.disabled = !backingAvailable;
    el.classList.toggle('disabled', !backingAvailable);
  });
  const backingStatus = document.getElementById('backing-track-status');
  if (backingStatus) backingStatus.textContent = backingAvailable
    ? '현재 곡의 화음/코러스 채널을 독립적으로 조절할 수 있습니다.'
    : '현재 곡에는 별도 화음/코러스 채널이 없습니다.';

  // 메트로놈
  const metroFader = document.querySelector('.track-fader[data-track="metro"]');
  if (metroFader) metroFader.value = s.metroGain;
  setFaderVal('metro', s.metroGain);
  document.querySelector('.metro-enable')?.classList.toggle('active', s.metroEnabled);
  const bpmInput = document.getElementById('metro-bpm');
  if (bpmInput) bpmInput.value = Math.round(s.metroBpm);

  // 라우팅 매트릭스
  const routes = {
    'monitor-vocal': s.monRouteVocal, 'monitor-inst': s.monRouteInst, 'monitor-metro': s.monRouteMetro,
    'monitor-backing': s.monRouteBacking,
    'mr-vocal': s.mrRouteVocal, 'mr-backing': s.mrRouteBacking, 'mr-inst': s.mrRouteInst, 'mr-metro': s.mrRouteMetro,
  };
  document.querySelectorAll('.route-cb').forEach((cb) => {
    cb.checked = !!routes[`${cb.dataset.channel}-${cb.dataset.source}`];
  });

  // 출력 리미터
  const lim = document.getElementById('limiter-enable');
  if (lim) lim.checked = s.limiterEnabled !== false;

  // 지연 보정 + 장치 추정
  const monDelay = document.getElementById('mon-delay-ms');
  if (monDelay) monDelay.value = Math.round(s.monDelayMs || 0);
  const mrDelay = document.getElementById('mr-delay-ms');
  if (mrDelay) mrDelay.value = Math.round(s.mrDelayMs || 0);
  const setEst = (bus, ms) => {
    const el = document.querySelector(`.bus-est-label[data-bus="${bus}"]`);
    if (el) el.textContent = ms > 0 ? `(장치 추정 ~${Math.round(ms)}ms)` : '';
  };
  setEst('monitor', s.monEstLatencyMs || 0);
  setEst('mr', s.mrEstLatencyMs || 0);

  // MR 채널 장치 목록
  const mrSel = document.getElementById('mr-output-device-select');
  if (mrSel) {
    let devices = [];
    try { devices = await audioDeviceService.listOutputDevices(); } catch (_) {}
    const esc = (x) => String(x).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const opts = ['<option value="">— MR 채널 끄기 —</option>'];
    for (const d of devices) {
      const label = d.config ? `${d.name} (${d.config})` : d.name;
      const sel = d.name === s.mrDevice ? ' selected' : '';
      opts.push(`<option value="${esc(d.name)}"${sel}>${esc(label)}</option>`);
    }
    mrSel.innerHTML = opts.join('');
    if (!s.mrDevice) mrSel.value = '';
  }
}

// 메트로놈 3개 값(활성/BPM/게인)을 한 번에 백엔드로 보낸다.
async function pushMetronome() {
  const enabled = document.querySelector('.metro-enable')?.classList.contains('active') || false;
  const bpm = parseFloat(document.getElementById('metro-bpm')?.value || '0');
  const gain = parseFloat(document.querySelector('.track-fader[data-track="metro"]')?.value || '80');
  try { await mixerService.setMetronome(enabled, bpm, gain); } catch (_) {}
}

export function initTrackMixer() {
  document.querySelectorAll('.track-fader').forEach((fader) => {
    fader.addEventListener('input', async () => {
      const track = fader.dataset.track;
      const pct = parseFloat(fader.value);
      setFaderVal(track, pct);
      // 메트로놈 페이더는 set_metronome로(게인만 갱신), 나머지는 set_track_fader.
      if (track === 'metro') { await pushMetronome(); return; }
      try { await mixerService.setTrackFader(track, pct); } catch (_) {}
    });
  });

  // 메트로놈 켜기/끄기 + BPM
  const metroBtn = document.querySelector('.metro-enable');
  if (metroBtn) {
    metroBtn.addEventListener('click', async () => {
      metroBtn.classList.toggle('active');
      metroBtn.textContent = metroBtn.classList.contains('active') ? '끄기' : '켜기';
      await pushMetronome();
    });
  }
  document.getElementById('metro-bpm')?.addEventListener('change', pushMetronome);
  document.querySelector('.metro-tap')?.addEventListener('click', onTap);

  // 버스 지연 보정
  const onDelay = (bus, inputId) => {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.addEventListener('change', async () => {
      const ms = Math.max(0, parseFloat(el.value) || 0);
      el.value = Math.round(ms);
      try { await mixerService.setBusDelay(bus, ms); } catch (_) {}
    });
  };
  onDelay('monitor', 'mon-delay-ms');
  onDelay('mr', 'mr-delay-ms');

  // 출력 리미터 토글
  document.getElementById('limiter-enable')?.addEventListener('change', async (e) => {
    try { await mixerService.setLimiter(e.target.checked); } catch (_) {}
  });

  // 라우팅 체크박스
  document.querySelectorAll('.route-cb').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await mixerService.setRoute(cb.dataset.channel, cb.dataset.source, cb.checked);
      } catch (_) {}
    });
  });

  // MR 채널 출력 장치
  const mrSel = document.getElementById('mr-output-device-select');
  if (mrSel) {
    mrSel.addEventListener('change', async () => {
      mrSel.disabled = true;
      try {
        const resolved = await audioDeviceService.setMrOutputDevice(mrSel.value);
        await notify(mrSel.value ? `MR 채널: ${resolved}` : 'MR 채널 꺼짐', 'success');
      } catch (err) {
        await notify('MR 채널 설정 실패: ' + err, 'error');
      } finally {
        mrSel.disabled = false;
      }
    });
  }

  document.querySelectorAll('.track-mute').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const track = btn.dataset.track;
      const muted = !btn.classList.contains('active');
      btn.classList.toggle('active', muted);
      try { await mixerService.setTrackMute(track, muted); } catch (_) {}
    });
  });

  document.querySelectorAll('.track-solo').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const track = btn.dataset.track;
      const soloed = !btn.classList.contains('active');
      btn.classList.toggle('active', soloed);
      try { await mixerService.setTrackSolo(track, soloed); } catch (_) {}
    });
  });
}
