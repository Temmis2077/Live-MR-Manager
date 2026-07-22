/**
 * OBS overlay customization control listeners
 */
import { updateOverlayLyrics, updateOverlayStyle, getLanAddresses } from '../../overlay-api.js';
import { getLineVisibility, setLineVisibility } from '../../lrc-parser.js';

const OVERLAY_LAN_PREF_KEY = 'overlay-use-lan-address';
let cachedLanAddress = null;

export function initOverlayListeners() {
  const overlayScale = document.getElementById('overlay-scale');
  const overlayScaleVal = document.getElementById('overlay-scale-val');
  const overlayFont = document.getElementById('overlay-font');
  const overlayColor = document.getElementById('overlay-color');
  const overlayTextColor = document.getElementById('overlay-text-color');
  const overlayBgOpacity = document.getElementById('overlay-bg-opacity');
  const overlayBgOpacityVal = document.getElementById('overlay-bg-opacity-val');
  const overlayRounding = document.getElementById('overlay-rounding');
  const overlayRoundingVal = document.getElementById('overlay-rounding-val');
  const overlayBgColor = document.getElementById('overlay-bg-color');
  const overlayColorHex = document.getElementById('overlay-color-hex');
  const overlayTextColorHex = document.getElementById('overlay-text-color-hex');
  const overlayBgColorHex = document.getElementById('overlay-bg-color-hex');
  const overlayUrlDisplay = document.getElementById('overlay-url-display');
  const lyricsOverlayUrlDisplay = document.getElementById('lyrics-overlay-url-display');
  const overlayIframe = document.getElementById('overlay-iframe');
  const overlayPreviewWrapper = document.querySelector('.overlay-preview-wrapper');
  const toggleOverlayForceVisible = document.getElementById('toggle-overlay-force-visible');
  const overlayAnimationDirection = document.getElementById('overlay-animation-direction');
  const toggleOverlayLan = document.getElementById('toggle-overlay-lan');
  const overlayLanStatus = document.getElementById('overlay-lan-status');

  const resizeOverlayPreview = () => {
    if (!overlayIframe || !overlayPreviewWrapper) return;
    const activeTab = document.querySelector('.preview-tab.active');
    const mode = activeTab && activeTab.dataset.previewMode === 'lyrics' ? 'lyrics' : 'info';
    const baseWidth = mode === 'lyrics' ? 1200 : 1760;
    const baseHeight = mode === 'lyrics' ? 300 : 520;
    const wrapperWidth = Math.max(1, overlayPreviewWrapper.clientWidth - 28);
    const wrapperHeight = Math.max(1, overlayPreviewWrapper.clientHeight - 28);
    const scale = Math.min(wrapperWidth / baseWidth, wrapperHeight / baseHeight, 1);

    overlayIframe.style.width = `${baseWidth}px`;
    overlayIframe.style.height = `${baseHeight}px`;
    overlayIframe.style.position = 'absolute';
    overlayIframe.style.left = '50%';
    overlayIframe.style.top = '50%';
    overlayIframe.style.transform = `translate(-50%, -50%) scale(${scale})`;
    overlayIframe.style.transformOrigin = 'center center';
    overlayIframe.style.border = 'none';
    overlayIframe.style.background = 'transparent';
  };

  const setupPalette = (paletteId, colorInput, hexInput) => {
    const palette = document.getElementById(paletteId);
    if (!palette || !colorInput || !hexInput) return;

    const swatches = palette.querySelectorAll('.color-swatch');

    const updateSelection = (color) => {
      swatches.forEach(s => {
        if (s.dataset.color.toLowerCase() === color.toLowerCase()) {
          s.classList.add('selected');
        } else {
          s.classList.remove('selected');
        }
      });
      hexInput.value = color.replace('#', '').toLowerCase();
    };

    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        const color = swatch.dataset.color;
        colorInput.value = color;
        updateSelection(color);
        updateOverlaySettings();
      });
    });

    colorInput.addEventListener('input', () => {
      updateSelection(colorInput.value);
      updateOverlaySettings();
    });

    hexInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/[^0-9a-fA-F]/g, '');
      if (val.length === 6) {
        const color = `#${val}`;
        colorInput.value = color;
        updateSelection(color);
        updateOverlaySettings();
      }
    });

    return updateSelection;
  };

  const updateThemePalette = setupPalette('theme-palette', overlayColor, overlayColorHex);
  const updateTextPalette = setupPalette('text-palette', overlayTextColor, overlayTextColorHex);
  const updateBgPalette = setupPalette('bg-palette', overlayBgColor, overlayBgColorHex);

  const updateOverlaySettings = async (skipSave = false) => {
    if (!overlayScale || !overlayFont || !overlayColor || !overlayTextColor || !overlayUrlDisplay || !overlayIframe || !overlayBgOpacity || !overlayRounding || !overlayBgColor || !toggleOverlayForceVisible) return;

    const activeTab = document.querySelector('.preview-tab.active');
    const currentTarget = (activeTab && activeTab.dataset.previewMode === 'lyrics') ? 'lyrics' : 'info';

    const scale = parseFloat(overlayScale.value).toFixed(1);
    if (overlayScaleVal) overlayScaleVal.textContent = `${scale}x`;

    // 가사 폰트 크기 — 가사 오버레이 전용(곡 정보 탭에서는 행 자체를 숨김)
    const fontSizeRow = document.getElementById('overlay-font-size-row');
    const fontSizeInput = document.getElementById('overlay-font-size');
    const fontSizeVal = document.getElementById('overlay-font-size-val');
    if (fontSizeRow) fontSizeRow.style.display = currentTarget === 'lyrics' ? 'flex' : 'none';
    const fontSize = fontSizeInput ? parseInt(fontSizeInput.value, 10) || 22 : 22;
    if (fontSizeVal) fontSizeVal.textContent = `${fontSize}px`;

    const font = overlayFont.value;
    const color = overlayColor.value.replace('#', '');
    const textColor = overlayTextColor.value.replace('#', '');

    const bgOpacity = parseFloat(overlayBgOpacity.value);
    if (overlayBgOpacityVal) overlayBgOpacityVal.textContent = `${Math.round(bgOpacity * 100)}%`;

    const rounding = parseFloat(overlayRounding.value);
    if (overlayRoundingVal) overlayRoundingVal.textContent = `${rounding}px`;

    const bgColor = overlayBgColor.value.replace('#', '');
    const isForceVisible = toggleOverlayForceVisible.checked;
    const animationDirection = overlayAnimationDirection.value || 'left';
    const themeMode = document.documentElement.getAttribute('data-theme') || 'dark';

    if (!skipSave) {
      const saved = localStorage.getItem('overlay-settings');
      let config = {};
      try { config = JSON.parse(saved) || {}; } catch(e) {}

      config[currentTarget] = {
        scale, font, color, textColor, bgOpacity, rounding, bgColor, animationDirection, fontSize
      };
      config.isForceVisible = isForceVisible;

      localStorage.setItem('overlay-settings', JSON.stringify(config));
    }

    const useLan = !!(toggleOverlayLan && toggleOverlayLan.checked);
    const host = (useLan && cachedLanAddress) ? cachedLanAddress : 'localhost';
    const infoUrl = `http://${host}:14202/overlay-info`;
    const lyricsUrl = `http://${host}:14202/overlay-lyrics`;
    const lyricsViewUrl = `http://${host}:14202/lyrics-view`;
    if (overlayUrlDisplay) overlayUrlDisplay.textContent = infoUrl;
    if (lyricsOverlayUrlDisplay) lyricsOverlayUrlDisplay.textContent = lyricsUrl;
    const lyricsViewUrlDisplay = document.getElementById('lyrics-view-url-display');
    if (lyricsViewUrlDisplay) lyricsViewUrlDisplay.textContent = lyricsViewUrl;
    if (overlayLanStatus) {
      if (useLan && !cachedLanAddress) {
        overlayLanStatus.textContent = '이 PC의 네트워크 주소를 찾을 수 없습니다. localhost 주소가 표시됩니다.';
      } else if (useLan) {
        overlayLanStatus.textContent = `같은 Wi-Fi/네트워크의 다른 PC에서 이 주소로 접속할 수 있습니다: ${cachedLanAddress}`;
      } else {
        overlayLanStatus.textContent = '끄면 이 PC(localhost) 주소만 표시됩니다.';
      }
    }

    const setupCopyBtn = (id, text) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      // Reassigned on every call (not guarded to "once") since `text` closes
      // over the current infoUrl/lyricsUrl, which changes when the LAN toggle
      // flips — a one-time guard here would freeze the copy button on
      // whatever address was current the first time this ran.
      btn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          import('../../utils.js').then(m => m.showNotification("URL이 클립보드에 복사되었습니다.", "success"));
        } catch (err) { console.error("Failed to copy:", err); }
      };
    };
    setupCopyBtn('btn-copy-overlay-url', infoUrl);
    setupCopyBtn('btn-copy-lyrics-overlay-url', lyricsUrl);
    setupCopyBtn('btn-copy-lyrics-view-url', lyricsViewUrl);

    if (!overlayIframe.src.includes('preview=true')) {
      const mode = activeTab && activeTab.dataset.previewMode === 'lyrics' ? 'lyrics' : 'info';
      overlayIframe.src = mode === 'lyrics' ? `overlay-lyrics.html?preview=true` : `overlay-info.html?preview=true`;
    }
    resizeOverlayPreview();

    try {
      await updateOverlayStyle({
        target: currentTarget,
        scale: parseFloat(scale),
        font,
        color,
        textColor,
        bgColor,
        bgOpacity,
        rounding,
        isForceVisible,
        animationDirection,
        themeMode,
        fontSize
      });
    } catch (err) {
      console.error("Failed to update overlay style:", err);
    }
  };

  const previewTabs = document.querySelectorAll('.preview-tab');
  previewTabs.forEach(tab => {
    tab.onclick = async () => {
      previewTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const mode = tab.dataset.previewMode;
      const settingsTitle = document.getElementById('overlay-settings-title');
      if (settingsTitle) {
        settingsTitle.textContent = mode === 'lyrics' ? '가사 오버레이 설정' : '곡 정보 오버레이 설정';
      }

      loadOverlaySettings();

      if (mode === 'lyrics') {
        overlayIframe.src = `overlay-lyrics.html?preview=true`;
        await updateOverlayLyrics({
          current: "",
          next: "첫 번째 가사가 여기에 미리 표시됩니다."
        }).catch(err => console.error(err));
      } else {
        overlayIframe.src = `overlay-info.html?preview=true`;
        await updateOverlayLyrics({ current: "", next: "" }).catch(err => console.error(err));
      }
      requestAnimationFrame(resizeOverlayPreview);
    };
  });

  const loadOverlaySettings = () => {
    const saved = localStorage.getItem('overlay-settings');
    let config = {};
    try { config = JSON.parse(saved) || {}; } catch(e) {}

    const activeTab = document.querySelector('.preview-tab.active');
    const currentTarget = (activeTab && activeTab.dataset.previewMode === 'lyrics') ? 'lyrics' : 'info';

    const defaults = {
      scale: 1.0,
      color: currentTarget === 'lyrics' ? 'ffffff' : '8b5cf6',
      textColor: 'ffffff',
      bgOpacity: 0.6,
      rounding: 20,
      bgColor: '0f0f14',
      font: 'Inter',
      animationDirection: 'left',
      fontSize: 22
    };

    const settings = config[currentTarget] || {};
    const final = { ...defaults, ...settings };

    if (overlayScale) overlayScale.value = final.scale;
    if (overlayColor) {
      overlayColor.value = `#${final.color}`;
      const hexInput = document.getElementById('overlay-color-hex');
      if (hexInput) hexInput.value = final.color.replace('#', '');
      if (updateThemePalette) updateThemePalette(`#${final.color}`);
    }
    if (overlayTextColor) {
      overlayTextColor.value = `#${final.textColor}`;
      const textHexInput = document.getElementById('overlay-text-color-hex');
      if (textHexInput) textHexInput.value = final.textColor.replace('#', '');
      if (updateTextPalette) updateTextPalette(`#${final.textColor}`);
    }
    if (overlayBgOpacity) overlayBgOpacity.value = final.bgOpacity;
    if (overlayRounding) overlayRounding.value = final.rounding;
    const fontSizeInput = document.getElementById('overlay-font-size');
    if (fontSizeInput) fontSizeInput.value = final.fontSize || 22;
    if (overlayBgColor) {
      overlayBgColor.value = `#${final.bgColor}`;
      const bgHexInput = document.getElementById('overlay-bg-color-hex');
      if (bgHexInput) bgHexInput.value = final.bgColor.replace('#', '');
      if (updateBgPalette) updateBgPalette(`#${final.bgColor}`);
    }

    if (config.isForceVisible !== undefined) toggleOverlayForceVisible.checked = config.isForceVisible;

    if (overlayFont) {
      overlayFont.value = final.font;
      const dropdown = document.getElementById('overlay-font-dropdown');
      if (dropdown) {
        const selectedText = dropdown.querySelector('.selected-text');
        const options = dropdown.querySelectorAll('.option-item');
        options.forEach(opt => {
          if (opt.dataset.value === final.font) {
            opt.classList.add('selected');
            if (selectedText) selectedText.textContent = opt.textContent;
          } else {
            opt.classList.remove('selected');
          }
        });
      }
    }

    if (overlayAnimationDirection) {
      overlayAnimationDirection.value = final.animationDirection;
      const dropdown = document.getElementById('overlay-animation-direction-dropdown');
      if (dropdown) {
        const selectedText = dropdown.querySelector('.selected-text');
        const options = dropdown.querySelectorAll('.option-item');
        options.forEach(opt => {
          if (opt.dataset.value === final.animationDirection) {
            opt.classList.add('selected');
            if (selectedText) selectedText.textContent = opt.textContent;
          } else {
            opt.classList.remove('selected');
          }
        });
      }
    }

    updateOverlaySettings(true);
  };

  const syncAllOverlayStylesToBackend = async () => {
    const saved = localStorage.getItem('overlay-settings');
    let config = {};
    try { config = JSON.parse(saved) || {}; } catch (e) {}

    const isForceVisible = config.isForceVisible === true;
    const themeMode = document.documentElement.getAttribute('data-theme') || 'dark';
    const targets = ['info', 'lyrics'];

    for (const target of targets) {
      const defaults = {
        scale: 1.0,
        color: target === 'lyrics' ? 'ffffff' : '8b5cf6',
        textColor: 'ffffff',
        bgOpacity: 0.6,
        rounding: 20,
        bgColor: '0f0f14',
        font: 'Inter',
        animationDirection: 'left'
      };
      const targetSettings = config[target] || {};
      const final = { ...defaults, ...targetSettings };

      try {
        await updateOverlayStyle({
          target,
          scale: parseFloat(final.scale) || 1.0,
          font: final.font || 'Inter',
          color: String(final.color || defaults.color).replace('#', ''),
          textColor: String(final.textColor || defaults.textColor).replace('#', ''),
          bgColor: String(final.bgColor || defaults.bgColor).replace('#', ''),
          bgOpacity: Number.isFinite(final.bgOpacity) ? final.bgOpacity : defaults.bgOpacity,
          rounding: Number.isFinite(final.rounding) ? final.rounding : defaults.rounding,
          isForceVisible,
          animationDirection: final.animationDirection || 'left',
          themeMode
        });
      } catch (err) {
        console.error(`Failed to sync ${target} overlay style:`, err);
      }
    }
  };

  [overlayScale, overlayBgOpacity, overlayRounding, toggleOverlayForceVisible].forEach(el => {
    if (!el) return;
    el.addEventListener('change', () => updateOverlaySettings());
    if (el.type === 'range') {
      el.addEventListener('input', () => updateOverlaySettings());
    }
  });

  if (overlayScale) {
    overlayScale.addEventListener('input', () => updateOverlaySettings());
    overlayScale.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayScale.value);
      if (e.deltaY < 0) val += 0.1; else val -= 0.1;
      val = Math.max(parseFloat(overlayScale.min), Math.min(parseFloat(overlayScale.max), val));
      overlayScale.value = val.toFixed(1);
      overlayScale.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  const overlayFontSize = document.getElementById('overlay-font-size');
  if (overlayFontSize) {
    overlayFontSize.addEventListener('input', () => updateOverlaySettings());
    overlayFontSize.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(overlayFontSize.value, 10);
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(parseInt(overlayFontSize.min, 10), Math.min(parseInt(overlayFontSize.max, 10), val));
      overlayFontSize.value = val;
      overlayFontSize.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayFont) overlayFont.addEventListener('change', () => updateOverlaySettings());
  if (overlayColor) overlayColor.addEventListener('input', () => updateOverlaySettings());
  if (overlayTextColor) overlayTextColor.addEventListener('input', () => updateOverlaySettings());
  if (overlayBgOpacity) {
    overlayBgOpacity.addEventListener('input', () => updateOverlaySettings());
    overlayBgOpacity.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayBgOpacity.value);
      if (e.deltaY < 0) val += 0.1; else val -= 0.1;
      val = Math.max(parseFloat(overlayBgOpacity.min), Math.min(parseFloat(overlayBgOpacity.max), val));
      overlayBgOpacity.value = val.toFixed(1);
      overlayBgOpacity.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayRounding) {
    overlayRounding.addEventListener('input', () => updateOverlaySettings());
    overlayRounding.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayRounding.value);
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(parseFloat(overlayRounding.min), Math.min(parseFloat(overlayRounding.max), val));
      overlayRounding.value = val.toFixed(0);
      overlayRounding.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayBgColor) overlayBgColor.addEventListener('input', () => updateOverlaySettings());
  if (toggleOverlayForceVisible) toggleOverlayForceVisible.addEventListener('change', () => updateOverlaySettings());
  if (overlayAnimationDirection) overlayAnimationDirection.addEventListener('change', () => updateOverlaySettings());

  if (toggleOverlayLan) {
    toggleOverlayLan.checked = localStorage.getItem(OVERLAY_LAN_PREF_KEY) === 'true';
    toggleOverlayLan.addEventListener('change', () => {
      localStorage.setItem(OVERLAY_LAN_PREF_KEY, toggleOverlayLan.checked ? 'true' : 'false');
      updateOverlaySettings(true);
    });
  }

  getLanAddresses()
    .then((addresses) => {
      cachedLanAddress = (addresses && addresses[0]) || null;
      updateOverlaySettings(true);
    })
    .catch((err) => console.error('Failed to get LAN address:', err));

  // 3줄(원문/차음/번역) 모드 표시 항목 — 'app'(인앱 가사창)과 'overlay'(OBS)를
  // 독립적으로 설정. 두 스코프의 초기 체크 상태를 저장된 값으로 채우고,
  // 바뀔 때마다 해당 스코프에만 저장한다(lrc-parser.js::getLineVisibility).
  document.querySelectorAll('.lyric-line-visibility-toggle').forEach((box) => {
    const scope = box.dataset.scope;
    const field = box.dataset.field;
    if (!scope || !field) return;
    box.checked = !!getLineVisibility(scope)[field];
    box.addEventListener('change', () => {
      setLineVisibility(scope, field, box.checked);
    });
  });

  loadOverlaySettings();
  updateOverlaySettings(true);
  syncAllOverlayStylesToBackend();
  requestAnimationFrame(resizeOverlayPreview);
  window.addEventListener('resize', resizeOverlayPreview);

  return { syncAllOverlayStylesToBackend };
}
