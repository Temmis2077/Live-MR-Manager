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

  global.OverlayShared = {
    hexToRgb,
    connectWS,
    readBool,
    readStyleField,
    applyDesign,
  };
})(window);
