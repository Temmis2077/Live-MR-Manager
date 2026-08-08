/**
 * Shared utilities for OBS overlay HTML pages (non-module script)
 */
(function (global) {
  function hexToRgb(hex) {
    if (!hex) return "0,0,0";
    hex = String(hex).replace('#', '');
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    const r = parseInt(hex.substring(0, 2), 16) || 0;
    const g = parseInt(hex.substring(2, 4), 16) || 0;
    const b = parseInt(hex.substring(4, 6), 16) || 0;
    return `${r},${g},${b}`;
  }

  function connectWS(onMessage, port) {
    const wsPort = port || 14201;
    let host = global.location.hostname || 'localhost';
    // 앱 내부 창(Tauri는 tauri.localhost/asset 호스트로 페이지를 띄움)에서는
    // 오버레이 서버가 같은 PC에 있으므로 localhost로 붙는다. OBS/브라우저에서
    // http로 열었을 때는 그 호스트(LAN IP 포함)를 그대로 사용.
    if (!host || host === 'tauri.localhost' || host.endsWith('.localhost')) {
      host = 'localhost';
    }
    const socket = new WebSocket(`ws://${host}:${wsPort}`);
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (_) {
        /* ignore malformed payloads */
      }
    };
    socket.onclose = () => {
      setTimeout(() => connectWS(onMessage, wsPort), 2000);
    };
    return socket;
  }

  function readBool(data, snakeKey, camelKey) {
    if (data[snakeKey] === true || data[camelKey] === true) return true;
    return false;
  }

  function readStyleField(style, snakeKey, camelKey, fallback) {
    if (style[snakeKey] !== undefined) return style[snakeKey];
    if (style[camelKey] !== undefined) return style[camelKey];
    return fallback;
  }

  /**
   * 디자인 축(외곽선·그림자·그라디언트)을 CSS 변수로 푼다.
   * 두 오버레이 페이지가 같은 규칙을 쓰도록 여기 한 곳에만 둔다.
   *
   * 외곽선은 -webkit-text-stroke + paint-order: stroke fill 로 그린다.
   * 예전에는 text-shadow를 8방향으로 깔아 흉내 냈는데, 원을 8개 점으로만
   * 근사하는 셈이라 그 사이 각도에서 두께가 얇아져 굵을수록 톱니처럼 깎여
   * 보였다. text-stroke는 글자 외곽선을 실제 곡선으로 따므로 매끄럽고,
   * paint-order로 획을 채움 뒤에 그리면 안쪽을 깎지도 않는다.
   */
  function applyDesign(style, rootEl) {
    const root = rootEl || document.documentElement;
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const outlineW = num(readStyleField(style, 'outline_width', 'outlineWidth', 0), 0);
    const outlineC = String(readStyleField(style, 'outline_color', 'outlineColor', '000000')).replace('#', '');
    const shadow = num(readStyleField(style, 'shadow', 'shadow', 0), 0);

    // text-stroke는 획이 글자 경계 중앙에 걸려 절반만 바깥으로 나온다.
    // 설정한 두께가 눈에 보이는 두께가 되도록 두 배로 준다.
    root.style.setProperty('--overlay-stroke-width', outlineW > 0 ? `${outlineW * 2}px` : '0');
    root.style.setProperty('--overlay-stroke-color', `#${outlineC}`);

    // 그림자는 이제 순수하게 그림자만 담당한다(외곽선과 속성이 분리됐다).
    root.style.setProperty('--overlay-text-shadow',
      shadow > 0 ? `0 ${Math.round(shadow * 6)}px ${Math.round(shadow * 18)}px rgba(0,0,0,${shadow})` : 'none');
    root.style.setProperty('--overlay-card-shadow',
      shadow > 0 ? `0 ${Math.round(shadow * 20)}px ${Math.round(shadow * 55)}px rgba(0,0,0,${shadow * 0.85})` : 'none');

    // 그라디언트 — 끄면 기존 단색(--glass-bg)을 그대로 쓴다.
    const useGrad = readStyleField(style, 'gradient', 'gradient', false) === true;
    const gradC = String(readStyleField(style, 'gradient_color', 'gradientColor', '000000')).replace('#', '');
    const opacity = num(readStyleField(style, 'bg_opacity', 'bgOpacity', 0.6), 0.6);
    root.style.setProperty('--overlay-card-bg',
      useGrad
        ? `linear-gradient(135deg, var(--glass-bg), rgba(${hexToRgb(gradC)}, ${opacity}))`
        : 'var(--glass-bg)');
  }

  /**
   * 재생 위치 시계 — 100ms마다 오는 패킷 사이를 스스로 메운다.
   *
   * 앱은 position_ms를 100ms 간격으로 보낸다. 그걸 그대로 그리면 진행바도
   * 줄 안 진행도도 100ms 계단이 된다. 여기서는 패킷을 받은 시각을 기준으로
   * 흘려보내고, 새 패킷이 오면 맞춰 넣는다.
   *
   * 배속(tempo)은 오버레이가 모른다. 그래서 값을 받아오지 않고 연속한 두
   * 패킷의 (위치 증가 / 실제 경과)로 재생 속도를 직접 추정한다 — 배속을
   * 따로 전달할 필요가 없고, 배속이 바뀌어도 몇 패킷 안에 따라간다.
   *
   * 큰 차이(탐색·곡 전환)는 즉시 스냅하고, 작은 차이는 부드럽게 수렴시킨다.
   * 작은 차이까지 스냅하면 100ms마다 눈에 띄게 튄다.
   */
  function createPositionClock() {
    const SNAP_MS = 400;      // 이 이상 벌어지면 탐색으로 보고 즉시 맞춘다
    const CONVERGE = 0.12;    // 작은 오차를 프레임마다 이만큼씩 줄인다
    const RATE_SMOOTH = 0.25;

    let estimated = 0;
    let duration = 0;
    let playing = false;
    let rate = 1;
    let lastPacketPos = NaN;
    let lastPacketAt = 0;
    let lastTick = 0;
    let target = NaN;

    function update(positionMs, durationMs, isPlaying) {
      const pos = Number(positionMs) || 0;
      const wall = performance.now();
      if (Number.isFinite(durationMs) && durationMs > 0) duration = durationMs;

      // 재생 속도 추정 — 두 패킷 사이의 위치 증가 / 실제 경과.
      if (Number.isFinite(lastPacketPos) && isPlaying && playing) {
        const dWall = wall - lastPacketAt;
        const dPos = pos - lastPacketPos;
        if (dWall > 20 && dPos >= 0 && dPos < 5000) {
          const observed = dPos / dWall;
          if (observed > 0.2 && observed < 4) {
            rate = rate + (observed - rate) * RATE_SMOOTH;
          }
        }
      }
      lastPacketPos = pos;
      lastPacketAt = wall;

      const wasPlaying = playing;
      playing = !!isPlaying;

      // 멈춰 있거나, 크게 벌어졌거나, 방금 재생을 시작했으면 그냥 맞춘다.
      if (!playing || !wasPlaying || Math.abs(pos - estimated) > SNAP_MS) {
        estimated = pos;
        if (!playing) rate = 1;
      } else {
        target = pos;
      }
    }

    /** 지금 추정 위치(ms). rAF 루프에서 프레임마다 부른다. */
    function now() {
      const wall = performance.now();
      const dt = lastTick ? wall - lastTick : 0;
      lastTick = wall;

      if (playing && dt > 0 && dt < 500) {
        estimated += dt * rate;
        // 마지막 패킷 쪽으로 조금씩 당긴다(누적 드리프트 방지).
        if (Number.isFinite(target)) {
          const err = target + (wall - lastPacketAt) * rate - estimated;
          estimated += err * CONVERGE;
        }
      }
      if (duration > 0 && estimated > duration) estimated = duration;
      if (estimated < 0) estimated = 0;
      return estimated;
    }

    function getDuration() { return duration; }
    function isPlaying() { return playing; }

    return { update, now, getDuration, isPlaying };
  }

  /**
   * 한 줄 안에서 지금 어디까지 불렀는지 0~1.
   *
   * 이 규칙의 정본이다. 앱 쪽(alignment-metadata.js의 lineProgress)도 같은
   * 규칙을 쓰는데, 오버레이 페이지는 클래식 스크립트라 ES 모듈을 못 불러
   * 구현이 둘로 나뉜다. 두 구현이 어긋나면 앱 화면과 방송 화면의 진행도가
   * 달라지므로, tests/line-progress.test.js가 같은 표로 둘을 대조한다.
   *
   * @param {Array} words [단어, 시작ms, 끝ms] 배열. 비어 있으면 선형 보간.
   */
  function lineWipeRatio(words, startMs, endMs, posMs) {
    if (!(endMs > startMs)) return 0;
    if (!(posMs > startMs)) return 0;
    if (posMs >= endMs) return 1;

    if (Array.isArray(words) && words.length > 0) {
      // 글자 수로 가중치 — 단어 개수로 나누면 긴 단어가 순식간에 칠해진다.
      let total = 0;
      for (const w of words) total += Math.max(1, String(w[0] || '').length);
      let done = 0;
      for (const w of words) {
        const len = Math.max(1, String(w[0] || '').length);
        const ws = Number(w[1]) || 0;
        const we = Number(w[2]) || 0;
        if (posMs >= we) { done += len; continue; }
        // 단어 사이 빈 구간(숨 쉬는 자리)에서는 멈춘다 — 이어서 채우면 아직
        // 부르지 않은 글자가 미리 칠해진다.
        if (posMs <= ws) break;
        if (we > ws) done += len * ((posMs - ws) / (we - ws));
        break;
      }
      return Math.max(0, Math.min(1, done / total));
    }
    return Math.max(0, Math.min(1, (posMs - startMs) / (endMs - startMs)));
  }

  global.OverlayShared = {
    hexToRgb,
    connectWS,
    readBool,
    readStyleField,
    applyDesign,
    createPositionClock,
    lineWipeRatio,
  };
})(window);
