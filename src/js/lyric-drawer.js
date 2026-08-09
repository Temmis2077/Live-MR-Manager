/**
 * src/js/lyric-drawer.js - Sliding Drawer UI Logic
 */
import { listen, invoke } from './tauri-bridge.js';
import { state } from './state.js';
import { registerAppHandler, callAppHandler } from './app-context.js';
import { getDisplayLines } from './lrc-parser.js';
import { findUpcomingIndex, resolveLineWindow } from './live-performance.js';

let lastOverlayCurrent = null;
let lastOverlayNext = null;

function updateDrawerTrackTitle() {
    const titleEl = document.getElementById('lyric-drawer-track-title');
    if (!titleEl) return;
    titleEl.textContent = state.currentTrack?.title || '선택된 곡 없음';
}

export function syncLyricDrawerHeader() {
    updateDrawerTrackTitle();
}

/**
 * 재생 위치 → 현재 줄 계산 → 오버레이·가사 뷰 푸시.
 *
 * 이 등록은 어떤 UI 크롬에도 기대면 안 된다. 예전에는 initLyricDrawer 안에서
 * `if (!trigger) return` 뒤에 있었는데, 화면 오른쪽 LYRICS 손잡이를 걷어내면서
 * trigger가 사라지자 함수가 즉시 빠져나가 이 리스너가 아예 등록되지 않았다.
 * 그 결과 재생 중 update_overlay_lyrics가 한 번도 호출되지 않아, 싱크를 아무리
 * 맞춰도 OBS 가사 오버레이와 가사 뷰가 현재 줄을 받지 못했다.
 */
let progressListenerBound = false;

/**
 * 가사 표시 보정(ms). 양수면 가사를 그만큼 **먼저** 띄운다.
 *
 * 출력 장치·OBS 캡처·모니터링 경로마다 실제 지연이 달라서, 코드로 한 값을
 * 정해 둘 수가 없다. 사용자가 자기 환경에 맞춰 맞추는 값이다.
 *
 * 적용은 여기 한 곳에서만 한다 — 오버레이와 라이브 가사 패널이 같은
 * syncLyricsWithTime을 통해 갈라지므로, 여기서 더하면 두 화면이 항상 같은
 * 시간을 본다. 화면마다 따로 더하면 어긋난다.
 */
export const LYRIC_OFFSET_KEY = 'lyricOffsetMs';
export const LYRIC_OFFSET_MAX = 500;

export function getLyricOffsetMs() {
    const raw = Number(localStorage.getItem(LYRIC_OFFSET_KEY));
    if (!Number.isFinite(raw)) return 0;
    return Math.max(-LYRIC_OFFSET_MAX, Math.min(LYRIC_OFFSET_MAX, Math.round(raw)));
}

export function setLyricOffsetMs(ms) {
    const v = Math.max(-LYRIC_OFFSET_MAX, Math.min(LYRIC_OFFSET_MAX, Math.round(Number(ms) || 0)));
    localStorage.setItem(LYRIC_OFFSET_KEY, String(v));
    // 멈춰 있어도 바꾼 값이 바로 보이게 마지막 위치로 다시 계산한다.
    if (Number.isFinite(lastPositionMs)) applyProgress(lastPositionMs, lastDurationMs);
    return v;
}

let lastPositionMs = NaN;
let lastDurationMs = 0;

/**
 * 재생 위치로 가사 줄 판정을 돌린다. player.js의 rAF 루프가 프레임마다 부른다.
 *
 * 백엔드 폴링(100ms)이 아니라 보간된 위치를 쓰는 이유는, 폴링 주기가 그대로
 * 줄 전환의 계단이 되기 때문이다. syncLyricsWithTime은 현재/다음 줄 텍스트가
 * 바뀔 때만 오버레이로 IPC를 보내므로(내부 dedupe) 60fps로 불러도 안전하다.
 */
export function syncLyricsAtPosition(positionMs) {
    if (!Number.isFinite(positionMs)) return;
    lastPositionMs = positionMs;
    // 보정은 가사 판정에만 쓴다. 진행바·시간 표시는 실제 재생 위치를 그대로
    // 보여줘야 한다 — 사용자가 보정을 걸었다고 남은 시간이 달라지면 안 된다.
    const shifted = positionMs + getLyricOffsetMs();
    syncLyricsWithTime(Math.max(0, shifted) / 1000);
}

function applyProgress(positionMs, durationMs) {
    lastDurationMs = durationMs;
    // 재생 중에는 rAF가 더 촘촘하게 줄 판정을 돌린다. 여기서는 멈춰 있을 때
    // (rAF 루프가 꺼진 상태)를 위해서만 한 번 돌린다 — seek 직후 정지 상태로
    // 가사가 갱신되지 않으면 화면이 이전 줄에 멈춰 있게 된다.
    if (!state.isPlaying) syncLyricsAtPosition(positionMs);
    else lastPositionMs = positionMs;

    // 오버레이 위치 패킷 — 오버레이가 이 값을 기준으로 스스로 보간한다.
    // 여기는 100ms 그대로 둔다(WS로 60fps를 보낼 이유가 없다).
    invoke('update_overlay_progress', { positionMs, durationMs }).catch(() => {});
}

export function bindLyricProgressListener() {
    if (progressListenerBound) return;
    progressListenerBound = true;
    listen('playback-progress', (event) => {
        const positionMs = event.payload.positionMs ?? event.payload.position_ms ?? 0;
        const durationMs = event.payload.durationMs ?? event.payload.duration_ms ?? 0;
        applyProgress(positionMs, durationMs);
    });
}

export function initLyricDrawer() {
    // 서랍 UI가 있든 없든 가사 송출은 살아 있어야 한다.
    bindLyricProgressListener();

    const trigger = document.getElementById('lyric-drawer-trigger');
    const closeBtn = document.getElementById('lyric-drawer-close');
    const drawer = document.getElementById('lyric-drawer');
    const controlsWrapper = document.querySelector('.page-controls-wrapper');
    const body = document.body;

    if (!trigger) return;

    const resizer = document.getElementById('lyric-drawer-resizer');
    let isResizing = false;
    let startX, startWidth;

    const minWidth = 230;
    const initialWidth = parseInt(localStorage.getItem('lyricDrawerWidth')) || 230;

    const updateDrawerWidthVars = (width) => {
        if (!drawer) return;
        document.documentElement.style.setProperty('--lyric-drawer-width', `${width}px`);
        // Subtract 30px (safe area) from reserved width.
        // This allows the drawer to overlap the grid's padding, effectively gaining 30px of space for cards.
        const reserved = Math.max(0, width - 30);
        document.documentElement.style.setProperty('--lyric-reserved-width', `${reserved}px`);
        localStorage.setItem('lyricDrawerWidth', width);
    };

    updateDrawerWidthVars(initialWidth);

    const updateDrawerBounds = () => {
        const titlebarHeight = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')
        ) || 38;

        let drawerTop = titlebarHeight + 120;

        if (controlsWrapper) {
            const wrapperRect = controlsWrapper.getBoundingClientRect();
            if (wrapperRect.height > 0) {
                drawerTop = Math.max(titlebarHeight, wrapperRect.bottom);
            }
        }

        document.documentElement.style.setProperty('--lyric-drawer-top', `${Math.round(drawerTop)}px`);
    };

    if (resizer) {
        resizer.onmousedown = (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = parseInt(getComputedStyle(drawer).width);
            body.style.cursor = 'ew-resize';
            body.classList.add('is-resizing');
            e.preventDefault();
        };

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const deltaX = startX - e.clientX;
            const newWidth = Math.max(minWidth, startWidth + deltaX);
            updateDrawerWidthVars(newWidth);
        });

        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                body.style.cursor = '';
                body.classList.remove('is-resizing');
            }
        });
    }

    const openDrawer = () => {
        body.classList.add('drawer-open');
        updateDrawerBounds();
        updateDrawerTrackTitle();

        // Sync with bottom toggle button if exists
        const toggle = document.getElementById('toggle-lyric');
        if (toggle && !toggle.checked) {
            toggle.checked = true;
            state.lyricsEnabled = true;
            localStorage.setItem("lyricsEnabled", true);
            // Notify audio engine that lyrics are enabled
            import('./audio.js').then(({ toggleAiFeature }) => {
                toggleAiFeature("lyric", true);
            });
        }
    };

    const closeDrawer = () => {
        body.classList.remove('drawer-open');
        updateDrawerBounds();

        // Sync with bottom toggle button if exists
        const toggle = document.getElementById('toggle-lyric');
        if (toggle && toggle.checked) {
            toggle.checked = false;
            state.lyricsEnabled = false;
            localStorage.setItem("lyricsEnabled", false);
            // Notify audio engine that lyrics are disabled
            import('./audio.js').then(({ toggleAiFeature }) => {
                toggleAiFeature("lyric", false);
            });
        }
    };

    const toggleDrawer = () => {
        if (body.classList.contains('drawer-open')) {
            closeDrawer();
        } else {
            openDrawer();
        }
    };

    trigger.onclick = toggleDrawer;

    if (closeBtn) {
        closeBtn.onclick = closeDrawer;
    }

    registerAppHandler('openLyricDrawer', openDrawer);
    registerAppHandler('closeLyricDrawer', closeDrawer);

    const goToLyricSyncForCurrentTrack = async () => {
        const currentPath = state.currentTrack?.path;
        if (!currentPath) {
            callAppHandler('switchToTab', 'alignment');
            return;
        }
        try {
            const nav = await import('./events/navigation.js');
            if (typeof nav.openAlignmentForTrack === 'function') {
                await nav.openAlignmentForTrack(currentPath, { forceLoad: true });
            } else {
                callAppHandler('switchToTab', 'alignment');
            }
        } catch (err) {
            console.error('[LyricDrawer] Failed to open alignment for current track:', err);
            callAppHandler('switchToTab', 'alignment');
        }
    };
    registerAppHandler('goToLyricSyncForCurrentTrack', goToLyricSyncForCurrentTrack);

    // Esc로 드로어 닫기.
    //
    // 드로어는 모달이 아니라 오래 열어 두는 옆 패널이라 layer-stack에 올리지
    // 않는다(올리면 열려 있는 내내 화면 단축키가 막힌다). 대신 위에 뜬 것이
    // 있으면 그쪽에 Esc를 양보한다 — 모달을 닫으려다 드로어까지 닫히면 곤란하다.
    window.addEventListener('keydown', async (e) => {
        if (e.key !== 'Escape' || !body.classList.contains('drawer-open')) return;
        const { hasOpenLayer } = await import('./ui/layer-stack.js');
        if (hasOpenLayer()) return;
        body.classList.remove('drawer-open');
        updateDrawerBounds();
    });

    window.addEventListener('resize', updateDrawerBounds);
    window.addEventListener('scroll', updateDrawerBounds, { passive: true });
    updateDrawerBounds();
    updateDrawerTrackTitle();

    // 재생 위치 리스너는 함수 맨 위 bindLyricProgressListener()가 이미 걸었다.
    console.log('[LyricDrawer] Initialized');
}

/**
 * Updates the drawer content with new segments
 * @param {Array} segments 
 */
export function updateLyrics(segments) {
    state.currentLyricIndex = -1;

    // 가사 뷰 페이지(/lyrics-view, OBS 독)용 전체 가사 목록 푸시.
    // 인앱 표시 설정('app' 스코프)을 따라 원문/차음/번역 노출을 결정.
    // 이 푸시는 서랍 DOM 유무보다 먼저다 — 방송에 나가는 것이 인앱 위젯의
    // 존재 여부에 좌우되면 안 된다(예전에 그래서 연결이 끊겼다).
    invoke('update_overlay_lyrics_full', {
        lines: (segments || []).map((seg) => displayText(seg, 'app')),
    }).catch(() => {});

    // 라이브 화면의 가사 패널에도 같은 목록을 넘긴다.
    import('./live-lyrics.js').then((m) => m.renderLiveLyrics(segments)).catch(() => {});

    const container = document.querySelector('#lyric-drawer .drawer-content');
    if (!container) return;
    updateDrawerTrackTitle();
    // On track change, always reset lyric drawer to top for singer-friendly flow.
    container.scrollTop = 0;

    if (!segments || segments.length === 0) {
        lastOverlayCurrent = null;
        lastOverlayNext = null;
        container.innerHTML = `
            <div class="drawer-empty-msg" style="padding: 40px 20px; text-align: center;">
                <div style="font-size: 2.5rem; margin-bottom: 20px; opacity: 0.5;">🎵</div>
                <p style="font-weight: 700; font-size: 1.1rem; margin-bottom: 8px;">정렬된 가사가 없습니다.</p>
                <p style="font-size: 0.85rem; opacity: 0.6; line-height: 1.6; margin-bottom: 24px;">
                    이 곡에 등록된 가사 싱크가 없습니다.<br>Lyric Sync 모드에서 가사를 정렬해 보세요.
                </p>
                <button type="button" class="primary-btn btn-md lyric-sync-cta" style="width: 100%;">
                    가사 싱크 등록하러 가기
                </button>
            </div>
        `;
        return;
    }

    container.querySelector('.lyric-sync-cta')?.addEventListener('click', () => {
        callAppHandler('goToLyricSyncForCurrentTrack');
    });

    // Reset overlay payload cache when track lyrics are replaced.
    lastOverlayCurrent = null;
    lastOverlayNext = null;

    container.innerHTML = segments.map((s, i) => `
        <div class="lyric-line-item drawer-lyric-item" data-index="${i}">
            <span class="lyric-text">${displayText(s, 'app')}</span>
        </div>
    `).join('');
}

/**
 * 설정된 표시 항목(원문/차음/번역)을 합친 텍스트. 일반 가사는 text 그대로.
 * 두 번째 줄부터는 살짝 작게 — 오버레이/드로어 모두 innerHTML로 렌더링하고
 * white-space: normal이라 `\n`은 그냥 공백으로 뭉개지므로 `<br>`로 조인.
 * `scope`는 'app'(인앱 드로어) 또는 'overlay'(OBS 오버레이) — 서로 독립적으로
 * 설정 가능하다(lrc-parser.js의 getLineVisibility).
 */
function displayText(seg, scope = 'app') {
    const lines = getDisplayLines(seg, scope).filter(Boolean);
    if (lines.length === 0) return '';
    if (lines.length === 1) return lines[0];
    const [first, ...rest] = lines;
    const restHtml = rest.map((l) => `<span style="font-size:0.7em;opacity:0.85;">${l}</span>`).join('<br>');
    return `${first}<br>${restHtml}`;
}

/**
 * Highlights and scrolls to the active lyric line
 * @param {number} currentTime 
 */
/**
 * 지금이 노래가 없는 구간(전주 또는 간주)인가.
 *
 * `vocalstart` 마커 앞은 전주, `ilstart`~`ilend` 사이는 간주다. 이 구간에서는
 * 다음 줄을 미리 띄우지 않는다 — 노래가 한참 뒤에 시작하는데 가사만 먼저
 * 떠 있으면 시청자가 따라 부를 타이밍을 놓친다.
 */
function isInInstrumental(currentTime) {
    const markers = state.currentMarkers;
    if (!markers) return false;

    const vs = markers.vocalStartSec;
    if (Number.isFinite(vs) && currentTime < vs) return true;

    for (const il of markers.interludes || []) {
        if (currentTime >= il.start && currentTime < il.end) return true;
    }
    return false;
}

function syncLyricsWithTime(currentTime) {
    const lyrics = state.currentLyrics;
    if (!lyrics || lyrics.length === 0) {
        // [추가] 가사가 없는 곡이라면 오버레이의 가사 영역을 확실히 비움
        invoke('update_overlay_lyrics', { current: "", next: "", index: -1 }).catch(err => console.error(err));
        return;
    }

    let playingIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
        const s = lyrics[i];
        if (s.start > 0 && currentTime >= s.start && (s.end === 0 || currentTime < s.end)) {
            playingIndex = i;
        }
    }

    // 전주·간주 구간에서는 오버레이를 비운다. 세그먼트만 봐서는 "아직 첫 줄
    // 전"과 "간주 중"을 구분할 수 없어, 노래가 없는 동안에도 다음 줄이 계속
    // 떠 있었다. 편집기에서 찍어 둔 구간 마커를 기준으로 삼는다.
    const inInstrumental = isInInstrumental(currentTime);

    // 부르는 줄이 없는 구간(줄 사이)에서 다음 줄을 곡의 첫 줄(lyrics[0])로
    // 잡고 있었다. 노래 중반 간주에도 오버레이에 1절 첫 줄이 "다음 가사"로
    // 떠 있었다는 뜻이다. 판정은 live-performance.js 한 곳에서만 한다 —
    // 라이브 화면도 같은 버그를 따로 갖고 있었다.
    const upcomingIndex = playingIndex !== -1
        ? playingIndex + 1
        : findUpcomingIndex(lyrics, currentTime);
    const upcoming = upcomingIndex >= 0 ? lyrics[upcomingIndex] : null;

    const current = (playingIndex !== -1) ? displayText(lyrics[playingIndex], 'overlay') : "";
    const next = (inInstrumental || !upcoming) ? "" : displayText(upcoming, 'overlay');

    // IMPORTANT: Don't skip overlay update only because index didn't change.
    // At song start, index can stay -1 for a while but first line still needs to appear in "next".
    const overlayPayloadChanged = current !== lastOverlayCurrent || next !== lastOverlayNext;
    if (overlayPayloadChanged) {
        // 줄 타이밍을 함께 보낸다 — 오버레이가 줄 안 진행도를 자기 시계로
        // 그리려면 이 줄의 구간을 알아야 한다. 진행도는 60fps로 움직이므로
        // 매 프레임 보낼 수 없고, 줄이 바뀔 때 한 번만 보낸다.
        //
        // 보정(offset)을 되돌려 실제 오디오 시간으로 보낸다. 오버레이의 시계는
        // 실제 재생 위치를 세고 있어서, 보정된 시간을 그대로 주면 진행도가
        // 보정한 만큼 어긋난다.
        const seg = playingIndex !== -1 ? lyrics[playingIndex] : null;
        const back = getLyricOffsetMs();
        const words = Array.isArray(seg?.words)
            ? seg.words
                .filter((w) => w && Number.isFinite(w.startMs) && Number.isFinite(w.endMs))
                .map((w) => [String(w.word || ''), Math.max(0, Math.round(w.startMs - back)), Math.max(0, Math.round(w.endMs - back))])
            : [];

        // 구간은 라이브 본문과 같은 규칙으로 정한다(resolveLineWindow).
        //
        // 예전에는 여기서 seg.start/seg.end를 그대로 보냈다. 그런데 라이브
        // 본문은 끝 시각이 없으면 다음 줄 시작까지로 보고 그 간격에 상한도
        // 둔다. 그래서 같은 줄인데 두 화면의 채워진 정도가 달랐다 —
        // 끝 시각이 0인 줄은 오버레이만 아예 안 차기도 했다.
        const win = seg ? resolveLineWindow(seg, lyrics[playingIndex + 1] || null) : null;
        const toMs = (sec) => Math.max(0, Math.round((sec || 0) * 1000 - back));

        invoke('update_overlay_lyrics', {
            current,
            next,
            index: playingIndex,   // 가사 뷰 페이지(/lyrics-view)의 현재 줄 하이라이트용
            lineStartMs: win?.startSec != null ? toMs(win.startSec) : 0,
            lineEndMs: win?.endSec != null ? toMs(win.endSec) : 0,
            lineWords: words,
        }).catch(err => console.error(err));
        lastOverlayCurrent = current;
        lastOverlayNext = next;
    }

    if (playingIndex === state.currentLyricIndex) return;
    state.currentLyricIndex = playingIndex;

    // 라이브 화면 가사 패널의 현재 줄 하이라이트
    import('./live-lyrics.js').then((m) => m.highlightLiveLyric(playingIndex)).catch(() => {});

    const container = document.querySelector('#lyric-drawer .drawer-content');
    if (!container) return;

    const items = container.querySelectorAll('.drawer-lyric-item');
    items.forEach((item, i) => {
        if (i === playingIndex) {
            item.classList.add('active');
            item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            item.classList.remove('active');
        }
    });
}

