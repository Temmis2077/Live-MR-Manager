/**
 * OBS overlay customization control listeners
 */
import { updateOverlayLyrics, updateOverlayStyle, getLanAddresses } from '../../overlay-api.js';
import { getLineVisibility, setLineVisibility } from '../../lrc-parser.js';
import { state } from '../../state.js';

const OVERLAY_LAN_PREF_KEY = 'overlay-use-lan-address';
let cachedLanAddress = null;
// 설정 미리보기 iframe에 캐시 무효화 쿼리를 붙인다 — WebView의 HTTP 캐시가
// overlay-info.html/overlay-lyrics.html의 이전 버전을 계속 재사용해, 파일을
// 고쳐도 인앱 미리보기가 갱신되지 않던 문제 대응(세션마다 새 값이라 매 실행
// 첫 로드는 항상 디스크의 최신 파일을 가져온다).
const OVERLAY_CACHE_BUST = Date.now();

/**
 * 오버레이 기본 스타일 3종 — 기존 조절값(크기·폰트·색·투명도·둥글기·방향)을
 * 한 번에 세팅한다. 새 CSS 변수는 만들지 않고 이미 있는 커스터마이징 축만
 * 조합해서 서로 다른 룩을 만든다(글래스=OBS 오버레이 표준형, 미니멀=박스 없이
 * 텍스트만 두는 최근 가사 영상 트렌드, 스테이지=굵고 선명한 클래식 노래방
 * 캡션). 적용 후에도 아래 세부 컨트롤로 얼마든지 더 다듬을 수 있다.
 */
/* 슬라이더 step(scale·투명도는 0.1 단위)에 정확히 맞춘 값만 쓴다 — 안 맞는
   값(예: 0.85, 1.15)은 브라우저가 프로그램적 할당에도 가까운 스텝으로
   조용히 스냅해, 프리셋이 실제로 뭘 저장할지 브라우저 구현에 기대게 된다. */
const OVERLAY_PRESETS = {
  glass: {
    scale: 1.0, font: 'Pretendard', color: '8b5cf6', textColor: 'ffffff',
    bgOpacity: 0.6, rounding: 20, bgColor: '0f0f14', animationDirection: 'left', fontSize: 22,
    effectFloat: true, effectGlow: false,
  },
  minimal: {
    scale: 1.0, font: 'Inter', color: 'a78bfa', textColor: 'ffffff',
    bgOpacity: 0.1, rounding: 10, bgColor: '000000', animationDirection: 'top', fontSize: 24,
    effectFloat: false, effectGlow: false,
  },
  stage: {
    scale: 1.2, font: 'SUITE', color: 'ec4899', textColor: 'ffffff',
    bgOpacity: 0.9, rounding: 30, bgColor: '1a0b2e', animationDirection: 'bottom', fontSize: 27,
    effectFloat: false, effectGlow: true,
  },
};

/** 커스텀 드롭다운(선택 텍스트 + option-item.selected + 숨은 input)을 값으로 맞춘다. */
function setDropdownValue(dropdownId, hiddenInputId, value) {
  const hidden = document.getElementById(hiddenInputId);
  if (hidden) hidden.value = value;
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  const selectedText = dropdown.querySelector('.selected-text');
  const options = dropdown.querySelectorAll('.option-item');
  options.forEach((opt) => {
    if (opt.dataset.value === value) {
      opt.classList.add('selected');
      if (selectedText) selectedText.textContent = opt.textContent;
    } else {
      opt.classList.remove('selected');
    }
  });
}

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
  const overlayEffectFloat = document.getElementById('overlay-effect-float');
  const overlayEffectGlow = document.getElementById('overlay-effect-glow');

  const resizeOverlayPreview = () => {
    if (!overlayIframe || !overlayPreviewWrapper) return;
    const activeTab = document.querySelector('.preview-tab.active');
    const mode = activeTab && activeTab.dataset.previewMode === 'lyrics' ? 'lyrics' : 'info';
    // overlay-info.html/overlay-lyrics.html의 PREVIEW_STAGE_WIDTH/HEIGHT와
    // 반드시 같은 값을 써야 미리보기 스케일 계산이 실제 렌더 크기와 맞는다.
    const baseWidth = 640;
    const baseHeight = mode === 'lyrics' ? 220 : 200;
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

  /** 표시 항목 체크박스를 백엔드가 받는 모양으로 읽는다. */
  const readVisibilityToggles = () => {
    const vis = {};
    document.querySelectorAll('.ov-vis-toggle').forEach((el) => {
      if (el.dataset.vis) vis[el.dataset.vis] = el.checked;
    });
    return vis;
  };

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
    const effectFloat = !!(overlayEffectFloat && overlayEffectFloat.checked);
    const effectGlow = !!(overlayEffectGlow && overlayEffectGlow.checked);

    // 화면에 보여줄 것 — 항목별 표시 토글. 대상(곡 정보/가사)에 해당하지 않는
    // 항목은 아래에서 행 자체를 숨기지만, 값은 그대로 보내 다른 탭의 설정이
    // 초기화되지 않게 한다.
    const visibility = readVisibilityToggles();
    document.querySelectorAll('#ov-vis-list .ov-vis-item').forEach((row) => {
      const scope = row.dataset.for;
      row.style.display = (scope === 'both' || scope === currentTarget) ? 'flex' : 'none';
    });

    if (!skipSave) {
          const saved = localStorage.getItem('overlay-settings');
          let config = {};
          try { config = JSON.parse(saved) || {}; } catch(e) {}

          // 이전 형식(info/lyrics 분리 저장) 마이그레이션: 분리된 키가 있으면 info 값을 우선 통합
          if (config.info || config.lyrics) {
            const migrated = config.info || config.lyrics || {};
            config = { ...migrated, isForceVisible: config.isForceVisible };
          }

          // 통합 설정 — info/lyrics 탭 구분 없이 하나의 값만 저장
          Object.assign(config, {
            scale, font, color, textColor, bgOpacity, rounding, bgColor, animationDirection, fontSize, effectFloat, effectGlow, visibility
          });
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
      overlayIframe.src = mode === 'lyrics'
        ? `overlay-lyrics.html?preview=true&cb=${OVERLAY_CACHE_BUST}`
        : `overlay-info.html?preview=true&cb=${OVERLAY_CACHE_BUST}`;
    }
    resizeOverlayPreview();

        // 통합 설정 — info/lyrics 양쪽에 동일한 스타일을 보낸다
        try {
          for (const target of ['info', 'lyrics']) {
            await updateOverlayStyle({
              target,
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
              fontSize,
              effectFloat,
              effectGlow,
              visibility
            });
          }
        } catch (err) {
          console.error("Failed to update overlay style:", err);
        }
      };

  /** 프리셋 버튼 클릭 시 폼 값을 한 번에 세팅하고 저장·미리보기까지 반영한다. */
  const applyPreset = (name) => {
    const preset = OVERLAY_PRESETS[name];
    if (!preset) return;

    if (overlayScale) overlayScale.value = preset.scale;
    if (overlayFont) overlayFont.value = preset.font;
    setDropdownValue('overlay-font-dropdown', 'overlay-font', preset.font);

    if (overlayColor) overlayColor.value = `#${preset.color}`;
    if (updateThemePalette) updateThemePalette(`#${preset.color}`);

    if (overlayTextColor) overlayTextColor.value = `#${preset.textColor}`;
    if (updateTextPalette) updateTextPalette(`#${preset.textColor}`);

    if (overlayBgColor) overlayBgColor.value = `#${preset.bgColor}`;
    if (updateBgPalette) updateBgPalette(`#${preset.bgColor}`);

    if (overlayBgOpacity) overlayBgOpacity.value = preset.bgOpacity;
    if (overlayRounding) overlayRounding.value = preset.rounding;

    if (overlayAnimationDirection) overlayAnimationDirection.value = preset.animationDirection;
    setDropdownValue('overlay-animation-direction-dropdown', 'overlay-animation-direction', preset.animationDirection);

    const fontSizeInput = document.getElementById('overlay-font-size');
    if (fontSizeInput) fontSizeInput.value = preset.fontSize;

    if (overlayEffectFloat) overlayEffectFloat.checked = !!preset.effectFloat;
    if (overlayEffectGlow) overlayEffectGlow.checked = !!preset.effectGlow;

    updateOverlaySettings();
  };

  document.querySelectorAll('.overlay-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  /** 기본값 복원 — 기준서 5: "기본값을 쉽게 복원할 수 있어야 합니다".
   *  오버레이 설정은 곡 정보/가사 구분 없이 하나로 저장되므로(통합 구조),
   *  스타일 값만 지우고 '상시 표시'처럼 스타일이 아닌 설정은 남긴다. */
  document.getElementById('btn-overlay-reset')?.addEventListener('click', async () => {
    if (!confirm('오버레이 디자인을 기본값으로 되돌릴까요?\n(색·크기·글씨체·애니메이션이 처음 상태로 돌아갑니다)')) return;

    const saved = localStorage.getItem('overlay-settings');
    let config = {};
    try { config = JSON.parse(saved) || {}; } catch (e) {}
    // 스타일 키만 제거 — isForceVisible 등 나머지는 사용자의 방송 상태라 보존.
    const styleKeys = ['scale', 'font', 'color', 'textColor', 'bgOpacity', 'rounding',
                       'bgColor', 'animationDirection', 'fontSize', 'effectFloat', 'effectGlow',
                       'info', 'lyrics'];
    styleKeys.forEach((k) => delete config[k]);
    localStorage.setItem('overlay-settings', JSON.stringify(config));

    // 저장본이 비었으므로 loadOverlaySettings가 defaults로 폼을 채우고,
    // 그 끝의 updateOverlaySettings가 미리보기·백엔드까지 반영한다.
    loadOverlaySettings();
    const { showNotification } = await import('../../utils.js');
    showNotification('오버레이 디자인을 기본값으로 되돌렸습니다.', 'success');
  });

  /** 지금 시청자에게 실제로 보이는 상태인지 표시.
   *  조건: '상시 표시'가 켜져 있거나, 곡이 재생 중이면 오버레이가 송출된다. */
  const syncLiveState = () => {
    const box = document.getElementById('overlay-live-state');
    const txt = document.getElementById('overlay-live-state-text');
    if (!box || !txt) return;
    const forced = !!toggleOverlayForceVisible?.checked;
    const playing = !!state.isPlaying;
    const on = forced || playing;
    box.dataset.on = on ? 'true' : 'false';
    txt.textContent = on
      ? (forced ? '시청자에게 보임 · 상시 표시' : '시청자에게 보임 · 재생 중')
      : '지금은 시청자에게 안 보임';
  };
  toggleOverlayForceVisible?.addEventListener('change', syncLiveState);
  syncLiveState();
  setInterval(syncLiveState, 1000);

  const previewTabs = document.querySelectorAll('.preview-tab');
  previewTabs.forEach(tab => {
      tab.onclick = async () => {
        previewTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const mode = tab.dataset.previewMode;
        const settingsTitle = document.getElementById('overlay-settings-title');
        if (settingsTitle) {
          // 통합 설정이므로 탭과 관계없이 동일한 "오버레이 설정" 표시
          settingsTitle.textContent = '오버레이 설정';
        }

        // 가사 폰트 크기 행 표시/숨김
        const fontSizeRow = document.getElementById('overlay-font-size-row');
        if (fontSizeRow) fontSizeRow.style.display = mode === 'lyrics' ? 'flex' : 'none';

        if (mode === 'lyrics') {
          overlayIframe.src = `overlay-lyrics.html?preview=true&cb=${OVERLAY_CACHE_BUST}`;
          await updateOverlayLyrics({
            current: "",
            next: "첫 번째 가사가 여기에 미리 표시됩니다."
          }).catch(err => console.error(err));
        } else {
          overlayIframe.src = `overlay-info.html?preview=true&cb=${OVERLAY_CACHE_BUST}`;
          await updateOverlayLyrics({ current: "", next: "" }).catch(err => console.error(err));
        }
        // 대상이 바뀌었으니 설정 UI도 다시 맞춘다 — 표시 항목 목록은 곡 정보
        // 전용/가사 전용 행이 나뉘어 있어, 이걸 안 부르면 이전 탭의 행이 남는다.
        updateOverlaySettings(true);
        requestAnimationFrame(resizeOverlayPreview);
      };
    });

  const loadOverlaySettings = () => {
      const saved = localStorage.getItem('overlay-settings');
      let config = {};
      try { config = JSON.parse(saved) || {}; } catch(e) {}

      // 이전 형식(info/lyrics 분리 저장) 마이그레이션: 분리된 키가 있으면 info 값을 우선 통합
      if (config.info || config.lyrics) {
        const migrated = config.info || config.lyrics || {};
        config = { ...migrated, isForceVisible: config.isForceVisible };
        localStorage.setItem('overlay-settings', JSON.stringify(config));
      }

      const defaults = {
        scale: 1.0,
        color: '8b5cf6',
        textColor: 'ffffff',
        bgOpacity: 0.6,
        rounding: 20,
        bgColor: '0f0f14',
        font: 'Inter',
        animationDirection: 'left',
        fontSize: 22,
        effectFloat: false,
        effectGlow: false
      };

      // 통합 설정 — 탭 구분 없이 하나의 값만 사용
      const settings = config;
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
      setDropdownValue('overlay-font-dropdown', 'overlay-font', final.font);
    }

    if (overlayAnimationDirection) {
      setDropdownValue('overlay-animation-direction-dropdown', 'overlay-animation-direction', final.animationDirection);
    }

    if (overlayEffectFloat) overlayEffectFloat.checked = !!final.effectFloat;
    if (overlayEffectGlow) overlayEffectGlow.checked = !!final.effectGlow;

    // 표시 항목 — 저장값이 없는 항목은 HTML의 기본 checked 상태를 그대로 둔다
    // (예전 사용자는 이 설정 자체가 없으므로 예전과 같은 화면이 되어야 한다).
    const savedVis = final.visibility || {};
    document.querySelectorAll('.ov-vis-toggle').forEach((el) => {
      const key = el.dataset.vis;
      if (key && savedVis[key] !== undefined) el.checked = savedVis[key] === true;
    });

    updateOverlaySettings(true);
  };

  const syncAllOverlayStylesToBackend = async () => {
      const saved = localStorage.getItem('overlay-settings');
      let config = {};
      try { config = JSON.parse(saved) || {}; } catch (e) {}

      // 이전 형식 마이그레이션
      if (config.info || config.lyrics) {
        const migrated = config.info || config.lyrics || {};
        config = { ...migrated, isForceVisible: config.isForceVisible };
      }

      const isForceVisible = config.isForceVisible === true;
      const themeMode = document.documentElement.getAttribute('data-theme') || 'dark';
      const targets = ['info', 'lyrics'];

      // 통합 설정 — info/lyrics 모두 같은 값으로 동기화
      const defaults = {
        scale: 1.0,
        color: '8b5cf6',
        textColor: 'ffffff',
        bgOpacity: 0.6,
        rounding: 20,
        bgColor: '0f0f14',
        font: 'Inter',
        animationDirection: 'left',
        fontSize: 22,
        effectFloat: false,
        effectGlow: false
      };
      const final = { ...defaults, ...config };

      for (const target of targets) {
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
            themeMode,
            fontSize: final.fontSize || 22,
            effectFloat: !!final.effectFloat,
            effectGlow: !!final.effectGlow,
            visibility: final.visibility
          });
        } catch (err) {
          console.error(`Failed to sync ${target} overlay style:`, err);
        }
      }
    };

  // 표시 항목 토글 — 바꾸면 바로 미리보기·방송에 반영된다
  document.querySelectorAll('.ov-vis-toggle').forEach((el) => {
    el.addEventListener('change', () => updateOverlaySettings());
  });

  [overlayScale, overlayBgOpacity, overlayRounding, toggleOverlayForceVisible, overlayEffectFloat, overlayEffectGlow].forEach(el => {
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
