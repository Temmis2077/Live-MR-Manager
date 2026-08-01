import { showNotification, getThumbnailUrl } from './utils.js';
import { invoke, listen } from './tauri-bridge.js';
import { state } from './state.js';
import { parseLrc } from './lyrics.js';
import { parseMarkers, formatMarkerLine, isTriplet, getSyncText, getDisplayLines, getShowTranslation, setShowTranslation, mergeAlignmentResult, encodeLrc, suggestVocalStartFromSegments, parseTimeInput, formatTimeInput, groupTripletLines } from './lrc-parser.js';
import { getLyricSyncStatus } from './library-filters.js';

/** Enter로 줄을 찍었을 때 임시로 줄 끝에 주는 길이(초). 다음 줄을 찍으면
 *  그 시각으로 정리된다. 곡 끝까지 늘리지 않기 위한 값. */
const TAP_PROVISIONAL_SEC = 4;

export class ForcedAlignmentViewer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.invoke = invoke;

        this.state = {
            duration: 0,
            currentTime: 0,
            segments: [],
            waveformPoints: null,
            isProcessing: false,
            isSeeking: false,
            currentSyncIndex: -1,
            isSyncMode: false,
            zoomLevel: 1.0,
            scrollTime: 0,
            isPanning: false,
            lastPanX: 0,
            isScrolling: false,
            isResizing: false,
            resizeTarget: null,
            hoveringTarget: null,
            selectedTarget: null,
            // 현재 타겟팅된 가사 블럭 인덱스(-1 = 없음). 가사 목록을 클릭하면
            // 고정되고, 파형·플레이바로 시간을 옮기면 그 시각의 블럭으로 따라간다.
            // currentSyncIndex(다음에 스탬프 찍을 위치)와는 별개의 개념.
            selectedSegmentIndex: -1,
            // 보컬 시작 지점(초) — 진짜 목소리가 나오는 시작. 재생 시 인트로
            // 자동 건너뛰기의 기준([vocalstart] 마커로 저장). null이면 미지정.
            vocalStartSec: null,
            // 간주(무보컬) 구간 목록. 보컬 시작 전 간주는 건너뛰기 목표 계산에 쓰임.
            interludes: [],
            // 파형 기반 자동감지 후보 (사용자가 수락하기 전까지 별도 표시).
            suggestedInterludes: [],
            suggestedVocalStartSec: null,
            // 보컬 시작 제안의 출처: 'ai'(정렬 첫 줄) 또는 'waveform'(파형 진폭).
            // AI 제안이 더 정확(MV 대사/영상 인트로 무시)해 파형 제안보다 우선.
            suggestedVocalStartSource: null,
            interludeHoverTarget: null,
            interludeResizeTarget: null,
            // 원문/차음/번역 3줄 모드 (일본어 가사 등). 수동 토글, 기본 꺼짐.
            tripletMode: false
        };

        // isPlaying은 전역 state 하나만 본다. 예전에는 편집기가 자기 복사본을
        // 따로 들고 자기 리스너로 갱신해서, 편집기에서 재생을 눌러도 도크·
        // 라이브의 버튼은 멈춤 모양으로 남았다. 접근자로 위임해 두면 안에서
        // 읽고 쓰는 코드를 건드리지 않고도 어긋날 수가 없다.
        Object.defineProperty(this.state, 'isPlaying', {
            get: () => state.isPlaying,
            set: (v) => { state.isPlaying = !!v; },
            enumerable: true,
        });
        this.autoSaveTimer = null;
        this.autoSaveDelayMs = 1000;
        this.isDirty = false;
        this.isAutoSaving = false;
        this.lastSavedAt = null;

        this.initUI();
        this.setupListeners();
        this.parseLyrics();
        this.setupBackendListeners();
        this.loadTrackList();

        window.addEventListener('resize', () => this.resize());
    }

    initUI() {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="alignment-container">
                <aside class="lyric-input-column">
                    <div class="alignment-card">
                        <section>
                            <div class="card-header" style="margin-bottom: 12px;">
                                <h3>음원 선택</h3>
                            </div>
                            <div class="track-select-row">
                                <button id="open-track-modal-btn" class="track-select-btn">
                                    <span id="selected-track-name">음원을 선택하세요...</span>
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                                </button>
                            </div>
                        </section>
                        <section style="flex:1; display:flex; flex-direction:column; min-height:0;">
                            <div class="card-header" style="margin-bottom: 8px; justify-content: space-between;">
                                <h3>가사 원고</h3>
                                <button id="lyrics-link-btn" type="button" class="sync-reset-btn" style="display:none;" title="곡 정보에 등록된 가사 원문 링크를 엽니다">가사 원문 링크</button>
                            </div>
                            <label style="display:flex; align-items:center; gap:6px; font-size:0.78rem; color:var(--align-text-soft); margin-bottom:8px; cursor:pointer;" title="예: 일본어 원문 / 한글 차음 / 한국어 번역이 3줄 1세트로 반복되는 가사를 붙여넣을 때 켜세요.">
                                <input type="checkbox" id="triplet-mode-toggle">
                                원문/차음/번역 3줄 모드
                            </label>
                            <textarea id="lyrics-input" class="lyrics-textarea" placeholder="가사를 입력하세요..."></textarea>
                        </section>
                    </div>
                </aside>

                <main class="alignment-main">
                    <div class="alignment-card waveform-card">
                        <div class="card-header">
                            <h3>오디오 타임라인</h3>
                        </div>
                        <div class="waveform-canvas-container" style="position: relative;">
                            <canvas id="waveform-canvas"></canvas>
                            <div id="waveform-loader" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: var(--overlay-bg); flex-direction: column; justify-content: center; align-items: center; z-index: 10; border-radius: 8px;">
                                <div class="loader-spinner" style="position: relative; width: 48px; height: 48px; margin-bottom: 12px;">
                                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--accent-primary)" stroke-width="3" style="animation: waveform-spin 1s linear infinite;">
                                        <circle cx="12" cy="12" r="10" stroke-opacity="0.2" />
                                        <path d="M12 2a10 10 0 0 1 10 10" />
                                    </svg>
                                </div>
                                <div id="loader-text" style="color: var(--text-main); font-size: 0.9rem; font-weight: 500;"></div>
                                <div id="loader-progress" style="margin-top: 8px; color: var(--accent-primary); font-family: monospace; font-size: 0.8rem; display: none;">0%</div>
                                <style>
                                    @keyframes waveform-spin { 100% { transform: rotate(360deg); } }
                                </style>
                            </div>
                             <!-- Floating Zoom Controls -->
                             <div class="waveform-zoom-controls">
                                 <button id="zoom-out-btn" class="zoom-btn" title="축소 (Ctrl + Wheel Down)">-</button>
                                 <button id="zoom-in-btn" class="zoom-btn" title="확대 (Ctrl + Wheel Up)">+</button>
                             </div>

                             <!-- Waveform Scrollbar (Bottom edge) -->
                             <div class="waveform-scrollbar-wrapper">
                                 <div id="waveform-scrollbar-track" class="waveform-scrollbar-track">
                                     <div id="waveform-scrollbar-thumb" class="waveform-scrollbar-thumb"></div>
                                 </div>
                             </div>
                        </div>

                        <div class="seek-bar-container" style="padding: 0; margin-top: 4px; margin-bottom: 4px;">
                            <input type="range" id="seek-bar" class="seek-bar" value="0" step="0.1" style="width: 100%; margin: 0;">
                        </div>
                        <div class="sync-controls-panel">
                            <div class="sync-bottom-row">
                                <button id="play-btn" class="sync-ctrl-btn circle-btn" title="재생/일시정지 (Space)">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                </button>
                                <button id="sync-tap-btn" class="sync-ctrl-btn tap-btn">
                                    <span class="tap-label">싱크 맞추기 (Enter)</span>
                                </button>
                                <div class="time-container">
                                    <span id="time-display" style="font-family:monospace; color:#94a3b8; font-size:0.85rem;">00:00 / 00:00</span>
                                </div>
                            </div>
                            <div class="sync-bottom-row" style="margin-top:8px; flex-wrap:wrap; gap:8px;">
                                <button id="mark-vocal-start-btn" class="sync-reset-btn" title="현재 재생 위치를 보컬이 시작되는 지점으로 지정합니다. (단축키 V)">보컬 시작 지점 지정 (V)</button>
                                <button id="add-interlude-btn" class="sync-reset-btn" title="현재 재생 위치 근처에 간주(무보컬) 구간을 추가합니다. 경계를 드래그해 조정하세요. (단축키 M)">간주 구간 추가 (M)</button>
                                <label class="follow-playhead-toggle" title="재생 중 타임바(재생 위치 선)가 화면 밖으로 나가면 파형이 자동으로 따라 이동합니다.">
                                    <input type="checkbox" id="follow-playhead-check">
                                    <span>타임바 따라가기</span>
                                </label>
                                <span id="marker-suggestion-bar" style="display:none; align-items:center; gap:6px; font-size:0.75rem; color:var(--align-text-soft);"></span>
                            </div>
                        </div>
                        <!-- 마커 목록: 보컬 시작/간주를 번호별로 나열, 시각 직접 편집,
                             행 클릭 시 파형이 해당 구간으로 이동+확대, 우측 삭제 버튼 -->
                        <div id="marker-list-panel" class="marker-list-panel" style="display:none;"></div>
                    </div>
                </main>

                <aside class="lyric-sidebar">
                    <div class="alignment-card">
                        <div class="card-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                            <h3>가사 싱크 결과</h3>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <span id="sync-save-status" class="sync-save-status" style="min-width:52px; text-align:right; font-size:0.78rem; color:#94a3b8;">저장됨</span>
                                <button id="toggle-translation-btn" class="sync-reset-btn" title="번역 줄 표시 여부 — 여기서 켜고 끄면 인앱 가사창(드로어)에도 동일하게 적용됩니다. OBS 오버레이 표시 항목은 설정 화면에서 별도로 조정하세요.">번역 보기</button>
                                <button id="reset-sync-btn" class="sync-reset-btn">초기화</button>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap;">
                            <button id="ai-align-btn" class="sync-reset-btn" style="background:var(--align-item-active-bg); color:var(--accent-primary); border-color:var(--align-item-active-border);" title="AI 음성인식 모델로 가사와 오디오를 자동 정렬합니다. 노래 음성 특성상 완벽하지 않을 수 있어 결과는 직접 다듬어야 합니다.">AI 자동 정렬</button>
                            <select id="ai-align-language" title="정렬에 사용할 음성인식 방식. 영어 차음 모드는 영어 줄을 한글 발음으로 바꿔 한국어 모델 1회로 정렬합니다." style="font-size:0.75rem; padding:4px 6px; border-radius:6px; background:var(--align-surface-input); color:var(--align-text-soft); border:1px solid var(--align-item-border);">
                                <option value="ko">한국어/일본어(차음)</option>
                                <option value="en">English</option>
                                <option value="en-ko">영어 차음 + 한국어 모델 (추천)</option>
                            </select>
                            <button id="ai-align-cancel-btn" class="sync-reset-btn" style="display:none;">취소</button>
                            <span id="ai-align-status" style="font-size:0.75rem; color:var(--align-text-soft);"></span>
                        </div>
                        <div style="font-size:0.72rem; color:var(--align-text-soft); opacity:0.85; margin-bottom:12px;">
                            ※ 이 모델은 사람 목소리 기준으로 학습됐습니다. 보컬로이드 등 합성 음성 곡은 정렬이 잘 안 맞을 수 있어요 — 인식이 안된다면 사람이 부른 커버 버전으로 시도해보세요.
                        </div>
                        <div id="lyric-lines-container" class="lyric-lines-list">
                            <div style="color:#475569; text-align:center; padding-top:40px;">정렬을 시작하세요.</div>
                        </div>
                    </div>
                </aside>
            </div>
        `;
        this.canvas = document.getElementById('waveform-canvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    }

    setupListeners() {
        const get = (id) => document.getElementById(id);
        get('open-track-modal-btn').onclick = () => this.openTrackModal();
        get('alignment-track-close').onclick = () => this.closeTrackModal();
        get('alignment-track-modal').onclick = (e) => {
            if (e.target === get('alignment-track-modal')) this.closeTrackModal();
        };
        // 검색은 디바운스(500곡에서도 부드럽게). 현재 검색어는 state에 보관.
        this._trackSearchDebounce = null;
        get('alignment-track-search').oninput = (e) => {
            this._trackSearchQuery = e.target.value;
            clearTimeout(this._trackSearchDebounce);
            this._trackSearchDebounce = setTimeout(() => this.renderTrackList(), 150);
        };
        // 상태 필터 칩
        const chipBar = get('alignment-track-filter-chips');
        if (chipBar) {
            chipBar.querySelectorAll('.track-filter-chip').forEach((chip) => {
                chip.onclick = () => {
                    chipBar.querySelectorAll('.track-filter-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                    this.trackFilterStatus = chip.dataset.status || 'all';
                    this.renderTrackList();
                };
            });
        }

        get('play-btn').onclick = () => this.togglePlayback();
        get('sync-tap-btn').onclick = () => this.handleTap();
        get('lyrics-link-btn').onclick = () => this.openLyricsLink();
        get('mark-vocal-start-btn').onclick = () => this.markVocalStart();
        get('add-interlude-btn').onclick = () => this.addInterludeAtCurrentTime();
        get('ai-align-btn').onclick = () => this.runAiAlignment();
        get('ai-align-cancel-btn').onclick = () => this.cancelAiAlignment();

        // 타임바 따라가기 토글 — 재생 위치 선이 화면 밖으로 나가면 파형이
        // 자동으로 따라 이동(확대 상태에서 유용). localStorage에 저장.
        const followCheck = get('follow-playhead-check');
        if (followCheck) {
            followCheck.checked = localStorage.getItem('alignFollowPlayhead') === 'true';
            this.followPlayhead = followCheck.checked;
            followCheck.onchange = () => {
                this.followPlayhead = followCheck.checked;
                localStorage.setItem('alignFollowPlayhead', String(followCheck.checked));
            };
        }

        // AI 정렬 진행률은 여기서 표시하지 않는다 — 대기열(AI 프로세싱 탭)이
        // 담당. 대신 대기열 상태가 바뀔 때마다 "AI 자동 정렬" 버튼을 변환 중
        // 표시로 전환한다(alignment-queue.js가 큐 변경 시 이벤트를 쏨).
        window.addEventListener('alignment-queue-changed', () => this.updateAiAlignButtonState());

        // 정렬 언어 토글 — localStorage에 저장(에디터·배치 공용).
        import('./alignment-model.js').then(({ getAlignmentLanguage, setAlignmentLanguage }) => {
            const sel = get('ai-align-language');
            if (sel) {
                sel.value = getAlignmentLanguage();
                sel.onchange = () => setAlignmentLanguage(sel.value);
            }
        }).catch(() => {});

        // 정렬 대기열이 어떤 곡을 끝내면, 그 곡이 지금 에디터에 열려 있을 때
        // 결과(정렬 라인)를 즉시 in-memory 반영해 approx 표시까지 살린다.
        import('./alignment-queue.js').then(({ onAlignmentItemComplete }) => {
            onAlignmentItemComplete((path, lines, segments) => this.onQueueAlignmentDone(path, lines, segments));
        }).catch(() => {});
        get('toggle-translation-btn').onclick = () => {
            setShowTranslation(!getShowTranslation());
            this.renderLyricList();
        };
        get('reset-sync-btn').onclick = () => {
            if (confirm('모든 싱크 데이터를 초기화하시겠습니까?')) {
                this.state.segments.forEach(s => {
                    s.start = 0;
                    s.end = 0;
                    s.approx = false;
                });
                this.state.currentSyncIndex = 0;
                this.state.selectedTarget = null;
                this.renderLyricList();
                this.drawWaveform();
                showNotification('싱크 데이터가 초기화되었습니다.', 'info');
                this.markDirtyAndScheduleSave();
            }
        };

        const lyricsInput = get('lyrics-input');
        if (lyricsInput) {
            lyricsInput.addEventListener('input', () => this.parseLyrics());
        }

        const tripletToggle = get('triplet-mode-toggle');
        if (tripletToggle) {
            tripletToggle.addEventListener('change', () => {
                this.state.tripletMode = tripletToggle.checked;
                this.parseLyrics();
            });
        }

        // Zoom Controls
        get('zoom-in-btn').onclick = () => this.handleZoom(1.5);
        get('zoom-out-btn').onclick = () => this.handleZoom(1 / 1.5);

        // Waveform Events (Zoom & Pan)
        this.canvas.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
                this.handleZoom(zoomFactor, e.offsetX);
            }
        }, { passive: false });
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                // 파형 클릭은 탐색만 한다. 재생 상태는 백엔드 seek_to가 그대로
                // 유지하므로, 멈춰 놓고 경계를 만져도 음악이 시작되지 않는다.
                if (this.state.interludeHoverTarget) {
                    this.state.isResizingInterlude = true;
                    this.state.interludeResizeTarget = this.state.interludeHoverTarget;
                    const il = this.state.interludes[this.state.interludeHoverTarget.index];
                    this.seekTo(this.state.interludeHoverTarget.type === 'start' ? il.start : il.end);
                } else if (this.state.hoveringTarget) {
                    this.state.isResizing = true;
                    this.state.resizeTarget = this.state.hoveringTarget;
                    this.state.selectedTarget = this.state.hoveringTarget;

                    const seg = this.state.segments[this.state.selectedTarget.index];
                    const targetTime = this.state.selectedTarget.type === 'start' ? seg.start : seg.end;
                    this.seekTo(targetTime);
                } else {
                    if (this.state.duration <= 0) return;
                    const rect = this.canvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const targetTime = this.xToTime(x);
                    this.seekTo(targetTime);
                    this.state.selectedTarget = null;
                }
                this.drawWaveform();
            } else if (e.button === 2) { // Right click for panning
                this.state.isPanning = true;
                this.state.lastPanX = e.clientX;
                this.canvas.style.cursor = 'grabbing';
            }
        });

        this.canvas.addEventListener('dblclick', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const t = this.xToTime(x);
            const idx = this.state.interludes.findIndex(il => t >= il.start && t <= il.end);
            if (idx !== -1 && confirm('이 간주 구간을 삭제하시겠습니까?')) {
                this.state.interludes.splice(idx, 1);
                this.onMarkersChanged();
                this.markDirtyAndScheduleSave();
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.state.isPanning || this.state.isScrolling || this.state.isResizing || this.state.isResizingInterlude) return;

            const x = e.offsetX;
            const hitThreshold = 8; // Pixels
            let found = null;

            this.state.segments.forEach((seg, idx) => {
                const xStart = this.timeToX(seg.start);
                const xEnd = this.timeToX(seg.end);

                if (Math.abs(x - xStart) < hitThreshold) found = { index: idx, type: 'start' };
                else if (Math.abs(x - xEnd) < hitThreshold) found = { index: idx, type: 'end' };
            });

            let foundInterlude = null;
            this.state.interludes.forEach((il, idx) => {
                const xStart = this.timeToX(il.start);
                const xEnd = this.timeToX(il.end);
                if (Math.abs(x - xStart) < hitThreshold) foundInterlude = { index: idx, type: 'start' };
                else if (Math.abs(x - xEnd) < hitThreshold) foundInterlude = { index: idx, type: 'end' };
            });

            this.state.hoveringTarget = found;
            this.state.interludeHoverTarget = foundInterlude;
            this.canvas.style.cursor = (found || foundInterlude) ? 'col-resize' : 'default';
            this.drawWaveform(); // Redraw to show boundary highlight
        });

        window.addEventListener('mousemove', (e) => {
            if (this.state.isResizing && this.state.resizeTarget) {
                const rect = this.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const newTime = Math.max(0, Math.min(this.state.duration, this.xToTime(x)));

                const idx = this.state.resizeTarget.index;
                const seg = this.state.segments[idx];
                
                // 잡은 경계 하나만 움직인다. 예전에는 이웃 블럭의 경계까지
                // 같이 끌고 가서, 줄 사이에 간격을 둘 수 없었고 블럭들이 항상
                // 붙어 있었다(간주에서도 앞 줄이 계속 떠 있는 원인).
                // 이웃을 넘어가지 않도록 범위만 제한한다.
                const MIN_LEN = 0.05;
                if (this.state.resizeTarget.type === 'start') {
                    const prev = idx > 0 ? this.state.segments[idx - 1] : null;
                    const lo = prev ? Math.max(0, prev.end) : 0;
                    seg.start = Math.max(lo, Math.min(newTime, seg.end - MIN_LEN));
                } else {
                    const next = idx < this.state.segments.length - 1
                        ? this.state.segments[idx + 1]
                        : null;
                    const hi = next && next.start > 0 ? next.start : this.state.duration;
                    seg.end = Math.min(hi, Math.max(newTime, seg.start + MIN_LEN));
                }
                // 사용자가 직접 조정했으니 "대략적 배치" 표시 해제
                seg.approx = false;

                this.drawWaveform();
                this.renderLyricList();
                this.markDirtyAndScheduleSave();
            }

            if (this.state.isResizingInterlude && this.state.interludeResizeTarget) {
                const rect = this.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const newTime = Math.max(0, Math.min(this.state.duration, this.xToTime(x)));

                const idx = this.state.interludeResizeTarget.index;
                const il = this.state.interludes[idx];
                if (this.state.interludeResizeTarget.type === 'start') {
                    il.start = Math.min(newTime, il.end - 0.2);
                } else {
                    il.end = Math.max(newTime, il.start + 0.2);
                }
                this.drawWaveform();
                this.markDirtyAndScheduleSave();
            }

            if (this.state.isPanning) {
                const dx = e.clientX - this.state.lastPanX;
                this.state.lastPanX = e.clientX;

                const visibleDuration = this.state.duration / this.state.zoomLevel;
                const timePerPixel = visibleDuration / this.canvas.width;
                const deltaTime = dx * timePerPixel;

                this.state.scrollTime = Math.max(0, Math.min(this.state.duration - visibleDuration, this.state.scrollTime - deltaTime));
                this.drawWaveform();
            }
        });

        window.addEventListener('mouseup', () => {
            const wasResizing = this.state.isResizing || this.state.isResizingInterlude;
            if (this.state.isPanning) {
                this.state.isPanning = false;
                this.canvas.style.cursor = 'default';
            }
            this.state.isScrolling = false;
            this.state.isResizing = false;
            this.state.resizeTarget = null;
            this.state.isResizingInterlude = false;
            this.state.interludeResizeTarget = null;
            if (wasResizing) {
                this.markDirtyAndScheduleSave();
                this.renderMarkerList(); // 캔버스 드래그로 바뀐 간주 경계를 목록에도 반영
            }
        });

        window.addEventListener('keydown', (e) => {
            // Ignore if typing in input/textarea
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

            if (this.state.selectedTarget) {
                const seg = this.state.segments[this.state.selectedTarget.index];
                if (!seg) return;

                const step = e.shiftKey ? 0.1 : 0.01;
                let changed = false;

                if (e.key === 'ArrowLeft') {
                    if (this.state.selectedTarget.type === 'start') {
                        seg.start = Math.max(0, seg.start - step);
                    } else {
                        seg.end = Math.max(seg.start + 0.05, seg.end - step);
                    }
                    seg.approx = false;
                    changed = true;
                } else if (e.key === 'ArrowRight') {
                    if (this.state.selectedTarget.type === 'start') {
                        seg.start = Math.min(seg.end - 0.05, seg.start + step);
                    } else {
                        seg.end = Math.min(this.state.duration, seg.end + step);
                    }
                    seg.approx = false;
                    changed = true;
                } else if (e.key === 'Escape' || e.key === 'Enter') {
                    this.state.selectedTarget = null;
                    changed = true;
                }

                if (changed) {
                    e.preventDefault();
                    this.drawWaveform();
                    this.renderLyricList();
                    if (e.key !== 'Escape' && e.key !== 'Enter') {
                        this.markDirtyAndScheduleSave();
                    }
                }
            } else if (state.activeView === 'alignment') {
                // 가사 싱크 탭 전용 단축키. Space가 재생/정지와 싱크 맞추기를
                // 겸해서 헷갈리던 것을 분리: Space=재생/정지, Enter=싱크 맞추기.
                if (e.code === 'Space') {
                    e.preventDefault();
                    this.togglePlayback();
                } else if (e.code === 'Enter') {
                    e.preventDefault();
                    // Shift+Enter는 방금 찍은 줄을 다시 찍는다 — 한 박자 늦게
                    // 눌렀을 때 전체를 다시 하지 않고 그 줄만 고칠 수 있게.
                    if (e.shiftKey) this.retapPrevious();
                    else this.handleTap();
                } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
                    // 선택한 경계의 미세조정. 드래그로는 10ms를 집을 수 없다.
                    // Shift를 누르면 더 크게(100ms) 움직인다.
                    const dir = e.code === 'ArrowRight' ? 1 : -1;
                    const step = e.shiftKey ? 0.1 : 0.01;
                    if (this.nudgeSelectedBoundary(dir * step)) e.preventDefault();
                } else if (e.code === 'KeyV') {
                    // 현재 재생 위치에 보컬 시작 지점 지정
                    e.preventDefault();
                    this.markVocalStart();
                } else if (e.code === 'KeyM') {
                    // 현재 재생 위치 근처에 간주 마커 추가
                    e.preventDefault();
                    this.addInterludeAtCurrentTime();
                }
            }
        });

        // Scrollbar Interaction
        const thumb = get('waveform-scrollbar-thumb');
        const track = get('waveform-scrollbar-track');
        if (thumb && track) {
            thumb.onmousedown = (e) => {
                e.preventDefault();
                this.state.isScrolling = true;
                this.state.lastScrollX = e.clientX;
            };

            window.addEventListener('mousemove', (e) => {
                if (this.state.isScrolling && this.state.duration > 0) {
                    const rect = track.getBoundingClientRect();
                    const deltaX = e.clientX - rect.left;
                    const percent = Math.max(0, Math.min(1, deltaX / rect.width));

                    const visibleDuration = this.state.duration / this.state.zoomLevel;
                    this.state.scrollTime = Math.max(0, Math.min(this.state.duration - visibleDuration, percent * this.state.duration));
                    this.drawWaveform();
                }
            });
        }


        const bar = get('seek-bar');

        // 드래그 중 실시간 업데이트 (파형 및 시간)
        bar.addEventListener('input', (e) => {
            this.state.isSeeking = true;
            if (this.state.duration > 0) {
                this.state.currentTime = (parseFloat(e.target.value) / 100) * this.state.duration;
                this.updateTimeDisplay();
                this.drawWaveform(); // 파형에도 즉시 반영
            }
        });

        // 드래그 종료 시 탐색(Seek) 요청
        bar.addEventListener('change', async () => {
            try {
                if (this.state.duration > 0) {
                    await this.seekTo(this.state.currentTime);
                }
            } catch (err) {
                console.error("Seek failed:", err);
            } finally {
                setTimeout(() => {
                    this.state.isSeeking = false;
                }, 100);
            }
        });
    }

    async setupBackendListeners() {
        if (!window.__TAURI__) return;

        // CRITICAL: Clean up ANY existing global listeners to prevent "Event Storms"
        // If the user navigates away and back, we must kill the old ghosts.
        if (window._alignmentUnlistenProgress) {
            const unlisten = await window._alignmentUnlistenProgress;
            unlisten();
            window._alignmentUnlistenProgress = null;
        }
        if (window._alignmentUnlistenModelDownload) {
            const unlisten = await window._alignmentUnlistenModelDownload;
            unlisten();
            window._alignmentUnlistenModelDownload = null;
        }

        // Now setup fresh, single listeners
        window._alignmentUnlistenProgress = listen('playback-progress', (event) => {
            // Rust struct may serialize to CamelCase or snake_case depending on serde config.
            const positionMs = event.payload.positionMs ?? event.payload.position_ms ?? 0;
            const durationMs = event.payload.durationMs ?? event.payload.duration_ms ?? 0;

            if (this.state.isSeeking) return; // Only block when user is dragging

            // Update duration only if we have a valid one
            if (durationMs > 0) {
                this.state.duration = durationMs / 1000;
            }
            this.state.currentTime = positionMs / 1000;

            // 타임바 따라가기: 재생 중에는 위치 선이 항상 화면 중앙에 오도록
            // 뷰포트를 연속 이동(끝에 닿을 때 점프하는 방식보다 시선이 편함).
            // 확대 중일 때만 의미. 곡 양 끝에서는 범위 클램프로 자연히 멈춤.
            if (this.followPlayhead && this.state.isPlaying && this.state.zoomLevel > 1 && this.state.duration > 0) {
                const visible = this.state.duration / this.state.zoomLevel;
                this.state.scrollTime = Math.max(0, Math.min(
                    this.state.currentTime - visible / 2,
                    this.state.duration - visible
                ));
                this.updateScrollbar();
            }

            this.updateTimeDisplay();
            // 재생이 진행되면 현재 시각의 가사 블럭으로 선택이 따라간다.
            this.setSelectedSegmentByTime(this.state.currentTime);
            // 원문 목록에서도 지금 부르는 줄을 표시한다.
            this.highlightPlayingLyric();
            this.drawWaveform();
            this.syncSidebar();
        });

        // 재생 상태는 events/backend.js의 리스너 하나가 전역 state에 반영하고,
        // 거기서 syncPlaybackUI()가 이 화면 버튼까지 함께 갱신한다. 여기서
        // 따로 듣지 않는다 — 두 곳이 각자 그리면 서로 어긋난다.

        // AI 정렬 모델 다운로드 진행률 리스너
        window._alignmentUnlistenModelDownload = listen('alignment-model-download-progress', (event) => {
            const percent = typeof event.payload === 'number' ? event.payload : 0;
            const statusEl = document.getElementById('ai-align-status');
            if (statusEl) statusEl.textContent = `AI 정렬 모델 다운로드 중... ${Math.round(percent)}%`;
        });

        // 유튜브 다운로드 진행률 리스너 추가
        window._alignmentUnlistenDownload = listen('youtube-download-progress', (event) => {
            if (!this.state.isProcessing) return;
            const { percentage } = event.payload;
            const loaderText = document.getElementById('loader-text');
            const loaderProgress = document.getElementById('loader-progress');

            if (loaderText) loaderText.innerText = '유튜브 음원 다운로드 중...';
            if (loaderProgress) {
                loaderProgress.style.display = 'block';
                loaderProgress.innerText = `${Math.floor(percentage)}%`;
            }
        });
    }

    async loadAudio(path) {
        if (!path) return;
        // Guards against overlapping calls (e.g. the playback auto-follow hook
        // firing again before a previous loadAudio() finished its awaits) —
        // without this, a slower stale call can resolve after a newer one and
        // clobber its segments/duration/waveform with the previous track's
        // data, which looked like "lyrics stuck on the last song" / vocal
        // toggle state randomly flipping.
        const mySeq = (this.state.loadSeq = (this.state.loadSeq || 0) + 1);
        const isStale = () => mySeq !== this.state.loadSeq;

        await this.flushAutoSaveIfNeeded();
        if (isStale()) return;
        this.state.currentPath = path;
        this.updateAiAlignButtonState(); // 대기열에 있는 곡이면 버튼을 변환 중 표시로
        this.state.isProcessing = true;
        this.state.currentTime = 0;
        this.state.duration = 0;
        this.state.waveformPoints = null; // 파형 초기화
        this.drawWaveform();

        const loader = document.getElementById('waveform-loader');
        const loaderText = document.getElementById('loader-text');
        const loaderProgress = document.getElementById('loader-progress');

        if (loader) loader.style.display = 'flex';

        if (loaderProgress) loaderProgress.style.display = 'none';

        try {
            // Keep bottom shared playback area consistent with library-selected behavior.
            const matchedIndex = (state.songLibrary || []).findIndex((song) => song.path === path);
            const matchedSong = matchedIndex >= 0 ? state.songLibrary[matchedIndex] : null;
            if (matchedSong) {
                state.currentTrack = matchedSong;
                state.selectedTrackIndex = matchedIndex;
                state.isPlaying = false;
                state.isLoading = true;
                state.vocalEnabled = true;

                const elemsMod = await import('./ui/elements.js');
                const elements = elemsMod.elements || {};
                if (elements.dockTitle) elements.dockTitle.textContent = matchedSong.title || '제목 정보 없음';
                if (elements.dockArtist) elements.dockArtist.textContent = matchedSong.artist || '가수 정보 없음';
                if (elements.dockThumbImg) {
                    elements.dockThumbImg.src = getThumbnailUrl(matchedSong.thumbnail, matchedSong);
                    elements.dockThumbImg.style.display = 'block';
                }
                if (elements.timeCurrent) elements.timeCurrent.textContent = '0:00';
                if (elements.timeTotal) elements.timeTotal.textContent = matchedSong.duration || '--:--';
                if (elements.playbackBar) elements.playbackBar.value = 0;
                if (elements.progressFill) elements.progressFill.style.width = '0%';

                const ui = await import('./ui/components.js');
                if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                if (ui.updateAiTogglesState) ui.updateAiTogglesState(matchedSong);
                if (ui.updatePlayButton) ui.updatePlayButton();
                this.updateLyricsLinkButton(matchedSong.lyricsLink || matchedSong.lyrics_link || '');

                // In lyric sync workflow, always monitor with vocals enabled.
                const audio = await import('./audio.js');
                if (audio.toggleAiFeature) {
                    await audio.toggleAiFeature("vocal", true);
                }
            } else {
                this.updateLyricsLinkButton('');
            }
            if (isStale()) return;

            console.log("[Alignment] Loading audio:", path);
            // Get duration immediately from backend
            const ms = await this.invoke('play_track', { path, durationMs: 0, playNow: false });
            if (isStale()) return;
            console.log("[Alignment] play_track success, duration:", ms);
            this.state.duration = ms / 1000;
            this.updateTimeDisplay();

            // 가사 데이터 초기화
            this.state.segments = [];
            this.state.currentSyncIndex = 0;
            this.state.isSyncMode = false;
            this.state.vocalStartSec = null;
            this.state.interludes = [];
            this.state.suggestedInterludes = [];
            this.state.suggestedVocalStartSec = null;
            this.state.suggestedVocalStartSource = null;
            this.state.tripletMode = false;
            const tripletToggleReset = document.getElementById('triplet-mode-toggle');
            if (tripletToggleReset) tripletToggleReset.checked = false;
            const inputElement = document.getElementById('lyrics-input');
            if (inputElement) inputElement.value = '';
            this.renderLyricList();
            this.updateMarkerSuggestionBar();
            this.renderMarkerList();
            this.isDirty = false;
            this.updateSaveStatus('저장됨');

            // Try to load existing LRC file
            try {
                const lrcContent = await this.invoke('load_lrc_file', { audioPath: path });
                if (isStale()) return;
                if (lrcContent && lrcContent.trim()) {
                    const parsedSegments = parseLrc(lrcContent, this.state.duration);
                    // Clean up imported lyrics: remove meaningless blank lines and trim noisy spacing.
                    const normalizedSegments = parsedSegments
                        .map((seg) => {
                            const cleanText = (seg.text || '').replace(/\s+/g, ' ').trim();
                            if (isTriplet(seg)) {
                                return {
                                    ...seg,
                                    text: cleanText,
                                    original: cleanText,
                                    pronunciation: (seg.pronunciation || '').replace(/\s+/g, ' ').trim(),
                                    translation: (seg.translation || '').replace(/\s+/g, ' ').trim(),
                                };
                            }
                            return { ...seg, text: cleanText };
                        })
                        .filter((seg) => seg.text.length > 0);

                    this.state.segments = normalizedSegments;

                    // 저장된 파일에 3줄 큐가 있으면 트리플렛 모드를 자동으로 켜서 토글과 동기화.
                    this.state.tripletMode = normalizedSegments.some((seg) => isTriplet(seg));
                    const tripletToggleEl = document.getElementById('triplet-mode-toggle');
                    if (tripletToggleEl) tripletToggleEl.checked = this.state.tripletMode;

                    const rawLyrics = [];
                    this.state.segments.forEach((s) => {
                        if (isTriplet(s)) {
                            rawLyrics.push(s.original || '', s.pronunciation || '', s.translation || '');
                        } else {
                            rawLyrics.push(s.text);
                        }
                    });
                    if (inputElement) inputElement.value = rawLyrics.join('\n');

                    let nextIdx = this.state.segments.findIndex(s => s.start === 0);
                    if (nextIdx === -1) nextIdx = this.state.segments.length;
                    this.state.currentSyncIndex = nextIdx;

                    this.state.isSyncMode = true;

                    const markers = parseMarkers(lrcContent);
                    this.state.vocalStartSec = markers.vocalStartSec;
                    this.state.interludes = markers.interludes;
                    this.renderMarkerList();

                    this.renderLyricList();
                    this.isDirty = false;
                    this.updateSaveStatus('저장됨');
                }
            } catch (err) {
                console.log("[Alignment] LRC load failed or not found:", err);
            }

            this.drawWaveform();

            // Background waveform (파형 후순위 비동기 로드)


            const waveformPath = path;
            this.invoke('get_waveform_summary', { audioPath: waveformPath }).then(summary => {
                if (isStale()) return;
                console.log("[Alignment] Waveform load success:", summary ? summary.points.length : 0);
                if (summary) {
                    this.state.waveformPoints = summary.points;
                    if (!this.state.duration) {
                        this.state.duration = summary.duration_sec;
                        this.updateTimeDisplay();
                    }
                    this.detectMarkerCandidates();
                    this.drawWaveform();
                }
            }).catch(e => {
                if (isStale()) return;
                console.error("[Alignment] Waveform load failed:", e);
                showNotification('파형 로드 실패: ' + e, 'warning');
            })
                .finally(() => {
                    if (isStale()) return;
                    this.state.isProcessing = false;
                    state.isLoading = false;
                    import('./ui/components.js').then((ui) => {
                        if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                        if (ui.updatePlayButton) ui.updatePlayButton();
                    });
                    if (loader) loader.style.display = 'none';
                });

        } catch (e) {
            if (isStale()) return;
            console.error("[Alignment] loadAudio general failure:", e);
            this.state.isProcessing = false;
            state.isLoading = false;
            import('./ui/components.js').then((ui) => {
                if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                if (ui.updatePlayButton) ui.updatePlayButton();
            });
            if (loader) loader.style.display = 'none';
            showNotification('오디오 로드 실패: ' + e, 'error');
        }
    }

    updateTimeDisplay() {
        const bar = document.getElementById('seek-bar');
        const display = document.getElementById('time-display');
        if (bar && !this.state.isSeeking) {
            bar.value = this.state.duration > 0 ? (this.state.currentTime / this.state.duration) * 100 : 0;
        }
        if (display) {
            display.innerText = `${this.formatTime(this.state.currentTime)} / ${this.formatTime(this.state.duration)}`;
        }
        this.drawWaveform();
    }

    /**
     * 재생 위치만 옮긴다. 재생 중이면 계속 재생되고, 멈춰 있으면 멈춘 채다.
     *
     * `resume` 옵션은 더 이상 필요 없다 — 예전에는 백엔드 seek_to가 항상
     * 재생을 시작해서, 프런트가 toggle_playback으로 되돌리는 보정을 넣어야
     * 했다. 그 보정이 비동기 경합에 걸리면 오히려 재생이 시작돼, 파형을
     * 만질 때마다 음악이 튀어나왔다. 이제 백엔드가 상태를 유지한다.
     */
    async seekTo(time) {
        if (!this.state.currentPath || this.state.duration <= 0) return;

        this.state.currentTime = Math.max(0, Math.min(this.state.duration, time));
        this.updateTimeDisplay();
        // 파형·플레이바 등으로 시간을 옮기면 그 시각의 가사 블럭이 선택되게 한다.
        this.setSelectedSegmentByTime(this.state.currentTime);

        try {
            // Seek 중 백엔드의 이전 재생 위치 이벤트에 의해 UI가 튕기는 것을 방지
            this.state.isSeeking = true;
            if (this._seekTimeout) clearTimeout(this._seekTimeout);

            await this.invoke('seek_to', {
                positionMs: Math.floor(this.state.currentTime * 1000)
            });
        } catch (err) {
            console.error("[Alignment] seekTo error:", err);
        } finally {
            // 연속 클릭 시 타이머 초기화 및 백엔드 지연 고려하여 400ms로 설정
            this._seekTimeout = setTimeout(() => { this.state.isSeeking = false; }, 400);
        }
    }

    timeToX(time) {
        if (!this.canvas || this.state.duration <= 0) return 0;
        const visibleDuration = this.state.duration / this.state.zoomLevel;
        return ((time - this.state.scrollTime) / visibleDuration) * this.canvas.width;
    }

    xToTime(x) {
        if (!this.canvas || this.state.duration <= 0) return 0;
        const visibleDuration = this.state.duration / this.state.zoomLevel;
        return (x / this.canvas.width) * visibleDuration + this.state.scrollTime;
    }

    updateScrollbar() {
        const thumb = document.getElementById('waveform-scrollbar-thumb');
        if (!thumb || this.state.duration <= 0) return;

        const thumbWidth = (1 / this.state.zoomLevel) * 100;
        const thumbLeft = (this.state.scrollTime / this.state.duration) * 100;

        thumb.style.width = `${Math.max(thumbWidth, 2)}%`;
        thumb.style.left = `${thumbLeft}%`;
    }

    updatePlayButton() {
        // 이 버튼만 따로 그리지 않고 재생 상태를 쓰는 화면을 함께 갱신한다.
        import('./ui/playback-sync.js').then((m) => m.syncPlaybackUI()).catch(() => {});
    }

    drawWaveform() {
        if (!this.ctx || !this.canvas) return;
        const { width, height } = this.canvas;
        this.ctx.clearRect(0, 0, width, height);

        if (this.state.duration <= 0) return;

        const rootStyle = getComputedStyle(document.documentElement);
        const cssVar = (name, fallback) => {
            const v = rootStyle.getPropertyValue(name).trim();
            return v || fallback;
        };
        const palette = {
            // Task/segment box colors should follow active app theme tokens.
            segmentFillActive: cssVar('--align-item-active-bg', 'rgba(74, 158, 255, 0.3)'),
            segmentFillIdle: cssVar('--align-item-bg', 'rgba(74, 158, 255, 0.1)'),
            segmentBorder: cssVar('--align-item-border', 'rgba(74, 158, 255, 0.3)'),
            segmentHover: cssVar('--align-item-hover-border', '#4a9eff'),
            waveformStroke: cssVar('--align-track-placeholder', 'rgba(255,255,255,0.2)'),
        };

        this.updateScrollbar();

        const visibleDuration = this.state.duration / this.state.zoomLevel;
        const startTime = this.state.scrollTime;
        const endTime = startTime + visibleDuration;

        // 0a. Interludes (confirmed) — hatched region + draggable edge handles
        const drawInterludeBand = (il, idx, confirmed) => {
            if (il.end < startTime || il.start > endTime) return;
            const x1 = Math.max(0, this.timeToX(il.start));
            const x2 = Math.min(width, this.timeToX(il.end));
            if (x2 <= x1) return;

            this.ctx.save();
            this.ctx.globalAlpha = confirmed ? 0.28 : 0.16;
            this.ctx.fillStyle = '#94a3b8';
            this.ctx.fillRect(x1, 0, x2 - x1, height);
            this.ctx.restore();

            this.ctx.strokeStyle = confirmed ? '#64748b' : 'rgba(148, 163, 184, 0.6)';
            this.ctx.lineWidth = confirmed ? 2 : 1;
            if (!confirmed) this.ctx.setLineDash([3, 3]);
            this.ctx.strokeRect(x1, 1, x2 - x1, height - 2);
            this.ctx.setLineDash([]);

            if (confirmed) {
                const hover = this.state.interludeHoverTarget;
                [{ x: x1, type: 'start' }, { x: x2, type: 'end' }].forEach(({ x, type }) => {
                    const isHover = hover && hover.index === idx && hover.type === type;
                    this.ctx.strokeStyle = isHover ? '#f59e0b' : '#64748b';
                    this.ctx.lineWidth = isHover ? 3 : 2;
                    this.ctx.beginPath();
                    this.ctx.moveTo(x, 0);
                    this.ctx.lineTo(x, height);
                    this.ctx.stroke();
                });
            }
        };
        this.state.suggestedInterludes.forEach((il) => drawInterludeBand(il, -1, false));
        this.state.interludes.forEach((il, idx) => drawInterludeBand(il, idx, true));

        // 0b. Vocal start marker (confirmed = solid, suggestion = dashed)
        const drawVocalStartLine = (sec, confirmed) => {
            if (sec == null || sec < startTime || sec > endTime) return;
            const x = this.timeToX(sec);
            this.ctx.strokeStyle = confirmed ? '#22c55e' : 'rgba(34, 197, 94, 0.55)';
            this.ctx.lineWidth = confirmed ? 2 : 1.5;
            if (!confirmed) this.ctx.setLineDash([3, 3]);
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, height);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            if (confirmed) {
                this.ctx.fillStyle = '#22c55e';
                this.ctx.beginPath();
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x + 6, 0);
                this.ctx.lineTo(x, 8);
                this.ctx.closePath();
                this.ctx.fill();
            }
        };
        drawVocalStartLine(this.state.suggestedVocalStartSec, false);
        drawVocalStartLine(this.state.vocalStartSec, true);

        // 1. Segments
        this.state.segments.forEach((seg, idx) => {
            if (seg.end < startTime || seg.start > endTime) return;
            const x1 = this.timeToX(seg.start);
            const x2 = this.timeToX(seg.end);

            // Fill background
            this.ctx.fillStyle = (idx === this.state.currentSyncIndex - 1) ? palette.segmentFillActive : palette.segmentFillIdle;
            this.ctx.globalAlpha = seg.approx ? 0.5 : 1;
            this.ctx.fillRect(Math.max(0, x1), 0, Math.min(width, x2) - Math.max(0, x1), height);
            this.ctx.globalAlpha = 1;

            // Default subtle boundary lines (dashed for BPM-grid "approximate" placements)
            this.ctx.strokeStyle = palette.segmentBorder;
            this.ctx.lineWidth = 1;
            if (seg.approx) this.ctx.setLineDash([4, 3]);
            [x1, x2].forEach(bx => {
                if (bx >= 0 && bx <= width) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(bx, 0);
                    this.ctx.lineTo(bx, height);
                    this.ctx.stroke();
                }
            });
            if (seg.approx) this.ctx.setLineDash([]);

            // 블럭 위에 해당 가사 표시 — 어느 블럭이 어느 줄인지 파형에서 바로
            // 알 수 있게. 블럭 폭을 넘어가면 잘라내고, 너무 좁으면 생략.
            const bx1 = Math.max(0, x1);
            const bx2 = Math.min(width, x2);
            const boxW = bx2 - bx1;
            if (boxW > 24) {
                const label = (getSyncText(seg) || '').trim();
                if (label) {
                    const isSelected = idx === this.state.selectedSegmentIndex;
                    this.ctx.save();
                    this.ctx.beginPath();
                    this.ctx.rect(bx1 + 3, 0, boxW - 6, height);
                    this.ctx.clip();
                    this.ctx.font = '11px Inter, sans-serif';
                    this.ctx.textBaseline = 'top';
                    // 글자 폭에 맞춘 작은 반투명 칩을 깔아 가독성을 확보한다.
                    // (두꺼운 외곽선을 쓰면 글자 획보다 테두리가 굵어져 상단이
                    //  검게 뭉개지고 파형 영역 전체가 답답해 보인다.)
                    const tw = Math.min(this.ctx.measureText(label).width, boxW - 8);
                    this.ctx.fillStyle = isSelected
                        ? 'rgba(0, 0, 0, 0.55)'
                        : 'rgba(0, 0, 0, 0.35)';
                    this.ctx.fillRect(bx1 + 3, 2, tw + 6, 15);
                    this.ctx.fillStyle = isSelected
                        ? cssVar('--text-main', '#ffffff')
                        : cssVar('--text-dim', 'rgba(255,255,255,0.7)');
                    this.ctx.fillText(label, bx1 + 6, 4);
                    this.ctx.restore();
                }
            }

            // 선택된 블럭 강조 — 클릭·시크로 타겟팅된 가사가 어느 것인지 표시.
            if (idx === this.state.selectedSegmentIndex) {
                this.ctx.save();
                this.ctx.strokeStyle = cssVar('--accent-primary', '#4a9eff');
                this.ctx.lineWidth = 2;
                this.ctx.strokeRect(bx1 + 1, 1, Math.max(0, boxW - 2), height - 2);
                this.ctx.restore();
            }

            // Boundary Highlighting (on hover)
            const ht = this.state.hoveringTarget;
            if (ht && ht.index === idx) {
                this.ctx.strokeStyle = palette.segmentHover;
                this.ctx.lineWidth = 2;
                const bx = ht.type === 'start' ? x1 : x2;
                this.ctx.beginPath();
                this.ctx.moveTo(bx, 0);
                this.ctx.lineTo(bx, height);
                this.ctx.stroke();
            }

            // Selected Boundary Highlight (Yellow)
            const st = this.state.selectedTarget;
            if (st && st.index === idx) {
                this.ctx.strokeStyle = '#fbbf24'; // Amber/Yellow
                this.ctx.lineWidth = 3;
                const bx = st.type === 'start' ? x1 : x2;
                this.ctx.beginPath();
                this.ctx.moveTo(bx, 0);
                this.ctx.lineTo(bx, height);
                this.ctx.stroke();

                // Show timestamp tooltip-like text
                this.ctx.fillStyle = '#fbbf24';
                this.ctx.font = 'bold 12px Inter';
                const timeStr = (st.type === 'start' ? seg.start : seg.end).toFixed(2) + 's';
                this.ctx.fillText(timeStr, bx + 5, 20);
            }
        });

        // 2. Waveform
        if (this.state.waveformPoints) {
            this.ctx.beginPath();
            this.ctx.strokeStyle = palette.waveformStroke;
            // lineWidth를 명시한다 — 이걸 안 하면 위 세그먼트 루프에서 마지막으로
            // 설정된 값(경계 hover=2, 경계 선택=3)을 그대로 물려받아, 경계를
            // 선택하기만 해도 파형 선이 3배 굵어져 뭉개져 보였다.
            this.ctx.lineWidth = 1;
            const points = this.state.waveformPoints;
            for (let i = 0; i < width; i++) {
                const targetTime = this.xToTime(i);
                const idx = Math.floor((targetTime / this.state.duration) * points.length);
                if (idx >= 0 && idx < points.length) {
                    const p = points[idx];
                    if (p) {
                        this.ctx.moveTo(i, (1 + p[0] * 0.8) * height / 2);
                        this.ctx.lineTo(i, (1 + p[1] * 0.8) * height / 2);
                    }
                }
            }
            this.ctx.stroke();
        }

        // 3. Playhead
        if (this.state.currentTime >= startTime && this.state.currentTime <= endTime) {
            const px = this.timeToX(this.state.currentTime);
            this.ctx.strokeStyle = '#ef4444';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(px, 0);
            this.ctx.lineTo(px, height);
            this.ctx.stroke();
        }
    }

    handleZoom(factor, mouseX = null) {
        if (this.state.duration <= 0) return;

        const oldZoom = this.state.zoomLevel;
        const newZoom = Math.max(1, Math.min(200, oldZoom * factor));
        if (oldZoom === newZoom) return;

        const focusX = mouseX !== null ? mouseX : this.canvas.width / 2;
        const focusTime = this.xToTime(focusX);

        this.state.zoomLevel = newZoom;
        const newVisibleDuration = this.state.duration / newZoom;
        let newScrollTime = focusTime - (focusX / this.canvas.width) * newVisibleDuration;

        this.state.scrollTime = Math.max(0, Math.min(this.state.duration - newVisibleDuration, newScrollTime));
        this.drawWaveform();
    }

    // --- Helpers & Others ---

    async loadTrackList() {
        try {
            // 이제 분리된 오디오 목록 대신 라이브러리의 전체 원본 음원을 불러옵니다.
            this.tracks = state.songLibrary || [];

            // If currently selected track is in the list, update its display
            if (this.state.currentPath) {
                const track = this.tracks.find(t => t.path === this.state.currentPath);
                if (track) {
                    const nameEl = document.getElementById('selected-track-name');
                    if (nameEl) nameEl.innerText = track.title || "Unknown Title";
                }
            }
        } catch (e) { console.error(e); }
    }

    openTrackModal() {
        const modal = document.getElementById('alignment-track-modal');
        if (modal) {
            modal.classList.add('active');
            const searchEl = document.getElementById('alignment-track-search');
            if (searchEl) searchEl.value = '';
            this._trackSearchQuery = '';
            this.loadTrackList(); // 모달을 열 때마다 메인 라이브러리의 최신 목록으로 갱신
            this.renderTrackList();
            setTimeout(() => searchEl && searchEl.focus(), 100);
        }
    }

    closeTrackModal() {
        const modal = document.getElementById('alignment-track-modal');
        if (modal) modal.classList.remove('active');
    }

    renderTrackList() {
        const container = document.getElementById('alignment-track-list');
        if (!container) return;

        const query = (this._trackSearchQuery || '').toLowerCase().trim();
        const chipStatus = this.trackFilterStatus || 'all';

        // 검색 + 상태 칩 필터
        const matched = (this.tracks || []).filter(t => {
            if (query) {
                const s = `${t.title || ''} ${t.artist || ''}`.toLowerCase();
                if (!s.includes(query)) return false;
            }
            if (chipStatus !== 'all' && getLyricSyncStatus(t) !== chipStatus) return false;
            return true;
        });

        if (matched.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#64748b;">조건에 맞는 음원이 없습니다.</div>`;
            return;
        }

        // 상태별 그룹: 작업 대상인 '미싱크'를 최상단으로.
        const groups = [
            { key: 'unsynced', label: '미싱크 (작업 필요)', badge: '미싱크' },
            { key: 'synced', label: '싱크 완료', badge: '싱크' },
            { key: 'none', label: '가사 없음', badge: '' },
        ];
        const byStatus = { unsynced: [], synced: [], none: [] };
        matched.forEach(t => { (byStatus[getLyricSyncStatus(t)] || byStatus.none).push(t); });

        const esc = (v) => String(v || '').replace(/"/g, '&quot;');
        const trackItemHtml = (t) => {
            const title = t.title || 'Unknown Title';
            const artist = t.artist || 'Unknown Artist';
            const thumbUrl = getThumbnailUrl(t.thumbnail || '', t);
            const st = getLyricSyncStatus(t);
            const badge = st === 'synced'
                ? `<span class="track-status-badge synced">싱크</span>`
                : (st === 'unsynced' ? `<span class="track-status-badge unsynced">미싱크</span>` : '');
            const isCurrent = this.state.currentPath && t.path === this.state.currentPath;
            return `
                <div class="track-item${isCurrent ? ' current' : ''}" data-path="${esc(t.path)}">
                    <div class="track-thumb">
                        ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : `<div class="thumb-placeholder">♪</div>`}
                    </div>
                    <div class="track-info">
                        <div class="track-name" title="${esc(title)}">${title}</div>
                        <div class="track-artist" title="${esc(artist)}">${artist}</div>
                    </div>
                    ${badge}
                </div>`;
        };

        // 접힘 상태는 localStorage에 상태별로 보관.
        const collapsedKey = (k) => `trackPickerCollapsed:${k}`;
        container.innerHTML = groups.map(g => {
            const items = byStatus[g.key];
            if (items.length === 0) return '';
            const collapsed = localStorage.getItem(collapsedKey(g.key)) === 'true';
            return `
                <section class="track-group${collapsed ? ' collapsed' : ''}" data-group="${g.key}">
                    <button type="button" class="track-group-toggle">
                        <span class="track-group-title">${g.label}</span>
                        <span class="track-group-count">${items.length}</span>
                        <svg class="track-group-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>
                    <div class="track-group-body">${items.map(trackItemHtml).join('')}</div>
                </section>`;
        }).join('');

        // 그룹 접기/펴기
        container.querySelectorAll('.track-group-toggle').forEach(toggle => {
            toggle.onclick = () => {
                const section = toggle.closest('.track-group');
                const key = section?.dataset.group;
                const collapsed = section.classList.toggle('collapsed');
                if (key) localStorage.setItem(collapsedKey(key), String(collapsed));
            };
        });

        // 트랙 선택
        container.querySelectorAll('.track-item').forEach(item => {
            item.onclick = () => {
                const path = item.getAttribute('data-path');
                const name = item.querySelector('.track-name').innerText;
                const nameEl = document.getElementById('selected-track-name');
                if (nameEl) nameEl.innerText = name;
                this.loadAudio(path);
                this.closeTrackModal();
            };
        });
    }

    togglePlayback() { this.invoke('toggle_playback'); }

    formatTime(sec) {
        if (sec === undefined || sec === null || isNaN(sec)) return "--:--.-";
        const m = Math.floor(Math.abs(sec) / 60);
        const s = (Math.abs(sec) % 60).toFixed(1);
        return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.drawWaveform();
    }

    // Removed parseLrcString as it is now handled by centralized lyrics.js utility


    parseLyrics() {
        const rawLyrics = (document.getElementById('lyrics-input').value || '').replace(/\r\n/g, '\n');
        const lines = rawLyrics.split('\n');
        const hasAnyText = lines.some(l => l.trim().length > 0);

        if (!hasAnyText) {
            this.state.segments = [];
            this.state.currentSyncIndex = 0;
            this.renderLyricList();
            this.markDirtyAndScheduleSave();
            return;
        }

        const oldSegments = this.state.segments || [];
        // Ignore meaningless blank lines from pasted/original lyric text.
        const newLines = lines
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        // 3줄 모드: 원문/차음/번역을 하나의 큐로 묶음 — 스크립트 인식 그룹핑
        // (groupTripletLines). 고정 3줄 묶음은 영어 소절(원문 1줄뿐)이 섞이면
        // 이후 그룹이 전부 밀렸음.
        let newCues;
        if (this.state.tripletMode) {
            newCues = groupTripletLines(newLines);
        } else {
            newCues = newLines.map((text) => ({ text }));
        }

        // 트리플렛 큐는 원문(original) 기준으로, 일반 줄은 text 기준으로 동일 여부 판단.
        const sameIdentity = (a, b) => {
            if (isTriplet(a) || isTriplet(b)) {
                return isTriplet(a) && isTriplet(b) && a.original === b.original;
            }
            return a.text === b.text;
        };

        const newSegments = newCues.map((cue) => {
            // 1순위: 동일한 기존 큐를 찾아 시간 복사
            const exactMatch = oldSegments.find(s => sameIdentity(cue, s) && !s._used);
            if (exactMatch) {
                exactMatch._used = true;
                return { ...cue, start: exactMatch.start, end: exactMatch.end };
            }
            return { ...cue, start: 0, end: 0 };
        });

        // 2순위: 텍스트가 수정되었으나 같은 줄 번호(인덱스)에 있던 시간 복사 (오타 수정 대응)
        newSegments.forEach((seg, i) => {
            if (seg.start === 0 && oldSegments[i] && !oldSegments[i]._used) {
                seg.start = oldSegments[i].start;
                seg.end = oldSegments[i].end;
                oldSegments[i]._used = true;
            }
        });

        // 임시 플래그 정리
        oldSegments.forEach(s => delete s._used);

        this.state.segments = newSegments;
        this.state.isSyncMode = true;

        // 싱크 인덱스가 초기값이면 0으로 설정
        if (this.state.currentSyncIndex < 0) {
            this.state.currentSyncIndex = 0;
        }
        // 이미 탭이 진행된 상태라면 싱크 인덱스 유지 보정
        else if (this.state.currentSyncIndex > this.state.segments.length) {
            this.state.currentSyncIndex = this.state.segments.length;
        }

        this.renderLyricList();
        this.markDirtyAndScheduleSave();
    }

    handleTap() {
        // 일시정지 상태에서도 수동으로 찍을 수 있도록 허용 (단, 음원은 로드되어 있어야 함)
        if (this.state.duration <= 0) return;
        let idx = this.state.currentSyncIndex;
        while (idx < this.state.segments.length && !(this.state.segments[idx].text || '').trim()) {
            idx++;
        }
        this.state.currentSyncIndex = idx;
        if (idx < 0 || idx >= this.state.segments.length) return;

        const now = this.state.currentTime;
        const seg = this.state.segments[idx];
        seg.start = now;
        seg.approx = false;

        // 앞 줄이 이 줄과 겹칠 때만 끝을 당긴다. 예전에는 조건 없이
        // prev.end = now 로 붙여서 줄 사이 간격을 만들 수 없었다.
        const prev = idx > 0 ? this.state.segments[idx - 1] : null;
        if (prev && prev.start > 0 && (prev.end <= prev.start || prev.end > now)) {
            prev.end = now;
        }

        // 끝 시각을 곡 끝으로 밀지 않는다. 예전에는 end = duration 이라, 여기서
        // 그만두면 마지막으로 찍은 줄이 노래가 끝날 때까지 화면에 남았다.
        // 다음 줄이 이미 찍혀 있으면 그 앞까지, 아니면 짧은 기본 길이만 준다.
        const next = this.state.segments[idx + 1];
        const hardLimit = (next && next.start > now) ? next.start : this.state.duration;
        const provisional = Math.min(now + TAP_PROVISIONAL_SEC, hardLimit);
        if (seg.end <= now || seg.end > hardLimit) {
            seg.end = provisional;
        }

        this.state.currentSyncIndex = idx + 1;
        this.renderLyricList();
        this.drawWaveform();
        this.markDirtyAndScheduleSave();
    }

    /**
     * 방금 찍은 줄을 다시 찍는다(Shift+Enter). 한 박자 늦게 눌렀을 때 전체를
     * 다시 하지 않고 그 줄만 고칠 수 있어야 한다 — Enter는 항상 다음 줄로
     * 넘어가므로 되돌아올 방법이 없었다.
     */
    retapPrevious() {
        const idx = this.state.currentSyncIndex - 1;
        if (idx < 0 || idx >= this.state.segments.length) return;
        this.state.currentSyncIndex = idx;
        this.handleTap();
    }

    /**
     * 선택한 경계를 아주 조금 움직인다(방향키). 드래그로는 10ms 단위를 집을 수
     * 없어서, 실제 미세조정은 키보드로 해야 한다.
     */
    nudgeSelectedBoundary(deltaSec) {
        const target = this.state.selectedTarget;
        if (!target) return false;
        const idx = target.index;
        const seg = this.state.segments[idx];
        if (!seg) return false;

        const MIN_LEN = 0.05;
        if (target.type === 'start') {
            const prev = idx > 0 ? this.state.segments[idx - 1] : null;
            const lo = prev ? Math.max(0, prev.end) : 0;
            seg.start = Math.max(lo, Math.min(seg.start + deltaSec, seg.end - MIN_LEN));
        } else {
            const next = this.state.segments[idx + 1];
            const hi = (next && next.start > 0) ? next.start : this.state.duration;
            seg.end = Math.min(hi, Math.max(seg.end + deltaSec, seg.start + MIN_LEN));
        }
        seg.approx = false;
        this.renderLyricList();
        this.drawWaveform();
        this.markDirtyAndScheduleSave();
        return true;
    }

    markVocalStart() {
        if (this.state.duration <= 0) {
            showNotification('먼저 음원을 로드해주세요.', 'warning');
            return;
        }
        this.state.vocalStartSec = this.state.currentTime;
        this.state.suggestedVocalStartSec = null; // 수동 지정이 자동 제안을 대체
        this.state.suggestedVocalStartSource = null;
        this.onMarkersChanged();
        this.markDirtyAndScheduleSave();
        showNotification(`보컬 시작 지점을 ${this.formatTime(this.state.currentTime)}로 지정했습니다.`, 'success');
    }

    addInterludeAtCurrentTime() {
        if (this.state.duration <= 0) {
            showNotification('먼저 음원을 로드해주세요.', 'warning');
            return;
        }
        const center = this.state.currentTime;
        const half = 2.5;
        const start = Math.max(0, center - half);
        const end = Math.min(this.state.duration, center + half);
        if (end - start < 0.5) return;

        this.state.interludes.push({ start, end });
        this.state.interludes.sort((a, b) => a.start - b.start);
        this.onMarkersChanged();
        this.markDirtyAndScheduleSave();
        showNotification('간주 구간을 추가했습니다. 파형에서 경계를 드래그하거나 아래 마커 목록에서 시각을 직접 수정하세요.', 'info');
    }

    /**
     * Scans the already-loaded waveform (usually the isolated vocal stem,
     * since `get_waveform_summary` prefers it when the track was separated)
     * for candidate markers: a sustained low-amplitude interior stretch is
     * treated as a likely instrumental interlude, and the first sustained
     * above-threshold stretch as a likely vocal entrance. Purely a suggestion
     * — never overwrites anything the user already confirmed.
     */
    detectMarkerCandidates() {
        const points = this.state.waveformPoints;
        if (!points || !points.length || this.state.duration <= 0) return;

        const bucketDur = this.state.duration / points.length;
        const amps = points.map(p => Math.max(Math.abs(p[0] || 0), Math.abs(p[1] || 0)));
        const peak = amps.reduce((m, a) => Math.max(m, a), 0);
        if (peak <= 0) return;
        const threshold = peak * 0.08;

        // Vocal start candidate: first point sustained above threshold for ~1s.
        // 파형(진폭) 기반 보컬 시작 후보 — AI 정렬 제안이 이미 있으면 그게 더
        // 정확하므로 덮어쓰지 않는다(정렬 안 한 곡의 폴백 용도).
        if (this.state.vocalStartSec == null && this.state.suggestedVocalStartSource !== 'ai') {
            const sustainBuckets = Math.max(1, Math.round(1.0 / bucketDur));
            for (let i = 0; i < amps.length - sustainBuckets; i++) {
                let ok = true;
                for (let k = 0; k < sustainBuckets; k++) {
                    if (amps[i + k] < threshold) { ok = false; break; }
                }
                if (ok) {
                    this.state.suggestedVocalStartSec = i * bucketDur;
                    this.state.suggestedVocalStartSource = 'waveform';
                    break;
                }
            }
        }

        // Interlude candidates: interior low-amplitude runs of >=3s.
        // Runs touching the very start/end are the intro/outro, not an
        // interlude, so they're excluded here.
        const minSilenceBuckets = Math.max(1, Math.round(3.0 / bucketDur));
        const runs = [];
        let runStart = -1;
        for (let i = 0; i < amps.length; i++) {
            const low = amps[i] < threshold;
            if (low && runStart === -1) runStart = i;
            if (!low && runStart !== -1) {
                runs.push([runStart, i - 1]);
                runStart = -1;
            }
        }
        if (runStart !== -1) runs.push([runStart, amps.length - 1]);

        const overlapsConfirmed = (start, end) => this.state.interludes.some(il =>
            Math.min(end, il.end) - Math.max(start, il.start) > (end - start) * 0.5
        );

        this.state.suggestedInterludes = runs
            .filter(([s, e]) => (e - s + 1) >= minSilenceBuckets && s > 0 && e < amps.length - 1)
            .map(([s, e]) => ({ start: s * bucketDur, end: (e + 1) * bucketDur }))
            .filter(il => !overlapsConfirmed(il.start, il.end));

        this.updateMarkerSuggestionBar();
    }

    /** 마커가 바뀐 모든 지점에서 호출 — 파형과 마커 목록을 함께 갱신. */
    onMarkersChanged() {
        this.drawWaveform();
        this.renderMarkerList();
    }

    /**
     * 파형 아래 마커 목록 렌더. 행 = 번호 배지 + 라벨 + 시각 입력(간주는
     * 시작/끝 2개) + 우측 삭제 버튼. 행 클릭(입력/버튼 제외)은 파형을 그
     * 마커로 이동+확대. 마커가 하나도 없으면 패널 숨김.
     */
    renderMarkerList() {
        const panel = document.getElementById('marker-list-panel');
        if (!panel) return;

        const rows = [];
        if (this.state.vocalStartSec != null) {
            rows.push({ kind: 'vocal', label: '보컬 시작', start: this.state.vocalStartSec, end: null, idx: -1 });
        }
        this.state.interludes.forEach((il, idx) => {
            rows.push({ kind: 'interlude', label: '간주', start: il.start, end: il.end, idx });
        });

        if (rows.length === 0) {
            panel.style.display = 'none';
            panel.innerHTML = '';
            return;
        }

        panel.style.display = 'block';
        panel.innerHTML = rows.map((row, i) => `
            <div class="marker-list-row" data-kind="${row.kind}" data-idx="${row.idx}" title="클릭하면 파형이 이 마커 위치로 이동합니다">
                <span class="marker-num">${i + 1}</span>
                <span class="marker-label${row.kind === 'vocal' ? ' marker-label-vocal' : ''}">${row.label}</span>
                <input type="text" class="marker-time-input" data-field="start" value="${formatTimeInput(row.start)}" spellcheck="false" title="시작 (mm:ss.xx 또는 초)">
                ${row.end != null ? `<span class="marker-time-sep">~</span>
                <input type="text" class="marker-time-input" data-field="end" value="${formatTimeInput(row.end)}" spellcheck="false" title="끝 (mm:ss.xx 또는 초)">` : ''}
                <span class="marker-row-spacer"></span>
                <button type="button" class="marker-delete-btn" title="이 마커 삭제">×</button>
            </div>
        `).join('');

        panel.querySelectorAll('.marker-list-row').forEach((rowEl) => {
            const kind = rowEl.dataset.kind;
            const idx = parseInt(rowEl.dataset.idx, 10);
            const getMarker = () => kind === 'vocal'
                ? { start: this.state.vocalStartSec, end: null }
                : this.state.interludes[idx];

            // 행 클릭 → 파형 이동+확대 (입력/버튼 클릭은 제외)
            rowEl.addEventListener('click', (e) => {
                if (e.target.closest('input, button')) return;
                const m = getMarker();
                if (m) this.panToMarker(m.start, m.end);
            });

            // 시각 편집
            rowEl.querySelectorAll('.marker-time-input').forEach((input) => {
                input.addEventListener('change', () => {
                    const parsed = parseTimeInput(input.value);
                    const m = getMarker();
                    if (parsed == null || !m) {
                        // 무효 입력 — 현재 값으로 복원
                        input.value = formatTimeInput(input.dataset.field === 'end' ? m?.end : m?.start);
                        return;
                    }
                    const sec = Math.max(0, Math.min(parsed, this.state.duration || parsed));
                    if (kind === 'vocal') {
                        this.state.vocalStartSec = sec;
                    } else if (input.dataset.field === 'start') {
                        m.start = Math.min(sec, m.end - 0.1); // 시작은 끝보다 앞이어야
                    } else {
                        m.end = Math.max(sec, m.start + 0.1);
                    }
                    if (kind === 'interlude') this.state.interludes.sort((a, b) => a.start - b.start);
                    this.markDirtyAndScheduleSave();
                    this.onMarkersChanged();
                });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') input.blur();
                    e.stopPropagation(); // 캔버스 키보드 넛지와 충돌 방지
                });
            });

            // 삭제
            rowEl.querySelector('.marker-delete-btn').addEventListener('click', () => {
                if (kind === 'vocal') {
                    this.state.vocalStartSec = null;
                } else {
                    this.state.interludes.splice(idx, 1);
                }
                this.markDirtyAndScheduleSave();
                this.onMarkersChanged();
            });
        });
    }

    /**
     * 파형 뷰포트를 마커 위치로 이동. 간주는 구간이 화면의 ~50%를 차지하게
     * 확대하고, 점 마커(보컬 시작)는 앞뒤 5초가 보이게 잡는다.
     * handleZoom과 동일한 클램프(줌 1~200, scrollTime 0~duration-visible).
     */
    panToMarker(startSec, endSec = null) {
        const duration = this.state.duration;
        if (!duration || typeof startSec !== 'number') return;
        const span = (endSec != null && endSec > startSec) ? (endSec - startSec) : 10;
        const visibleDuration = Math.min(duration, Math.max(span * 2, 2));
        this.state.zoomLevel = Math.max(1, Math.min(200, duration / visibleDuration));
        const center = (endSec != null && endSec > startSec) ? (startSec + endSec) / 2 : startSec;
        const visible = duration / this.state.zoomLevel;
        this.state.scrollTime = Math.max(0, Math.min(center - visible / 2, duration - visible));
        this.updateScrollbar();
        this.drawWaveform();
    }

    updateMarkerSuggestionBar() {
        const bar = document.getElementById('marker-suggestion-bar');
        if (!bar) return;
        const hasVocalSuggestion = this.state.suggestedVocalStartSec != null;
        const interludeCount = this.state.suggestedInterludes.length;

        if (!hasVocalSuggestion && interludeCount === 0) {
            bar.style.display = 'none';
            bar.innerHTML = '';
            return;
        }

        bar.style.display = 'inline-flex';
        // AI 정렬 첫 줄 기준 제안은 "노래 시작"(MV 대사/영상 인트로 제외), 파형 폴백은 "보컬 시작".
        const isAi = this.state.suggestedVocalStartSource === 'ai';
        const parts = [isAi ? 'AI 감지:' : '자동 감지:'];
        if (hasVocalSuggestion) {
            const label = isAi ? '노래 시작' : '보컬 시작';
            parts.push(`${label} ${this.formatTime(this.state.suggestedVocalStartSec)}`);
            parts.push('<button type="button" id="accept-vocal-suggestion" class="marker-suggestion-btn">적용</button>');
        }
        if (interludeCount > 0) {
            parts.push(`간주 후보 ${interludeCount}개`);
            parts.push('<button type="button" id="accept-interlude-suggestions" class="marker-suggestion-btn">모두 적용</button>');
        }
        parts.push('<button type="button" id="dismiss-marker-suggestions" class="marker-suggestion-btn">닫기</button>');
        bar.innerHTML = parts.join(' ');

        const acceptVocal = document.getElementById('accept-vocal-suggestion');
        if (acceptVocal) {
            acceptVocal.onclick = () => {
                this.state.vocalStartSec = this.state.suggestedVocalStartSec;
                this.state.suggestedVocalStartSec = null;
                this.state.suggestedVocalStartSource = null;
                this.updateMarkerSuggestionBar();
                this.onMarkersChanged();
                this.markDirtyAndScheduleSave();
            };
        }
        const acceptInterludes = document.getElementById('accept-interlude-suggestions');
        if (acceptInterludes) {
            acceptInterludes.onclick = () => {
                this.state.interludes.push(...this.state.suggestedInterludes);
                this.state.interludes.sort((a, b) => a.start - b.start);
                this.state.suggestedInterludes = [];
                this.updateMarkerSuggestionBar();
                this.onMarkersChanged();
                this.markDirtyAndScheduleSave();
            };
        }
        const dismiss = document.getElementById('dismiss-marker-suggestions');
        if (dismiss) {
            dismiss.onclick = () => {
                this.state.suggestedVocalStartSec = null;
                this.state.suggestedVocalStartSource = null;
                this.state.suggestedInterludes = [];
                this.updateMarkerSuggestionBar();
                this.drawWaveform();
            };
        }
    }

    /** AI가 놓은(approx) 줄 중 음향 신뢰도가 낮아 사용자 검토가 권장되는 줄인지.
     *  신뢰도(0~1)는 백엔드가 준 line.confidence를 세그먼트에 실은 값이다.
     *  고친 줄은 다음 정렬에서 하드 앵커가 되어 정확도가 누적된다. */
    _needsReview(s) {
        return !!(s && s.approx) && typeof s.confidence === 'number' && s.confidence < 0.45;
    }

    _isEstimatedSync(s) {
        return s?.alignmentSource === 'anchor_interpolation';
    }

    /** 지금 재생 위치가 걸쳐 있는 줄의 인덱스. 없으면 -1. */
    _playingIndex() {
        const t = this.state.currentTime;
        const segs = this.state.segments || [];
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (s.start > 0 && t >= s.start && (s.end === 0 || t < s.end)) return i;
        }
        return -1;
    }

    /**
     * 원문 목록에서 지금 부르는 줄을 표시한다.
     *
     * 파형에서는 위치를 알 수 있어도 "어느 원문 줄인지"는 세어 봐야 알 수 있어,
     * 가사를 고쳐야 할 때 찾기가 어려웠다. 목록 전체를 다시 그리지 않고 클래스만
     * 옮긴다 — 재생 중 매 프레임 innerHTML을 갈아끼우면 편집 중인 칸이 날아간다.
     */
    highlightPlayingLyric() {
        const container = document.getElementById('lyric-lines-container');
        if (!container) return;
        const idx = this._playingIndex();
        if (idx === this._lastPlayingIdx) return;
        this._lastPlayingIdx = idx;

        container.querySelectorAll('.lyric-line-item').forEach((el, i) => {
            el.classList.toggle('now-playing', i === idx);
        });
        // 편집 중이 아닐 때만 따라 스크롤한다 — 고치는 중에 화면이 움직이면 안 된다.
        if (idx >= 0 && !container.querySelector('.lyric-text[contenteditable="true"]')) {
            container.querySelectorAll('.lyric-line-item')[idx]
                ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    renderLyricList() {
        const container = document.getElementById('lyric-lines-container');
        if (!container) return;
        const reviewBadge = (segment) => this._isEstimatedSync(segment)
            ? '<span class="review-badge estimated-badge" title="음향 정렬이 끝까지 확정되지 않아 앞뒤 앵커와 보컬 활동도로 추정한 싱크입니다. 우선 확인해 주세요.">추정 싱크</span>'
            : '<span class="review-badge" title="AI 정렬 신뢰도가 낮은 줄입니다. 들어보고 필요하면 시간을 직접 맞춰 주세요 — 고치면 다음 자동 정렬의 기준(앵커)이 됩니다.">확인</span>';
        const toggleBtn = document.getElementById('toggle-translation-btn');
        if (toggleBtn) {
            const showing = getShowTranslation();
            toggleBtn.textContent = showing ? '번역 숨기기' : '번역 보기';
            toggleBtn.classList.toggle('active-toggle', showing);
        }
        container.innerHTML = this.state.segments.map((s, i) => {
            if (isTriplet(s)) {
                const displayLines = getDisplayLines(s);
                const html = displayLines.length
                    ? displayLines.map((l, li) => `<span class="triplet-line triplet-line-${li}">${l}</span>`).join('')
                    : '&nbsp;';
                return `
            <div class="lyric-line-item${this._needsReview(s) ? ' needs-review' : ''}${this._isEstimatedSync(s) ? ' estimated-sync' : ''}" data-index="${i}">
                <span class="time-range" title="이 시간으로 재생 이동">${this.formatTime(s.start)}</span>
                <span class="lyric-text triplet-text" title="이 가사 위치로 탐색 및 타겟 지정">${html}</span>
                ${this._needsReview(s) ? reviewBadge(s) : ''}
            </div>
        `;
            }
            return `
            <div class="lyric-line-item${this._needsReview(s) ? ' needs-review' : ''}${this._isEstimatedSync(s) ? ' estimated-sync' : ''}" data-index="${i}">
                <span class="time-range" title="이 시간으로 재생 이동">${this.formatTime(s.start)}</span>
                <span class="lyric-text" title="이 가사 위치로 탐색 및 타겟 지정">${(s.text && s.text.trim()) ? s.text : '&nbsp;'}</span>
                ${this._needsReview(s) ? reviewBadge(s) : ''}
            </div>
        `;
        }).join('');

        // 원문 고치기 — 더블클릭하면 그 자리에서 바로 편집한다.
        // 파형에서 위치는 보이는데 원문을 고치려면 다른 화면으로 나가야 했다.
        container.querySelectorAll('.lyric-line-item').forEach((item) => {
            const textEl = item.querySelector('.lyric-text');
            if (!textEl || textEl.classList.contains('triplet-text')) return; // 3줄 모드는 제외
            textEl.ondblclick = (e) => {
                e.stopPropagation();
                const idx = parseInt(item.getAttribute('data-index'), 10);
                textEl.contentEditable = 'true';
                textEl.spellcheck = false;
                textEl.classList.add('editing');
                textEl.focus();
                document.getSelection()?.selectAllChildren(textEl);

                const commit = (save) => {
                    textEl.contentEditable = 'false';
                    textEl.classList.remove('editing');
                    const seg = this.state.segments[idx];
                    if (!seg) return;
                    if (save) {
                        const next = (textEl.textContent || '').trim();
                        if (next !== (seg.text || '')) {
                            seg.text = next;
                            this.markDirtyAndScheduleSave();
                        }
                    }
                    this.renderLyricList();
                };
                textEl.onblur = () => commit(true);
                textEl.onkeydown = (ev) => {
                    ev.stopPropagation();       // 편집 중에는 Enter=싱크 찍기가 돌면 안 된다
                    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
                    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
                };
            };
        });

        // 클릭 이벤트 추가 (기능 분리: 이동 vs 타겟 지정)
        container.querySelectorAll('.lyric-line-item').forEach((item) => {
            item.onclick = async (e) => {
                const idx = parseInt(item.getAttribute('data-index'));
                const targetTime = this.state.segments[idx].start;

                // 가사나 시간을 클릭하면 해당 위치로 이동 (시간이 0보다 클 때)
                if (targetTime > 0) {
                    this.state.currentTime = targetTime;
                    this.updateTimeDisplay();
                    this.drawWaveform();
                    try {
                        await this.invoke('seek_to', { positionMs: Math.floor(targetTime * 1000) });
                    } catch (err) {
                        console.error("Seek failed:", err);
                    }
                }

                if (targetTime > 0) {
                    // 시간이 찍혀 있는(이동 가능한) 가사를 클릭했다면, 자연스럽게 다음 가사부터 스탬프를 찍도록 대기
                    this.state.currentSyncIndex = Math.min(idx + 1, this.state.segments.length);
                } else {
                    // 아직 시간이 없는 가사를 클릭하면 그 가사부터 스탬프를 찍도록 지정
                    this.state.currentSyncIndex = idx;
                }

                // 클릭한 가사를 타겟으로 고정 — 재생하거나 다른 조작을 해도
                // 시간이 이 블럭을 벗어나기 전까지는 계속 선택 상태로 남는다.
                this.state.selectedSegmentIndex = idx;
                this.drawWaveform();

                this.syncSidebar(true);
            };
        });

        // Force an immediate sync and scroll
        this.syncSidebar(true);
    }

    /**
     * 주어진 시각이 속한 가사 블럭 인덱스를 찾는다. 없으면 -1.
     * 시간이 찍힌(start>0) 블럭만 대상 — 미싱크 줄은 위치가 없어 제외.
     * end가 0(끝 미지정)이면 다음 블럭 시작 전까지로 본다.
     */
    findSegmentAtTime(time) {
        const segs = this.state.segments || [];
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (!(s.start > 0)) continue;
            const end = s.end > 0 ? s.end : (segs[i + 1]?.start ?? this.state.duration);
            if (time >= s.start && time < end) return i;
        }
        return -1;
    }

    /**
     * 타겟 가사 블럭을 지정한다. 시각으로 옮겨온 경우(파형/플레이바) 그 시각의
     * 블럭을 찾아 선택하고, 해당하는 블럭이 없으면 선택을 유지한다(재생 중
     * 간주 구간에서 선택이 깜빡이며 풀리지 않도록).
     */
    setSelectedSegmentByTime(time) {
        const idx = this.findSegmentAtTime(time);
        if (idx !== -1 && idx !== this.state.selectedSegmentIndex) {
            this.state.selectedSegmentIndex = idx;
            this.syncSidebar(true);
            this.drawWaveform();
        }
    }

    syncSidebar(forceScroll = false) {
        if (!this.state.segments || this.state.segments.length === 0) return;

        let playingIndex = -1;
        // 1. Find the currently playing segment
        for (let i = 0; i < this.state.segments.length; i++) {
            const s = this.state.segments[i];
            if (s.start > 0 && this.state.currentTime >= s.start && (s.end === 0 || this.state.currentTime < s.end)) {
                playingIndex = i;
            }
        }

        const syncIndex = this.state.currentSyncIndex;

        const container = document.getElementById('lyric-lines-container');
        if (!container) return;

        const items = container.querySelectorAll('.lyric-line-item');
        let shouldScroll = forceScroll;

        items.forEach((item, i) => {
            // 재생 중인 가사 하이라이트 (active)
            if (i === playingIndex) {
                if (!item.classList.contains('active')) {
                    item.classList.add('active');
                    shouldScroll = true;
                }
            } else {
                item.classList.remove('active');
            }

            // 앞으로 찍을 가사 하이라이트 (syncing)
            if (i === syncIndex) {
                if (!item.classList.contains('syncing')) {
                    item.classList.add('syncing');
                    shouldScroll = true;
                }
            } else {
                item.classList.remove('syncing');
            }

            // 타겟팅된 가사(선택) — 클릭으로 고정하거나 시간 이동으로 따라온 블럭
            if (i === this.state.selectedSegmentIndex) {
                if (!item.classList.contains('targeted')) {
                    item.classList.add('targeted');
                    shouldScroll = true;
                }
            } else {
                item.classList.remove('targeted');
            }
        });

        if (shouldScroll) {
            // 선택(targeted)이 있으면 그걸 우선, 없으면 탭 할 위치(syncing),
            // 그것도 없으면 재생 중(active) 위치로 스크롤.
            const hasTargeted = this.state.selectedSegmentIndex >= 0;
            const targetClass = hasTargeted
                ? '.targeted'
                : (syncIndex !== -1 && syncIndex < this.state.segments.length ? '.syncing' : '.active');
            const targetItem = container.querySelector(`.lyric-line-item${targetClass}`);
            if (targetItem) {
                targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    updateSaveStatus(text, isError = false) {
        const el = document.getElementById('sync-save-status');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? '#f87171' : '#94a3b8';
    }

    markDirtyAndScheduleSave() {
        if (!this.state.currentPath) return;
        this.isDirty = true;
        this.updateSaveStatus('저장 대기...');
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
        }
        this.autoSaveTimer = setTimeout(() => {
            this.autoSaveTimer = null;
            this.saveLrc(true);
        }, this.autoSaveDelayMs);
    }

    async flushAutoSaveIfNeeded() {
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
        if (this.isDirty) {
            await this.saveLrc(true);
        }
    }

    /**
     * No alignment model is installed — offer to download one. Downloads are
     * large (~1.2GB), so this always confirms with the user first and states
     * the size, rather than downloading silently.
     * @returns {Promise<boolean>} whether a model was successfully downloaded
     */
    async offerAlignmentModelDownload(lang = null) {
        let downloadable = [];
        try {
            downloadable = await this.invoke('list_downloadable_alignment_models');
        } catch (err) {
            console.error('list_downloadable_alignment_models failed:', err);
        }
        if (!downloadable || downloadable.length === 0) {
            showNotification('설치된 AI 정렬 모델이 없고, 다운로드 가능한 모델 목록도 비어있습니다.', 'error');
            return false;
        }
        // 선택 언어에 해당하는 다운로드 항목을 고름(없으면 첫 항목).
        let entry = downloadable[0];
        if (lang) {
            const { ALIGNMENT_LANGUAGES } = await import('./alignment-model.js');
            const wantId = ALIGNMENT_LANGUAGES[lang]?.downloadableId;
            const matched = downloadable.find(([id]) => id === wantId);
            if (matched) entry = matched;
        }
        const [modelId, displayName] = entry;
        const proceed = confirm(`AI 정렬 모델이 설치되어 있지 않습니다.\n\n"${displayName}"\n\n이 모델을 다운로드할까요? (다운로드에 시간이 걸릴 수 있습니다)`);
        if (!proceed) return false;

        const statusEl = document.getElementById('ai-align-status');
        if (statusEl) statusEl.textContent = 'AI 정렬 모델 다운로드 중...';
        try {
            await this.invoke('download_alignment_model', { modelId });
            showNotification('AI 정렬 모델 다운로드가 완료되었습니다.', 'success');
            return true;
        } catch (err) {
            showNotification('모델 다운로드 실패: ' + err, 'error');
            return false;
        } finally {
            if (statusEl) statusEl.textContent = '';
        }
    }

    async cancelAiAlignment() {
        // 중지는 즉시 끝나지 않는다(추론 중이면 청크 경계까지 기다린다). 누른
        // 순간 화면이 그대로면 눌렸는지 알 수 없어 계속 누르게 되므로, 먼저
        // 버튼을 잠그고 '중지 중'을 띄운 뒤 실제 취소를 보낸다.
        this.cancelPending = true;
        this.updateAiAlignButtonState();

        try {
            const { cancelAlignmentQueueItem } = await import('./alignment-queue.js');
            await cancelAlignmentQueueItem(this.state.currentPath);
        } catch (err) {
            console.error('cancelAlignmentQueueItem failed:', err);
            // 취소 요청 자체가 실패하면 잠가둘 이유가 없다 — 다시 누를 수 있게.
            this.cancelPending = false;
            showNotification('중지 요청을 보내지 못했습니다.', 'error');
        }
        this.updateAiAlignButtonState();
    }

    /**
     * 현재 곡이 정렬 대기열에 있으면(대기/처리 중) "AI 자동 정렬" 버튼을
     * 변환 중 표시로 바꾸고 취소 버튼을 보여준다. 상세 진행률은 여기 대신
     * AI 프로세싱 탭(대기열 카드)에서 확인.
     */
    updateAiAlignButtonState() {
        const btn = document.getElementById('ai-align-btn');
        if (!btn) return;
        const item = (state.alignmentQueue || []).find((i) => i.path === this.state.currentPath);
        const busy = !!item && (item.status === 'queued' || item.status === 'processing');

        // 대기열에서 빠졌으면 중지가 끝난 것 — 잠금을 푼다.
        if (!busy) this.cancelPending = false;

        btn.disabled = busy;
        btn.textContent = busy
            ? (this.cancelPending ? '중지 중…' : (item.status === 'queued' ? '대기 중' : '정렬 중'))
            : 'AI 자동 정렬';

        const cancelBtn = document.getElementById('ai-align-cancel-btn');
        if (cancelBtn) {
            cancelBtn.style.display = busy ? '' : 'none';
            cancelBtn.disabled = this.cancelPending;
            cancelBtn.textContent = this.cancelPending ? '중지 중…' : '중지';
        }
    }

    /**
     * 정렬 대기열이 한 곡을 끝냈을 때 호출(alignment-queue.js의 완료 리스너).
     * 그 곡이 지금 에디터에 열려 있으면 정렬 결과를 in-memory 세그먼트에 병합해
     * approx(점선) 표시까지 그대로 반영한다. 다른 곡이면 무시(파일은 이미 저장됨).
     */
    onQueueAlignmentDone(path, lines, preparedSegments = null) {
        if (!path || path !== this.state.currentPath) return;
        if (!Array.isArray(lines) || lines.length === 0) return;
        if (Array.isArray(preparedSegments) && preparedSegments.length > 0) {
            // The queue returns the original LRC representation with timing
            // only; temporary phonetic alignment text is never persisted.
            this.state.segments = preparedSegments.map((s) => ({ ...s }));
        }
        const adoptedPrepared = Array.isArray(preparedSegments) && preparedSegments.length > 0;
        const applied = mergeAlignmentResult(this.state.segments, lines);
        if (applied > 0 || adoptedPrepared) {
            this.renderLyricList();
            this.drawWaveform();
            // 대기열이 이미 LRC로 저장했으므로 여기서 다시 dirty로 만들지 않음.
            this.isDirty = false;
            this.updateSaveStatus('저장됨');
        }
        // MV 인트로 자동 감지: 사용자가 보컬 시작을 아직 안 정했으면, 정렬된
        // 첫 가사 줄 시각을 "노래 시작" 후보로 제안(파형 진폭보다 정확 —
        // 대사/영상 인트로를 무시). 제안 바에서 원클릭 적용.
        if (this.state.vocalStartSec == null) {
            const suggested = suggestVocalStartFromSegments(this.state.segments);
            if (suggested != null) {
                this.state.suggestedVocalStartSec = suggested;
                this.state.suggestedVocalStartSource = 'ai';
                this.updateMarkerSuggestionBar();
                this.drawWaveform();
            }
        }
    }

    /**
     * Runs AI forced alignment: matches the pasted lyrics text to the audio
     * using an ONNX ASR model (Rust CTC/Viterbi engine, see alignment.rs).
     * Only fills in segments that are still fully unsynced (start===0 &&
     * end===0) — same non-destructive rule as the BPM grid tool — so it never
     * clobbers a line the user already tapped/dragged by hand. Results are
     * marked `approx: true` since singing-voice ASR accuracy is inherently
     * imperfect; the user is expected to review/adjust afterward.
     */
    async runAiAlignment() {
        if (this.state.duration <= 0 || !this.state.currentPath) {
            showNotification('먼저 음원을 로드해주세요.', 'warning');
            return;
        }
        // 3줄(원문/차음/번역) 모드에서는 차음(한글 발음) 줄만 정렬 대상으로 보냄 —
        // 한국어 전용 CTC 모델은 원문(예: 일본어)을 토큰화하지 못하고, 노래는 실제로
        // 차음에 가깝게 불리므로 오디오와 가장 잘 맞음.
        const syncLyrics = (this.state.segments || [])
            .map((seg) => getSyncText(seg).trim())
            .filter((t) => t.length > 0)
            .join('\n');
        if (!syncLyrics) {
            showNotification('먼저 가사를 입력해주세요.', 'warning');
            return;
        }

        const btn = document.getElementById('ai-align-btn');
        const statusEl = document.getElementById('ai-align-status');

        // 선택한 정렬 언어의 모델이 설치돼 있는지 확인 — 없으면 그 언어 모델
        // 다운로드를 먼저 제안(배치 처리기는 프롬프트를 안 띄우므로 여기서 처리).
        // 랩/혼합 모드는 한국어·영어 모델이 모두 필요해 언어별로 각각 확인한다.
        const { getAlignmentLanguage, findModelForLanguage, requiredLanguagesFor } = await import('./alignment-model.js');
        const lang = getAlignmentLanguage();
        let models = [];
        try {
            models = await this.invoke('get_model_list');
        } catch (err) {
            showNotification('AI 정렬 모델 목록을 불러오지 못했습니다: ' + err, 'error');
            return;
        }
        for (const requiredLang of requiredLanguagesFor(lang)) {
            if (findModelForLanguage(models, requiredLang)) continue;
            const downloaded = await this.offerAlignmentModelDownload(requiredLang);
            if (!downloaded) return;
            try {
                models = await this.invoke('get_model_list');
            } catch (err) {
                showNotification('AI 정렬 모델 목록을 불러오지 못했습니다: ' + err, 'error');
                return;
            }
            if (!findModelForLanguage(models, requiredLang)) {
                showNotification('모델 다운로드 후에도 선택한 언어의 정렬 모델을 찾지 못했습니다.', 'error');
                return;
            }
        }

        // 대기열이 저장된 LRC를 읽어 정렬하므로, 현재 편집 중인 가사(붙여넣은
        // 미싱크 줄 포함)를 먼저 파일로 저장한 뒤 대기열에 넣는다.
        if (btn) btn.disabled = true;
        if (statusEl) statusEl.textContent = '대기열 등록 중...';
        try {
            await this.flushAutoSaveIfNeeded();
            await this.saveLrc(true);

            const { enqueueAlignment, isAlignmentBusy } = await import('./alignment-queue.js');
            const wasBusy = isAlignmentBusy();
            const added = enqueueAlignment([this.state.currentPath]);

            if (added > 0) {
                showNotification(
                    wasBusy
                        ? '다른 정렬이 진행 중이라 대기열에 추가했습니다. AI 프로세싱 탭에서 진행 상황을 볼 수 있어요.'
                        : 'AI 정렬을 시작했습니다. AI 프로세싱 탭에서 진행 상황을 볼 수 있어요.',
                    'success'
                );
            } else {
                showNotification('이 곡은 이미 정렬 대기열에 있거나 처리 중입니다.', 'info');
            }
        } catch (err) {
            console.error('AI alignment enqueue failed:', err);
            showNotification('AI 정렬 대기열 등록 실패: ' + err, 'error');
        } finally {
            // 등록됐으면 버튼이 '변환 중' 표시로 남고, 실패했으면 원상 복구.
            this.updateAiAlignButtonState();
            if (statusEl) statusEl.textContent = '';
        }
    }

    updateLyricsLinkButton(url) {
        const btn = document.getElementById('lyrics-link-btn');
        if (!btn) return;
        this._lyricsLinkUrl = url || '';
        btn.style.display = this._lyricsLinkUrl ? 'inline-flex' : 'none';
    }

    async openLyricsLink() {
        const url = this._lyricsLinkUrl;
        if (!url) return;
        try {
            if (window.__TAURI__?.opener?.openUrl) {
                await window.__TAURI__.opener.openUrl(url);
            } else {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        } catch (err) {
            console.error('Failed to open lyrics link:', err);
            showNotification('링크를 여는 데 실패했습니다: ' + err, 'error');
        }
    }

    async saveLrc(silent = false) {
        const syncableSegments = (this.state.segments || []).filter(s => (s.text || '').trim().length > 0);
        const hasMarkers = this.state.vocalStartSec != null || (this.state.interludes || []).length > 0;
        if (!this.state.currentPath || (syncableSegments.length === 0 && !hasMarkers)) {
            if (!silent) showNotification('저장할 가사 데이터가 없습니다.', 'error');
            return;
        }
        if (this.isAutoSaving) return;
        try {
            this.isAutoSaving = true;
            this.updateSaveStatus('저장 중...');
            // 가사 줄은 세그먼트 순서 그대로, 마커는 파일 끝에 시간순으로 기록
            // (encodeLrc 참고 — 시간순 전체 정렬은 미싱크 줄(0초)을 상단으로
            // 몰아 가사 순서를 뒤섞던 버그가 있어 폐기).
            const markerEntries = [];
            if (this.state.vocalStartSec != null) {
                markerEntries.push({ time: this.state.vocalStartSec, line: formatMarkerLine(this.state.vocalStartSec, 'vocalstart') });
            }
            (this.state.interludes || []).forEach((il) => {
                markerEntries.push({ time: il.start, line: formatMarkerLine(il.start, 'ilstart') });
                markerEntries.push({ time: il.end, line: formatMarkerLine(il.end, 'ilend') });
            });
            markerEntries.sort((a, b) => a.time - b.time);
            const content = encodeLrc(syncableSegments, markerEntries.map(e => e.line));
            await this.invoke('save_lrc_file', { audioPath: this.state.currentPath, content });

            // Reflect lyric availability/sync status immediately without a reload.
            // 저장한 세그먼트 중 실제 타임스탬프(start>0)가 하나라도 있으면 'synced'.
            const anySynced = (this.state.segments || []).some(s => (s.start || 0) > 0);
            const newStatus = anySynced ? 'synced' : 'unsynced';
            const targetPath = this.state.currentPath;
            const applyStatus = (song) => {
                if (!song) return;
                song.hasLyrics = true;
                song.has_lyrics = true;
                song.lyricSyncStatus = newStatus;
                song.lyric_sync_status = newStatus;
            };
            applyStatus(state.songLibrary.find(song => song.path === targetPath));
            if (state.currentTrack && state.currentTrack.path === targetPath) {
                applyStatus(state.currentTrack);
            }
            // 라이브러리가 보이는 상태면 배지/필터 즉시 갱신.
            if (state.activeView === 'library') {
                import('./ui/library.js').then(m => { if (m.renderLibrary) m.renderLibrary(); }).catch(() => {});
            }

            // 방금 저장한 곡이 지금 재생 중인 곡일 때만 표시용 가사를 갈아끼운다.
            // 다른 곡을 틀어둔 채 편집하면 재생 중인 곡의 가사·오버레이가 편집
            // 중인 곡 것으로 바뀌어, 방송에 엉뚱한 가사가 나간다.
            const editedIsPlaying = !!state.currentTrack
                && state.currentTrack.path === this.state.currentPath;
            if (editedIsPlaying) {
                const parsedLyrics = parseLrc(content, this.state.duration || 0);
                state.currentLyrics = parsedLyrics;
                state.currentLyricIndex = -1;
                import('./lyric-drawer.js').then(m => {
                    if (m.updateLyrics) m.updateLyrics(parsedLyrics);
                });
            }
            import('./ui/components.js').then(m => {
                if (m.updateAiTogglesState) m.updateAiTogglesState();
            });

            this.isDirty = false;
            this.lastSavedAt = Date.now();
            this.updateSaveStatus('저장됨');
            if (!silent) showNotification('가사 싱크 저장 완료', 'success');
        } catch (err) {
            console.error(err);
            this.updateSaveStatus('저장 실패', true);
            showNotification('LRC 저장 실패: ' + err, 'error');
        } finally {
            this.isAutoSaving = false;
        }
    }
}
