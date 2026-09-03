/**
 * playback-sync.js — 재생 상태를 보여주는 모든 화면을 한 번에 맞춘다.
 *
 * 예전에는 화면마다 자기 리스너를 걸고 자기 위젯만 다시 그렸다. 상태(state)는
 * 공유되는데 그리는 일이 공유되지 않아서, 가사 싱크 편집기에서 재생을 눌러도
 * 도크·라이브의 버튼은 그대로 멈춤 모양으로 남았다.
 *
 * 그래서 "누가 바꿨든 바뀌면 전부 다시 그린다"로 뒤집는다. 새 상태를 만들지
 * 않고 전역 state만 읽어 각 화면에 반영한다 — 진실의 원본은 하나여야 한다.
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { brandIcon } from '../brand-icons.js';

/** 도크 하단 전송부 */
function syncDock() {
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.classList.toggle('is-playing', state.isPlaying);
    elements.togglePlayBtn.setAttribute('aria-label', state.isPlaying ? '일시정지' : '재생');
    elements.togglePlayBtn.setAttribute('aria-pressed', state.isPlaying ? 'true' : 'false');
  }
}

/** 라이브 화면의 큰 재생 버튼 (숨어 있으면 건너뛴다) */
function syncLive() {
  const btn = document.getElementById('live-play');
  if (btn) {
    btn.innerHTML = brandIcon(state.isPlaying ? 'pause' : 'play');
    btn.setAttribute('aria-label', state.isPlaying ? '일시정지' : '재생');
    btn.setAttribute('aria-pressed', state.isPlaying ? 'true' : 'false');
  }
}

/** 가사 싱크 편집기의 재생 버튼 */
function syncAlignment() {
  const btn = document.getElementById('play-btn');
  if (btn) {
    btn.innerHTML = brandIcon(state.isPlaying ? 'pause' : 'play');
    btn.setAttribute('aria-label', state.isPlaying ? '일시정지' : '재생');
    btn.setAttribute('aria-pressed', state.isPlaying ? 'true' : 'false');
    btn.title = state.isPlaying ? '일시정지 (Space)' : '재생 (Space)';
  }
  const status = document.getElementById('alignment-playback-status');
  if (status) {
    status.textContent = state.isPlaying ? '재생 중 · Space로 일시정지' : '일시정지 · Space로 재생';
    status.classList.toggle('playing', state.isPlaying);
  }
}

/**
 * 오버레이 설정의 "지금 시청자에게 보이는가" 표시.
 * 상시 표시가 켜져 있거나 재생 중이면 오버레이가 송출된다.
 *
 * 재생 상태에 딸린 표시인데 예전에는 1초 간격 폴링으로만 갱신돼, 재생을
 * 눌러도 최대 1초 동안 '송출 안 됨'으로 남아 있었다.
 */
export function syncOverlayLiveState() {
  const box = document.getElementById('overlay-live-state');
  const txt = document.getElementById('overlay-live-state-text');
  if (!box || !txt) return;

  const forced = !!document.getElementById('toggle-overlay-force-visible')?.checked;
  const on = forced || !!state.isPlaying;
  box.dataset.on = on ? 'true' : 'false';
  txt.textContent = on
    ? (forced ? '송출 중 · 상시 표시' : '송출 중 · 재생 중')
    : '송출 안 됨';
}

/** 라이브 상단의 오버레이 칩 — 상시 표시 설정과 같은 값을 본다. */
function syncLiveOverlayChip() {
  const chip = document.getElementById('live-ov-toggle');
  const text = document.getElementById('live-ov-text');
  if (!chip || !text) return;
  const on = !!document.getElementById('toggle-overlay-force-visible')?.checked;
  chip.classList.toggle('on', on);
  chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  text.textContent = on ? '오버레이 ON' : '오버레이 OFF';
}

/**
 * 재생 상태를 반영하는 화면을 전부 갱신한다.
 * 재생/일시정지가 바뀌는 모든 경로에서 이걸 부른다.
 */
export function syncPlaybackUI() {
  syncDock();
  syncLive();
  syncAlignment();
  syncOverlayLiveState();
  syncLiveOverlayChip();

  // 라이브러리 카드의 재생 표시(썸네일 오버레이·활성 행)도 같은 상태를 본다.
  import('./components.js')
    .then((m) => m.updateThumbnailOverlay?.())
    .catch(() => {});
}
