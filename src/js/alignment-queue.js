/**
 * alignment-queue.js — AI 가사 정렬 배치 대기열 (헤드리스 순차 처리기)
 *
 * 라이브러리에서 여러 곡을 선택해 일괄 정렬을 요청하면, 여기서 한 곡씩
 * 순서대로 처리한다: LRC 로드 → 미싱크 가사 추출 → run_forced_alignment →
 * 결과 병합(mergeAlignmentResult, 에디터와 동일 규칙) → LRC 저장.
 *
 * 반드시 엄격한 순차 처리여야 한다 — 백엔드의 `alignment-progress` 이벤트에는
 * 곡 식별자가 없어서, "지금 processing인 항목이 곧 이 이벤트의 주인"이라는
 * 가정으로 진행률을 귀속시키기 때문. (백엔드 쪽도 ALIGNMENT_QUEUE_LOCK으로
 * 직렬화되므로, 에디터의 단발 정렬 버튼과 겹쳐도 상태가 꼬이지 않는다.)
 */
import { invoke, listen } from './tauri-bridge.js';
import { state } from './state.js';
import { parseLrc, parseMarkers, mergeAlignmentResult, getSyncText, encodeLrc } from './lrc-parser.js';
import { showNotification } from './utils.js';

let isRunning = false;
let listenerReady = false;

// 한 항목의 정렬이 성공적으로 끝났을 때 (path, alignmentLines)로 호출되는
// 리스너들. 가사 싱크 에디터가 지금 열어둔 곡이 처리되면 결과를 즉시
// 반영(in-memory 병합, approx 표시 보존)하는 데 쓴다.
const itemCompleteListeners = [];
export function onAlignmentItemComplete(cb) {
    if (typeof cb === 'function') itemCompleteListeners.push(cb);
}
function notifyItemComplete(path, lines) {
    itemCompleteListeners.forEach((cb) => {
        try { cb(path, lines); } catch (e) { console.error('[AlignQueue] complete listener failed:', e); }
    });
}

/** 대기열에 처리 중이거나 대기 중인 항목이 있는지. */
export function isAlignmentBusy() {
    return state.alignmentQueue.some((i) => i.status === 'queued' || i.status === 'processing');
}

// ── MR 분리 후 정렬 (노래 추가 원스톱 흐름) ─────────────────────────
// 정렬 엔진은 분리된 보컬 스템을 우선 사용하므로, 분리와 정렬을 함께
// 요청한 곡은 분리가 끝난 뒤에 정렬을 걸어야 정확하다. 분리 완료 이벤트는
// backend.js의 separation-progress 리스너가 받아 onSeparationTerminated를
// 호출해준다.
const pendingAfterSeparation = new Set();

/** 이 곡의 정렬을 분리 종료 시점까지 미룬다. */
export function deferAlignmentUntilSeparated(path) {
    if (path) pendingAfterSeparation.add(path);
}

/**
 * 분리가 종료(완료/오류/취소)된 곡에 미뤄둔 정렬이 있으면 대기열에 등록.
 * 오류/취소로 끝나도 정렬은 진행한다 — 가사는 이미 저장돼 있고, 원본
 * 음원으로도 정렬은 (정확도는 낮지만) 가능하므로 사용자의 요청을 버리지
 * 않는다. matches는 유튜브 URL 변형까지 비교하는 backend.js의 pathMatches.
 */
export function onSeparationTerminated(path, matches = null) {
    for (const pending of [...pendingAfterSeparation]) {
        if (pending === path || (matches && matches(pending, path))) {
            pendingAfterSeparation.delete(pending);
            enqueueAlignment([pending]);
        }
    }
}

function notifyQueueChanged() {
    persistQueue();
    import('./ui/components.js').then((m) => {
        if (m.updateTaskUI) m.updateTaskUI();
    }).catch(() => {});
    // 가사 싱크 에디터 등 큐 상태에 반응해야 하는 UI용 (예: "AI 자동 정렬"
    // 버튼의 변환 중 표시). 직접 import 대신 이벤트로 느슨하게 연결.
    try { window.dispatchEvent(new CustomEvent('alignment-queue-changed')); } catch (e) {}
}

// ── 대기열 영속화 ───────────────────────────────────────────────────
// 정렬은 곡당 수십 초~분 단위라 작업 도중 앱을 끄거나 PC를 재시작하는 일이
// 흔하다. 아직 끝나지 않은 항목만 저장해 뒀다가 다음 실행에서 이어서 처리한다.
// (완료/오류/취소 등 종결 항목은 남길 이유가 없어 저장하지 않는다.)
const QUEUE_STORAGE_KEY = 'alignmentQueueV1';

function persistQueue() {
    try {
        const pending = (state.alignmentQueue || [])
            .filter((i) => i.status === 'queued' || i.status === 'processing')
            .map((i) => ({ path: i.path, title: i.title, thumbnail: i.thumbnail }));
        if (pending.length === 0) localStorage.removeItem(QUEUE_STORAGE_KEY);
        else localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(pending));
    } catch (err) {
        console.warn('[AlignQueue] persist failed:', err);
    }
}

/**
 * 앱 시작 시 호출 — 지난 실행에서 남은 정렬 항목을 복원하고 이어서 처리한다.
 * 처리 중이던 항목도 백엔드 작업은 이미 사라졌으므로 '대기 중'으로 되돌린다.
 */
export function restoreAlignmentQueue() {
    let saved = [];
    try {
        const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
        if (!raw) return 0;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) saved = parsed;
    } catch (err) {
        console.warn('[AlignQueue] restore failed:', err);
        return 0;
    }

    let restored = 0;
    saved.forEach((item) => {
        if (!item || !item.path) return;
        if (state.alignmentQueue.some((i) => i.path === item.path)) return;
        const song = state.songLibrary.find((s) => s.path === item.path);
        state.alignmentQueue.push({
            path: item.path,
            title: song?.title || item.title || item.path,
            thumbnail: song?.thumbnail || item.thumbnail || '',
            status: 'queued',
        });
        restored++;
    });

    if (restored > 0) {
        notifyQueueChanged();
        runQueue();
    }
    return restored;
}

function currentProcessingItem() {
    return state.alignmentQueue.find((item) => item.status === 'processing') || null;
}

async function ensureProgressListener() {
    if (listenerReady) return;
    listenerReady = true;
    await listen('alignment-progress', (event) => {
        const item = currentProcessingItem();
        if (!item) return; // 에디터의 단발 정렬 진행률 — 대기열 소관 아님
        const p = Number(event.payload);
        if (p === -1) {
            // 백엔드 락 대기 센티널 — 이미 '대기 중' 표시라 그대로 둠
            return;
        }
        if (p === -2) {
            // 전처리 + 모델 로드 준비 단계 — 0%가 아니라 "준비 중"으로 표시.
            item.phase = 'preparing';
            notifyQueueChanged();
            return;
        }
        if (Number.isFinite(p)) {
            // 실제 추론 진행률 도착 → 정렬 단계로 전환. 듀얼(랩/혼합) 모드는
            // 패스마다 offset/scale을 걸어 전체 0~100%로 이어 보이게 한다.
            item.phase = 'aligning';
            const scaled = (item.progressOffset || 0) + p * (item.progressScale || 1);
            item.percentage = Math.max(0, Math.min(100, scaled));
            notifyQueueChanged();
        }
    });
}

/** 선택한 정렬 언어(localStorage)에 필요한 설치 모델들을 언어별로 반환.
 *  단일 언어는 1개, 랩/혼합은 ko+en 2개. 하나라도 없으면 null(배치 중에는
 *  다운로드 프롬프트를 띄우지 않음). 반환: [{lang, model}] */
async function resolveAlignmentModels() {
    let models = [];
    try {
        models = await invoke('get_model_list');
    } catch (err) {
        console.error('[AlignQueue] get_model_list failed:', err);
        return null;
    }
    const { getAlignmentLanguage, findModelForLanguage, requiredLanguagesFor } = await import('./alignment-model.js');
    const langs = requiredLanguagesFor(getAlignmentLanguage());
    const resolved = [];
    for (const lang of langs) {
        const model = findModelForLanguage(models, lang);
        if (!model) return null;
        resolved.push({ lang, model });
    }
    return resolved;
}

/**
 * 현재 정렬 언어(localStorage)에 필요한 정렬 모델이 설치돼 있는지 확인하고,
 * 없으면 사용자에게 다운로드 여부를 묻고 받는다. 노래 추가·배치 정렬을 걸기
 * 전에 호출해, "모델이 없어 대기열 항목만 조용히 실패"하는 상황을 막는다.
 *
 * @returns {Promise<boolean>} 정렬을 진행해도 되는지(모델 준비 완료 = true).
 *   사용자가 다운로드를 거절했거나 실패하면 false.
 */
export async function ensureAlignmentModelsReady() {
    let models = [];
    try {
        models = await invoke('get_model_list');
    } catch (err) {
        console.error('[AlignQueue] get_model_list failed:', err);
    }
    const { getAlignmentLanguage, missingModelsForLanguage } = await import('./alignment-model.js');
    const missing = missingModelsForLanguage(models, getAlignmentLanguage());
    if (missing.length === 0) return true;

    const names = missing.map((m) => m.label).join(', ');
    const ok = confirm(
        `AI 자동 정렬에 필요한 정렬 모델이 없습니다: ${names}\n\n`
        + '지금 다운로드할까요? (모델당 수백 MB, 시간이 걸릴 수 있습니다)'
    );
    if (!ok) return false;

    for (const m of missing) {
        try {
            showNotification(`정렬 모델(${m.label}) 다운로드 중…`, 'info');
            await invoke('download_alignment_model', { modelId: m.downloadableId });
        } catch (err) {
            console.error('[AlignQueue] download_alignment_model failed:', m.downloadableId, err);
            showNotification(`정렬 모델(${m.label}) 다운로드 실패: ${err}`, 'error');
            return false;
        }
    }
    showNotification('정렬 모델 다운로드 완료.', 'success');
    return true;
}

/** 원본 LRC에서 마커 줄([vocalstart]/[ilstart]/[ilend])만 추려 보존용으로 반환.
 *  인코딩은 공용 encodeLrc(lrc-parser.js) 사용 — 세그먼트 순서 보존. */
function extractMarkerLines(lrcContent) {
    const markerRegex = /^\[(\d{2}):(\d{2}\.\d{2,3})\]\[(vocalstart|ilstart|ilend)\]\s*$/;
    const lines = (lrcContent || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    lines.forEach((line) => {
        const m = markerRegex.exec(line.trim());
        if (m) {
            out.push(line.trim());
        }
    });
    return out;
}

/**
 * 정렬 입력 텍스트와 **하드 앵커**를 세그먼트에서 뽑는다.
 *
 * 앵커는 백엔드가 구간 분할 정렬에 쓰는 고정점 `(줄 인덱스, ms)`으로, 한 번의
 * 밀림이 곡 전체로 전파되는 것을 막고 사용자 교정을 정렬 기준으로 삼는다.
 * - 이미 싱크된 줄(start>0) → 그 시작 시각이 앵커.
 * - 보컬시작 마커 → 첫 줄이 아직 싱크 안 됐을 때만 첫 줄의 시작 앵커
 *   ("긴 인트로 동안 첫 토큰이 일찍 소비돼 처음부터 밀리는" 문제 차단).
 *
 * 줄 인덱스는 정렬 입력(allTexts)에서의 위치 — 백엔드가 같은 기준으로 매핑한다.
 * @returns {{ allTexts: string[], anchors: [number, number][] }}
 */
export function collectAlignmentAnchors(segments, markers) {
    const allTexts = [];
    const anchors = [];
    let line0Synced = false;
    for (const s of segments || []) {
        const t = getSyncText(s).trim();
        if (t.length === 0) continue;
        const idx = allTexts.length;
        allTexts.push(t);
        const synced = !(s.start === 0 && s.end === 0);
        if (synced && typeof s.start === 'number' && s.start > 0) {
            anchors.push([idx, Math.round(s.start * 1000)]);
            if (idx === 0) line0Synced = true;
        }
    }
    const vocalStartSec = markers && markers.vocalStartSec;
    if (!line0Synced && vocalStartSec != null && vocalStartSec > 0 && allTexts.length > 0) {
        anchors.push([0, Math.round(vocalStartSec * 1000)]);
    }
    return { allTexts, anchors };
}

async function processOne(item) {
    // 1. LRC 로드 + 파싱
    let lrcContent = '';
    try {
        lrcContent = await invoke('load_lrc_file', { audioPath: item.path });
    } catch (err) {
        // 파일 없음 — 가사 자체가 없는 곡
    }
    if (!lrcContent || !lrcContent.trim()) {
        item.status = 'no-lyrics';
        return;
    }
    const segments = parseLrc(lrcContent, 0);
    // 에디터(runAiAlignment)와 동일하게 "전체" 가사를 정렬 입력으로 보낸다
    // (문맥이 온전해야 CTC 정렬 정확도가 높음) — 병합은 미싱크 줄에만 됨.
    // 이미 싱크된 줄·보컬시작 마커는 하드 앵커로 함께 넘긴다(collectAlignmentAnchors).
    const { allTexts, anchors } = collectAlignmentAnchors(segments, parseMarkers(lrcContent));
    const hasUnsynced = segments.some(
        (s) => s.start === 0 && s.end === 0 && getSyncText(s).trim().length > 0
    );
    if (allTexts.length === 0) {
        item.status = 'no-lyrics';
        return;
    }
    if (!hasUnsynced) {
        // 가사는 있지만 전부 이미 싱크됨 — 할 일 없음, 완료 처리
        item.status = 'done';
        item.note = '이미 싱크됨';
        return;
    }

    // 2. 모델 확인 (없으면 이 항목만 실패 — 배치 중 다운로드 프롬프트 없음)
    //    랩/혼합 모드는 한국어+영어 모델이 둘 다 있어야 한다.
    const modelSpecs = await resolveAlignmentModels();
    if (!modelSpecs) {
        item.status = 'error';
        item.error = '선택한 언어의 정렬 모델이 설치되어 있지 않습니다 (가사 싱크 탭에서 언어를 고르고 먼저 다운로드하세요. 랩/혼합은 한국어·영어 모델이 모두 필요합니다).';
        return;
    }

    // 3. 강제정렬 실행 (백엔드 락이 에디터 단발 실행과의 동시성도 직렬화)
    //    단일 언어는 1패스, 랩/혼합은 언어별 2패스 후 줄 단위 병합.
    const passResults = [];
    for (let pi = 0; pi < modelSpecs.length; pi++) {
        const { lang, model } = modelSpecs[pi];
        // 듀얼 모드 진행률: 패스1 = 0~50%, 패스2 = 50~100%.
        item.progressOffset = (100 / modelSpecs.length) * pi;
        item.progressScale = 1 / modelSpecs.length;
        item.passLabel = modelSpecs.length > 1 ? `${pi + 1}/${modelSpecs.length}` : null;
        notifyQueueChanged();
        const result = await invoke('run_forced_alignment', {
            audioPath: item.path,
            lyrics: allTexts.join('\n'),
            modelName: model,
            language: lang,
            anchors: anchors.length ? anchors : null,
        });
        passResults.push((result && result.lines) || []);
    }
    item.progressOffset = 0;
    item.progressScale = 1;
    item.passLabel = null;

    let lines;
    if (passResults.length === 2) {
        const { mergeDualAlignmentLines } = await import('./alignment-model.js');
        lines = mergeDualAlignmentLines(passResults[0], passResults[1]);
    } else {
        lines = passResults[0] || [];
    }
    const appliedCount = mergeAlignmentResult(segments, lines);
    if (appliedCount === 0) {
        item.status = 'error';
        item.error = 'AI가 정렬한 줄과 일치하는 미싱크 가사를 찾지 못했습니다.';
        return;
    }

    // 4. 저장 (마커 줄 보존)
    const content = encodeLrc(segments, extractMarkerLines(lrcContent));
    await invoke('save_lrc_file', { audioPath: item.path, content });

    // 라이브러리 카드의 가사 보유/싱크 상태 즉시 갱신
    const song = state.songLibrary.find((s) => s.path === item.path);
    if (song) {
        song.hasLyrics = true; song.has_lyrics = true;
        song.lyricSyncStatus = 'synced'; song.lyric_sync_status = 'synced';
    }

    item.status = 'done';
    item.note = `${appliedCount}줄 배치됨`;

    // 이 곡이 지금 가사 싱크 에디터에 열려 있으면 결과를 즉시 반영.
    notifyItemComplete(item.path, lines);
}

async function runQueue() {
    if (isRunning) return;
    isRunning = true;
    await ensureProgressListener();
    try {
        for (;;) {
            const item = state.alignmentQueue.find((i) => i.status === 'queued');
            if (!item) break;
            item.status = 'processing';
            item.percentage = 0;
            // 새 항목 시작 — 진행률(-2/실수) 이벤트가 오기 전까지는 '준비 중'.
            item.phase = 'preparing';
            notifyQueueChanged();
            try {
                await processOne(item);
            } catch (err) {
                const msg = String(err);
                if (msg.includes('취소')) {
                    item.status = 'cancelled';
                } else {
                    console.error('[AlignQueue] item failed:', item.path, err);
                    item.status = 'error';
                    item.error = msg;
                }
            }
            notifyQueueChanged();
        }
    } finally {
        isRunning = false;
    }
}

/** 여러 곡을 정렬 대기열에 추가하고 (미실행 중이면) 순차 처리를 시작한다. */
export function enqueueAlignment(paths) {
    const active = new Set(
        state.alignmentQueue
            .filter((i) => i.status === 'queued' || i.status === 'processing')
            .map((i) => i.path)
    );
    let added = 0;
    (paths || []).forEach((path) => {
        if (!path || active.has(path)) return;
        // 같은 곡의 지난 실행 결과(done/error 등)가 남아있으면 치우고 다시
        // 등록 — 렌더러가 path를 카드 키로 쓰므로 경로 중복은 허용하지 않음.
        const staleIdx = state.alignmentQueue.findIndex((i) => i.path === path);
        if (staleIdx !== -1) state.alignmentQueue.splice(staleIdx, 1);
        const song = state.songLibrary.find((s) => s.path === path);
        state.alignmentQueue.push({
            path,
            title: song?.title || path,
            thumbnail: song?.thumbnail || '',
            status: 'queued',
        });
        active.add(path);
        added++;
    });
    if (added > 0) {
        notifyQueueChanged();
        runQueue();
    }
    return added;
}

/** 정렬 대기열 전체 지우기 — 처리 중인 항목이 있으면 취소하고, 대기/완료/
 *  오류 항목을 모두 목록에서 제거한다. (AI 프로세싱 탭의 "전체 지우기") */
export async function clearAlignmentQueue() {
    const processing = state.alignmentQueue.find((i) => i.status === 'processing');
    if (processing) {
        try {
            await invoke('cancel_forced_alignment');
        } catch (err) {
            console.error('[AlignQueue] cancel during clear failed:', err);
        }
    }
    state.alignmentQueue.length = 0;
    notifyQueueChanged();
}

/** 대기열 항목 취소/제거. queued는 즉시 제거(백엔드 호출 없음), processing은
 *  전역 취소 커맨드 호출(활성 정렬은 항상 1개라 안전). done/error 등 완료
 *  상태는 목록에서 치우는 용도. */
export async function cancelAlignmentQueueItem(path) {
    const idx = state.alignmentQueue.findIndex((i) => i.path === path);
    if (idx === -1) return;
    const item = state.alignmentQueue[idx];
    if (item.status === 'processing') {
        try {
            await invoke('cancel_forced_alignment');
        } catch (err) {
            console.error('[AlignQueue] cancel failed:', err);
        }
        // 실제 상태 전환은 runQueue의 에러 처리(취소 메시지)에서 일어남
    } else {
        state.alignmentQueue.splice(idx, 1);
        notifyQueueChanged();
    }
}
