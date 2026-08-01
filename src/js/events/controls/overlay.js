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
 * 오버레이 기본 스타일 — 모양(크기·폰트·색·투명도·둥글기·방향·효과)과
 * 표시 항목(카드·커버·라벨·가수·키/BPM·다음 줄)을 한 번에 세팅한다.
 *
 * 새 CSS 변수는 만들지 않고 이미 있는 커스터마이징 축만 조합해서 서로 다른
 * 룩을 만든다. 표시 항목까지 프리셋에 넣은 이유는, 실제로 "박스 없이 가사만"
 * 같은 룩은 색·투명도만으로는 안 되고 커버·라벨을 함께 꺼야 완성되기 때문이다.
 *
 * 적용 후에도 아래 세부 컨트롤로 얼마든지 더 다듬을 수 있다.
 *
 * 슬라이더 step(scale·투명도는 0.1 단위)에 정확히 맞춘 값만 쓴다 — 안 맞는
 * 값(예: 0.85, 1.15)은 브라우저가 프로그램적 할당에도 가까운 스텝으로
 * 조용히 스냅해, 프리셋이 실제로 뭘 저장할지 브라우저 구현에 기대게 된다.
 */
const ALL_ON = { card: true, cover: true, label: true, artist: true, keyBpm: false, nextLine: true };

const OVERLAY_PRESETS = {
  glass: {
    label: '글래스', desc: '투명 유리 카드 · 방송 기본형',
    scale: 1.0, font: 'Pretendard', color: '8b5cf6', textColor: 'ffffff',
    bgOpacity: 0.6, rounding: 20, bgColor: '0f0f14', animationDirection: 'left', fontSize: 22,
    effectFloat: true, effectGlow: false,
    visibility: { ...ALL_ON },
  },
  minimal: {
    label: '미니멀', desc: '박스 없이 텍스트만 · 담백하게',
    scale: 1.0, font: 'Inter', color: 'a78bfa', textColor: 'ffffff',
    bgOpacity: 0.1, rounding: 10, bgColor: '000000', animationDirection: 'top', fontSize: 24,
    effectFloat: false, effectGlow: false,
    // 카드를 끄면 라벨까지 남기는 건 지저분하다 — 제목·가수만 남긴다.
    visibility: { ...ALL_ON, card: false, label: false },
  },
  stage: {
    label: '스테이지', desc: '굵고 선명하게 · 노래방 감성',
    scale: 1.2, font: 'SUITE', color: 'ec4899', textColor: 'ffffff',
    bgOpacity: 0.9, rounding: 30, bgColor: '1a0b2e', animationDirection: 'bottom', fontSize: 27,
    effectFloat: false, effectGlow: true,
    visibility: { ...ALL_ON },
  },
  lyricsOnly: {
    label: '가사 집중', desc: '가사만 큼직하게 · 곡 정보는 최소',
    scale: 1.1, font: 'SUITE', color: 'ffffff', textColor: 'ffffff',
    bgOpacity: 0.0, rounding: 10, bgColor: '000000', animationDirection: 'top', fontSize: 30,
    effectFloat: false, effectGlow: false,
    // 화면을 가사에 내주는 프리셋 — 커버·라벨·가수·다음 줄을 모두 접는다.
    visibility: { card: false, cover: false, label: false, artist: false, keyBpm: false, nextLine: false },
  },
  titleOnly: {
    label: '제목만', desc: '커버·라벨 없이 곡 제목 한 줄',
    scale: 1.0, font: 'Pretendard', color: '8b5cf6', textColor: 'ffffff',
    bgOpacity: 0.5, rounding: 14, bgColor: '0f0f14', animationDirection: 'left', fontSize: 22,
    effectFloat: false, effectGlow: false,
    visibility: { card: true, cover: false, label: false, artist: false, keyBpm: false, nextLine: true },
  },
  practice: {
    label: '연습용', desc: '키·빠르기를 함께 표시 · 커버 연습에',
    scale: 1.0, font: 'Inter', color: '22c55e', textColor: 'ffffff',
    bgOpacity: 0.7, rounding: 12, bgColor: '0b1410', animationDirection: 'left', fontSize: 22,
    effectFloat: false, effectGlow: false,
    // 원곡과 다르게 부를 때 시청자에게 알려주는 용도.
    visibility: { ...ALL_ON, keyBpm: true },
  },
  neon: {
    label: '네온', desc: '진한 배경에 빛나는 글자 · 어두운 화면에',
    scale: 1.1, font: 'SUITE', color: '38bdf8', textColor: 'ffffff',
    bgOpacity: 0.8, rounding: 24, bgColor: '020617', animationDirection: 'bottom', fontSize: 26,
    effectFloat: true, effectGlow: true,
    visibility: { ...ALL_ON },
  },
  paper: {
    label: '페이퍼', desc: '밝은 카드에 검은 글자 · 밝은 화면에',
    scale: 1.0, font: 'Pretendard', color: '9a6b3f', textColor: '1a1a1a',
    bgOpacity: 0.9, rounding: 16, bgColor: 'f6f1e9', animationDirection: 'right', fontSize: 23,
    effectFloat: false, effectGlow: false,
    visibility: { ...ALL_ON },
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

          // 색·글씨체는 두 오버레이가 같은 톤을 유지해야 하므로 공용으로 둔다
          // (백엔드도 색은 대상 간에 맞춰 준다).
          Object.assign(config, {
            scale, font, color, textColor, bgOpacity, rounding, bgColor, animationDirection
          });
          config.isForceVisible = isForceVisible;

          // 대상별 설정 — 곡 정보와 가사는 화면에서 하는 일이 달라 효과·글자
          // 크기·표시 항목이 같을 이유가 없다. 예전에는 하나로 묶여 있어서
          // 가사에 글로우를 주면 곡 정보 카드까지 같이 빛났다.
          config.byTarget = config.byTarget || {};
          config.byTarget[currentTarget] = {
            ...(config.byTarget[currentTarget] || {}),
            fontSize, effectFloat, effectGlow, visibility,
          };

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

    // 표시 항목도 프리셋의 일부다 — "박스 없이 가사만" 같은 룩은 색·투명도만
    // 바꿔서는 안 되고 커버·라벨을 함께 꺼야 완성된다.
    if (preset.visibility) {
      document.querySelectorAll('.ov-vis-toggle').forEach((el) => {
        const key = el.dataset.vis;
        if (key && preset.visibility[key] !== undefined) {
          el.checked = preset.visibility[key] === true;
        }
      });
    }

    setDropdownValue('overlay-preset-dropdown', 'overlay-preset', name);
    // 어떤 프리셋에서 출발했는지 기억한다. 이후 세부 조정을 해도 라벨은
    // 그대로 두는데, 이 칸은 "시작점"이지 현재 상태의 요약이 아니기 때문이다
    // (라벨 자체가 "한 번에 적용, 이후 아래서 세부 조정 가능"이라고 알린다).
    try {
      const saved = JSON.parse(localStorage.getItem('overlay-settings') || '{}');
      saved.preset = name;
      localStorage.setItem('overlay-settings', JSON.stringify(saved));
    } catch (_) {}
    updateOverlaySettings();
  };

  // 프리셋 선택 — 드롭다운(커스텀 셀렉트)의 항목 클릭
  document.querySelectorAll('#overlay-preset-dropdown .option-item').forEach((opt) => {
    opt.addEventListener('click', () => applyPreset(opt.dataset.value));
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
                       'info', 'lyrics',
                       // 대상별(곡 정보/가사) 효과·글자 크기·표시 항목도 스타일이다.
                       'byTarget', 'visibility', 'preset'];
    styleKeys.forEach((k) => delete config[k]);
    localStorage.setItem('overlay-settings', JSON.stringify(config));

    // 저장본이 비었으므로 loadOverlaySettings가 defaults로 폼을 채우고,
    // 그 끝의 updateOverlaySettings가 미리보기·백엔드까지 반영한다.
    loadOverlaySettings();
    const { showNotification } = await import('../../utils.js');
    showNotification('오버레이 디자인을 기본값으로 되돌렸습니다.', 'success');
  });

  // 송출 여부 표시는 ui/playback-sync.js가 갖고 있다 — 재생 상태가 바뀌는
  // 모든 경로에서 함께 갱신되어야 하기 때문이다. 여기서는 '상시 표시'를
  // 껐다 켤 때만 알려 주면 된다(예전에는 1초 간격 폴링이라 재생을 눌러도
  // 최대 1초 동안 '송출 안 됨'으로 남아 있었다).
  const syncLiveState = () => {
    import('../../ui/playback-sync.js').then((m) => m.syncPlaybackUI()).catch(() => {});
  };
  toggleOverlayForceVisible?.addEventListener('change', syncLiveState);
  syncLiveState();

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
          // 미리보기에는 예시 문구를 채운다. 현재 줄이 비어 있으면 글자 크기·
          // 색·그림자를 아무것도 확인할 수 없어 설정을 눈으로 맞출 수 없다.
          // 실제 가사가 아닌 안내 문구를 쓴다.
          await updateOverlayLyrics({
            current: "지금 부르는 줄이 이렇게 보입니다",
            next: "다음 줄은 이렇게 흐리게 따라옵니다",
            index: 0,
          }).catch(err => console.error(err));
        } else {
          overlayIframe.src = `overlay-info.html?preview=true&cb=${OVERLAY_CACHE_BUST}`;
          await updateOverlayLyrics({ current: "", next: "" }).catch(err => console.error(err));
        }
        // 대상이 바뀌었으니 그 대상의 저장값을 다시 불러온다.
        // updateOverlaySettings를 바로 부르면 안 된다 — 그건 지금 UI 값을
        // 새 대상에 '쓰는' 동작이라, 이전 탭의 효과·표시 항목이 그대로
        // 옮겨 붙는다. 읽기(load)가 먼저고 쓰기는 그다음이다.
        loadOverlaySettings();
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

    // 효과·글자 크기·표시 항목은 대상별로 저장된다. 지금 보고 있는 탭의 값을
    // 읽되, 없으면 예전 통합 저장값(final)으로 넘어간다.
    const activeTabNow = document.querySelector('.preview-tab.active');
    const targetNow = (activeTabNow && activeTabNow.dataset.previewMode === 'lyrics') ? 'lyrics' : 'info';
    const perTarget = (config.byTarget && config.byTarget[targetNow]) || {};
    const effFloat = perTarget.effectFloat !== undefined ? perTarget.effectFloat : final.effectFloat;
    const effGlow = perTarget.effectGlow !== undefined ? perTarget.effectGlow : final.effectGlow;

    if (overlayEffectFloat) overlayEffectFloat.checked = !!effFloat;
    if (overlayEffectGlow) overlayEffectGlow.checked = !!effGlow;

    const fsInput = document.getElementById('overlay-font-size');
    if (fsInput && perTarget.fontSize) fsInput.value = perTarget.fontSize;

    if (config.preset && OVERLAY_PRESETS[config.preset]) {
      setDropdownValue('overlay-preset-dropdown', 'overlay-preset', config.preset);
    }

    // 표시 항목 — 저장값이 없는 항목은 HTML의 기본 checked 상태를 그대로 둔다
    // (예전 사용자는 이 설정 자체가 없으므로 예전과 같은 화면이 되어야 한다).
    const savedVis = perTarget.visibility || final.visibility || {};
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

      // 색·글씨체는 공용, 효과·글자 크기·표시 항목은 대상별.
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
        // 대상별 저장값이 있으면 그것을, 없으면 예전 통합값을 쓴다.
        const perTarget = (config.byTarget && config.byTarget[target]) || {};
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
            fontSize: perTarget.fontSize || final.fontSize || 22,
            effectFloat: perTarget.effectFloat !== undefined ? !!perTarget.effectFloat : !!final.effectFloat,
            effectGlow: perTarget.effectGlow !== undefined ? !!perTarget.effectGlow : !!final.effectGlow,
            visibility: perTarget.visibility || final.visibility
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
