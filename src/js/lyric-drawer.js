/**
 * src/js/lyric-drawer.js - Sliding Drawer UI Logic
 */
import { invoke } from './tauri-bridge.js';
import { playbackService } from '../ipc/services/playback.js';
import { state } from './state.js';
import { registerAppHandler, callAppHandler } from './app-context.js';
import { getDisplayLineModel } from './lrc-parser.js';
import { findUpcomingIndex, resolveLineWindow } from './live-performance.js';
import { highlightLiveLyric } from './live-lyrics.js';
import { filterWordTimingsForProgress } from './alignment-metadata.js';
import { brandIcon } from './brand-icons.js';

let lastOverlayCurrent = null;
let lastOverlayNext = null;
let lastOverlaySignature = null;

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

/**
 * 재생 위치 시계 — 오버레이가 쓰는 것과 **같은 구현**을 쓴다.
 *
 * 예전에는 라이브 본문이 state.currentProgressMs를 봤다. 그 값은 player.js가
 * tempo 슬라이더로 더해 나가다 ±500ms를 벗어날 때만 되돌리는 방식이라,
 * 설계상 최대 0.5초까지 어긋난 채로 굴러간다. 오버레이는 패킷 간격에서 재생
 * 속도를 추정하고 매 프레임 조금씩 수렴한다 — 세는 방식 자체가 달랐다.
 * 그래서 같은 줄·같은 계산을 써도 두 화면의 진행도가 벌어졌다.
 *
 * shared.js는 클래식 스크립트지만 import/export가 없어 모듈로 실행된다.
 * 실행되면 window.OverlayShared가 채워진다 — 구현을 복제하지 않는다.
 */
let playbackClock = null;
import('./overlay/shared.js')
    .then(() => {
        playbackClock = window.OverlayShared?.createPositionClock?.() || null;
    })
    .catch((err) => console.warn('[Lyrics] 위치 시계 로드 실패:', err));

/** 오버레이와 같은 기준의 현재 재생 위치(ms). 시계가 없으면 null. */
export function getPlaybackClockMs() {
    return playbackClock ? playbackClock.now() : null;
}

/** 가사 줄·카운트다운 판정에 쓰는 표시 시각(ms).
 * 진행 막대의 실제 오디오 시각과 달리 사용자의 가사 보정을 포함한다. */
export function getLyricDisplayClockMs(fallbackMs = null) {
    const actual = getPlaybackClockMs();
    const base = actual ?? (Number.isFinite(fallbackMs) ? fallbackMs : null);
    return base == null ? null : Math.max(0, base + getLyricOffsetMs());
}

function applyProgress(positionMs, durationMs) {
    lastDurationMs = durationMs;
    // 오버레이로 나가는 패킷과 **같은 값**으로 시계를 맞춘다.
    if (playbackClock) playbackClock.update(positionMs, durationMs, !!state.isPlaying);
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
    playbackService.onProgress(({ positionMs, durationMs }) => {
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
 * 표시용 가사를 통째로 갈아끼운다. **가사가 바뀌는 모든 경로는 여기를 쓴다.**
 *
 * 예전에는 갈아끼우는 곳이 셋이었고(곡 선택·편집기에서 열기·싱크 저장) 각자
 * 다른 것만 치웠다:
 *   - 곡 선택: 가사·마커·인덱스를 다 치움
 *   - 편집기에서 열기: 가사·마커·인덱스
 *   - 싱크 저장: 가사·인덱스만 — **마커를 안 치웠다**
 * 그래서 싱크를 고치면 간주·보컬 시작 마커가 옛것으로 남아, isInInstrumental이
 * 엉뚱한 구간에서 참이 되고 오버레이가 이유 없이 비었다. 여기 모아 두면
 * 무엇을 치워야 하는지 한 곳만 보면 된다.
 *
 * @param {Array} segments 새 가사 줄
 * @param {object} [markers] 새 구간 마커. 주지 않으면 빈 것으로 초기화한다 —
 *   옛 마커를 남기는 것이 마커 없음보다 위험하다(위 버그가 그것이었다).
 */
export function setDisplayLyrics(segments, markers) {
    state.currentLyrics = Array.isArray(segments) ? segments : [];
    state.currentMarkers = markers || { vocalStartSec: null, interludes: [] };
    state.currentLyricIndex = -1;
    // 오버레이로 보낸 줄 구간은 옛 배열의 인덱스를 들고 있다 — 새 가사에
    // 그대로 쓰면 엉뚱한 줄의 시간으로 진행도를 칠한다.
    state.overlayLyricWindow = null;
    // 중복 억제 캐시도 비운다. 새 가사의 첫 줄 글자가 옛 줄과 같으면 "안
    // 바뀌었다"로 보고 오버레이 푸시를 건너뛴다.
    lastOverlayCurrent = null;
    lastOverlayNext = null;
    lastOverlaySignature = null;

    updateLyrics(state.currentLyrics);
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
                <div class="drawer-empty-icon">${brandIcon('lyrics', 'brand')}</div>
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
    const lines = getDisplayLineModel(seg, scope).filter((line) => line.text);
    if (lines.length === 0) return '';
    const escapeHtml = (value) => String(value)
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    return lines.map((line, index) => {
        const target = line.progressTarget ? ' data-progress-target="true"' : '';
        const sub = index > 0 ? ' overlay-lyric-sub' : '';
        return `<span class="overlay-lyric-display-line${sub}" data-lyric-role="${line.role}"${target}><span class="overlay-lyric-line-text">${escapeHtml(line.text)}</span></span>`;
    }).join('<br>');
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
        const window = resolveLineWindow(s, lyrics[i + 1] || null);
        if (window.startSec != null && currentTime >= window.startSec
            && (window.endSec == null || currentTime < window.endSec)) {
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

    // 줄 타이밍을 함께 보낸다 — 오버레이가 줄 안 진행도를 자기 시계로
    // 그리려면 이 줄의 구간을 알아야 한다. 보정(offset)은 줄 판정에는 더하고,
    // 실제 오디오 시계와 비교할 시작·끝에는 되돌려 적용한다.
    const seg = playingIndex !== -1 ? lyrics[playingIndex] : null;
    const back = getLyricOffsetMs();
    const filteredWords = filterWordTimingsForProgress(seg);
    const words = filteredWords
        ? filteredWords.map((w) => [String(w.t || ''), Math.max(0, Math.round(w.s - back)), Math.max(0, Math.round(w.e - back))])
        : [];
    const win = seg ? resolveLineWindow(seg, lyrics[playingIndex + 1] || null) : null;
    const toMs = (sec) => Math.max(0, Math.round((sec || 0) * 1000 - back));
    const lineStartMs = win?.startSec != null ? toMs(win.startSec) : 0;
    const lineEndMs = win?.endSec != null ? toMs(win.endSec) : 0;

    // 텍스트가 같은 반복 가사도 인덱스와 시간 구간은 다르다. 텍스트만으로
    // 중복 억제하면 이전 절의 진행 구간이 남아 세 화면의 와이프가 어긋난다.
    const overlaySignature = JSON.stringify([
        current, next, playingIndex, lineStartMs, lineEndMs, words,
    ]);
    const overlayPayloadChanged = overlaySignature !== lastOverlaySignature;
    if (overlayPayloadChanged) {
        // 라이브 본문도 이 값을 그대로 쓴다.
        //
        // 예전에는 라이브가 buildPerformerLyricModel로 진행도를 따로 냈다.
        // 노래하는 동안은 같았지만, 그 모델은 공연자용 규칙(다음 줄 미리
        // 보여주기·끝난 줄 잠깐 붙들기)을 갖고 있어서 줄 사이 구간에서
        // 오버레이와 다른 값을 냈다 — 끝난 줄을 100%로 붙든 채였다.
        // 계산을 두 번 맞추는 대신 보내는 값을 공유해 구조적으로 못 어긋나게 한다.
        state.overlayLyricWindow = playingIndex >= 0
            ? { index: playingIndex, startMs: lineStartMs, endMs: lineEndMs, words }
            : null;

        invoke('update_overlay_lyrics', {
            current,
            next,
            index: playingIndex,   // 가사 뷰 페이지(/lyrics-view)의 현재 줄 하이라이트용
            lineStartMs,
            lineEndMs,
            lineWords: words,
        }).catch(err => console.error(err));
        lastOverlayCurrent = current;
        lastOverlayNext = next;
        lastOverlaySignature = overlaySignature;
    }

    if (playingIndex === state.currentLyricIndex) return;
    state.currentLyricIndex = playingIndex;

    // 현재 줄 판정과 같은 프레임에 강조한다. 동적 import를 거치면 state와
    // 진행도는 새 줄인데 전체 가사 강조만 한 프레임 이전 줄에 남는다.
    highlightLiveLyric(playingIndex);

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
