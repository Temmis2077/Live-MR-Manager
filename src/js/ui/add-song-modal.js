/**
 * add-song-modal.js — 노래 추가 원스톱 UI
 *
 * 사이드바 "노래 추가" 버튼(또는 파일 드래그드롭)으로 열리는 대형 모달.
 * 한 흐름에서: (a) 소스(유튜브 URL / 로컬 파일 다중 선택) → (b) 곡 정보
 * (제목/아티스트/장르/카테고리/태그) → (c) MR 분리 여부+모델 → (d) 가사
 * 붙여넣기+AI 정렬 언어까지 정하고 "추가"를 누르면 등록과 후처리(분리·정렬
 * 대기열)가 한 번에 걸린다 — 곡 하나를 추가할 때 따로 손이 안 가게.
 *
 * 다중 로컬 파일: 제목/아티스트는 파일 메타데이터를 그대로 쓰고, 장르/
 * 카테고리/태그/분리/정렬 옵션은 전체에 일괄 적용된다(제목 입력은 단일
 * 곡일 때만 활성).
 */
import { invoke } from '../tauri-bridge.js';
import { state } from '../state.js';
import { showNotification, getThumbnailUrl } from '../utils.js';
import { getAudioMetadata, saveLibrary } from '../audio.js';
import { isDuplicateYoutubeTrack, normalizeYoutubeUrl } from '../youtube-utils.js';
import { partitionSeparationModels } from '../separation-mode-modal.js';
// 장르/카테고리는 taxonomy.js 단일 소스를 따른다 (곡 정보 편집·필터와 동일 기준).
import { GENRES, CATEGORIES } from '../taxonomy.js';

let overlay = null;
// 소스 단계에서 확보한 곡 메타데이터 목록 (유튜브 1개 or 로컬 N개)
let pendingSongs = [];
// 사용자가 장르를 직접 고른 뒤에는 자동 매칭이 그 위를 덮지 않는다.
let genreTouched = false;
// 모달을 연 횟수. 장르 조회가 끝났을 때 그 사이 모달이 닫히거나 다시 열렸는지
// 판별한다 — 조회는 네트워크라 늦게 돌아오는데, 그때 사라진 DOM을 만지면 터진다.
let modalGeneration = 0;


function close() {
    if (overlay) { overlay.remove(); overlay = null; }
    pendingSongs = [];
    genreTouched = false;
    modalGeneration += 1;
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
}

/** 소스 미리보기 목록 갱신 + 단일 곡일 때만 제목/아티스트 입력 활성화. */
function renderPendingList() {
    const list = overlay.querySelector('#addsong-pending');
    const titleInput = overlay.querySelector('#addsong-title');
    const artistInput = overlay.querySelector('#addsong-artist');
    if (pendingSongs.length === 0) {
        list.innerHTML = '<div class="addsong-empty">아직 선택된 곡이 없습니다.</div>';
    } else {
        list.innerHTML = pendingSongs.map((m, i) => `
            <div class="addsong-pending-row">
                <img class="addsong-thumb" src="${getThumbnailUrl(m.thumbnail) || ''}" onerror="this.style.visibility='hidden'">
                <div class="addsong-meta">
                    <div class="addsong-song-title">${esc(m.title || m.path)}</div>
                    <div class="addsong-song-artist">${esc(m.artist || '')}${
                        m.genreMatching ? ' <span class="addsong-genre-tag is-loading">장르 찾는 중…</span>'
                        : m.autoGenre ? ` <span class="addsong-genre-tag">${esc(m.autoGenre)}</span>` : ''
                    }</div>
                </div>
                <button type="button" class="marker-delete-btn" data-remove="${i}" title="목록에서 제거" aria-label="${esc(m.title || m.path)} 목록에서 제거">×</button>
            </div>
        `).join('');
        list.querySelectorAll('[data-remove]').forEach((btn) => {
            btn.onclick = () => { pendingSongs.splice(parseInt(btn.dataset.remove, 10), 1); renderPendingList(); };
        });
    }
    const single = pendingSongs.length === 1;
    titleInput.disabled = !single;
    artistInput.disabled = !single;
    if (single) {
        titleInput.value = pendingSongs[0].title || '';
        artistInput.value = pendingSongs[0].artist || '';
        titleInput.placeholder = '';
        artistInput.placeholder = '';
    } else {
        titleInput.value = '';
        artistInput.value = '';
        const hint = pendingSongs.length > 1 ? '파일 메타데이터 사용 (다중 추가)' : '곡을 먼저 선택하세요';
        titleInput.placeholder = hint;
        artistInput.placeholder = hint;
    }
    overlay.querySelector('#addsong-confirm').disabled = pendingSongs.length === 0;
    renderGenreMatchNote();
}

async function fetchYoutube() {
    const input = overlay.querySelector('#addsong-yt-url');
    const btn = overlay.querySelector('#addsong-yt-fetch');
    const url = input.value.trim();
    if (!url) return;
    const normalized = normalizeYoutubeUrl(url);
    if (isDuplicateYoutubeTrack(state.songLibrary, normalized, null)
        || pendingSongs.some((m) => m.path === normalized)) {
        showNotification('이미 등록됐거나 목록에 있는 곡입니다.', 'warning');
        return;
    }
    btn.disabled = true;
    btn.textContent = '가져오는 중…';
    try {
        const metadata = await getAudioMetadata(normalized);
        if (!metadata || !metadata.path) {
            showNotification('유튜브 정보를 가져오지 못했습니다.', 'error');
            return;
        }
        if (isDuplicateYoutubeTrack(state.songLibrary, normalized, metadata)) {
            showNotification('이미 등록된 곡입니다.', 'warning');
            return;
        }
        pendingSongs.push(metadata);
        input.value = '';
        renderPendingList();
        autoMatchGenres();
    } catch (err) {
        console.error('[AddSong] YouTube fetch failed:', err);
        showNotification('유튜브 정보를 가져오지 못했습니다.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '가져오기';
    }
}

/** 초 → m:ss (검색 결과 길이 표시용) */
function fmtDuration(sec) {
    const s = Number(sec) || 0;
    if (s <= 0) return '';
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 곡명·가수 통합 검색 — 유튜브 영상 후보와 가사 페이지 링크를 동시에 찾는다.
 * 유튜브 쪽은 백엔드가 공식 음원(자동 생성 설명)을 최상단으로 올려준다.
 */
async function runSearch() {
    const input = overlay.querySelector('#addsong-search-input');
    const btn = overlay.querySelector('#addsong-search-btn');
    const panes = overlay.querySelector('#addsong-search-panes');
    const ytBox = overlay.querySelector('#addsong-yt-results');
    const lyrBox = overlay.querySelector('#addsong-lyrics-results');
    const query = input.value.trim();
    if (!query) return;

    panes.style.display = 'grid';
    ytBox.innerHTML = '<div class="addsong-empty">검색 중…</div>';
    lyrBox.innerHTML = '<div class="addsong-empty">검색 중…</div>';
    btn.disabled = true;
    btn.textContent = '검색 중…';

    // 두 검색은 서로 독립이라 하나가 실패해도 다른 쪽은 보여준다.
    const [yt, lyr] = await Promise.allSettled([
        invoke('search_youtube', { query, limit: 8 }),
        invoke('search_lyrics_sites', { query }),
    ]);

    // ── 유튜브 결과
    if (yt.status === 'fulfilled' && (yt.value || []).length > 0) {
        ytBox.innerHTML = yt.value.map((r, i) => `
            <div class="addsong-result addsong-yt-result" data-idx="${i}" title="${esc(r.title)}">
                <img class="addsong-result-thumb" src="${esc(r.thumbnail)}" loading="lazy" onerror="this.style.visibility='hidden'">
                <div class="addsong-result-body">
                    <div class="addsong-result-title">${esc(r.title)}</div>
                    <div class="addsong-result-sub">
                        ${r.official ? '<span class="addsong-official-badge">공식 음원</span>' : ''}
                        ${esc(r.channel)}${r.duration ? ` · ${fmtDuration(r.duration)}` : ''}
                    </div>
                </div>
            </div>
        `).join('');
        ytBox.querySelectorAll('.addsong-yt-result').forEach((el) => {
            el.onclick = () => {
                const r = yt.value[parseInt(el.dataset.idx, 10)];
                // 선택한 영상 URL을 입력란에 넣고 바로 메타데이터를 가져와 목록에 추가
                overlay.querySelector('#addsong-yt-url').value = r.url;
                ytBox.querySelectorAll('.addsong-result').forEach((n) => n.classList.remove('selected'));
                el.classList.add('selected');
                fetchYoutube();
            };
        });
    } else {
        ytBox.innerHTML = `<div class="addsong-empty">${yt.status === 'rejected' ? '검색 실패: ' + esc(String(yt.reason)) : '결과가 없습니다.'}</div>`;
    }

    // ── 가사 링크 결과 (원문은 가져오지 않고 링크만)
    if (lyr.status === 'fulfilled' && (lyr.value || []).length > 0) {
        lyrBox.innerHTML = lyr.value.map((r, i) => `
            <div class="addsong-result addsong-lyr-result" data-idx="${i}" title="${esc(r.url)}">
                <div class="addsong-result-body">
                    <div class="addsong-result-title">${esc(r.title)}</div>
                    ${r.snippet ? `<div class="addsong-result-snippet">${esc(r.snippet)}</div>` : ''}
                    <div class="addsong-result-sub">
                        ${r.preferred ? '<span class="addsong-preferred-badge" title="이 언어권에서 원문이 정확하기로 알려진 출처">원문 정확</span>' : ''}
                        ${esc(r.domain)}
                    </div>
                </div>
                <button type="button" class="addsong-open-btn" data-url="${esc(r.url)}" title="브라우저에서 열기">↗</button>
            </div>
        `).join('');
        lyrBox.querySelectorAll('.addsong-lyr-result').forEach((el) => {
            el.onclick = (e) => {
                if (e.target.closest('.addsong-open-btn')) return;
                const r = lyr.value[parseInt(el.dataset.idx, 10)];
                overlay.querySelector('#addsong-lyrics-link').value = r.url;
                lyrBox.querySelectorAll('.addsong-result').forEach((n) => n.classList.remove('selected'));
                el.classList.add('selected');
            };
        });
        lyrBox.querySelectorAll('.addsong-open-btn').forEach((b) => {
            b.onclick = async (e) => {
                e.stopPropagation();
                const url = b.dataset.url;
                try {
                    // 가사 싱크 탭의 링크 열기와 동일한 방식(외부 브라우저)
                    if (window.__TAURI__?.opener?.openUrl) await window.__TAURI__.opener.openUrl(url);
                    else window.open(url, '_blank', 'noopener,noreferrer');
                } catch (err) {
                    console.error('[AddSong] open lyrics link failed:', err);
                }
            };
        });
    } else {
        lyrBox.innerHTML = `<div class="addsong-empty">${lyr.status === 'rejected' ? '검색 실패: ' + esc(String(lyr.reason)) : '결과가 없습니다.'}</div>`;
    }

    btn.disabled = false;
    btn.textContent = '검색';
}

async function pickLocalFiles(prefillPaths = null) {
    let paths = prefillPaths;
    if (!paths) {
        try {
            paths = await invoke('pick_audio_files');
        } catch (err) {
            console.error('[AddSong] pick_audio_files failed:', err);
            showNotification('파일 선택에 실패했습니다: ' + err, 'error');
            return;
        }
    }
    if (!paths || paths.length === 0) return;
    for (const path of paths) {
        if (state.songLibrary.some((s) => s.path === path) || pendingSongs.some((m) => m.path === path)) continue;
        try {
            const metadata = await getAudioMetadata(path);
            if (!metadata || !metadata.path) {
                console.error('[AddSong] empty metadata for:', path);
                continue;
            }
            metadata.source = 'local';
            pendingSongs.push(metadata);
        } catch (err) {
            console.error('[AddSong] metadata failed for:', path, err);
        }
    }
    renderPendingList();
    // 고른 직후에 장르를 찾아 둔다 — 기다리게 하지 않고 결과가 오면 채운다.
    autoMatchGenres();
}

/**
 * 고른 곡의 장르를 자동으로 찾아 채운다.
 *
 * 곡을 고른 직후에 돈다 — 장르는 곡을 등록하고 나서 따로 손대게 두면 대부분
 * 비어 있는 채로 남는다. 곡마다 따로 찾아 m.autoGenre에 담아 두고, 찾은
 * 값이 모두 같을 때만 위 선택 상자에 올린다(장르 칸은 전체 일괄 적용이라,
 * 서로 다른데 하나로 몰아 버리면 틀린 값을 다 같이 뒤집어쓴다).
 *
 * 여기서 쓰는 wantGenre는 Last.fm 태그 조회라 네트워크만 탄다 — 음원 분석이
 * 들어가는 키·BPM과 달리 곡을 고르는 흐름을 붙잡지 않는다.
 */
async function autoMatchGenres() {
    if (!overlay || pendingSongs.length === 0) return;
    const targets = pendingSongs.filter((m) => !m.genre && m.autoGenre === undefined
        && (m.artist || '').trim() && (m.title || '').trim());
    if (targets.length === 0) { renderGenreMatchNote(); return; }

    const generation = modalGeneration;
    targets.forEach((m) => { m.genreMatching = true; });
    renderGenreMatchNote();

    await Promise.all(targets.map(async (m) => {
        try {
            const res = await invoke('autofill_song_info', {
                path: m.path, artist: m.artist || '', title: m.title || '',
                wantGenre: true, wantKeyBpm: false,
            });
            m.autoGenre = res?.genre || null;
            if (res?.tags?.length) m.autoTags = res.tags;
        } catch (err) {
            console.warn('[AddSong] 장르 자동 매칭 실패:', m.title, err);
            m.autoGenre = null;
        } finally {
            m.genreMatching = false;
        }
    }));

    // 조회를 기다리는 동안 모달을 닫았거나 다시 열었으면 그리지 않는다.
    // renderPendingList는 overlay가 있다고 보고 바로 querySelector를 하므로
    // 여기서 걸러 주지 않으면 닫는 순간 예외가 난다.
    if (generation !== modalGeneration || !overlay) return;
    applyMatchedGenreToSelect();
    renderPendingList();
}

/** 찾은 장르가 모두 같고 사용자가 아직 안 골랐으면 선택 상자에 올린다. */
function applyMatchedGenreToSelect() {
    if (!overlay || genreTouched) return;
    const sel = overlay.querySelector('#addsong-genre');
    if (!sel || sel.value) return;
    const found = [...new Set(pendingSongs.map((m) => m.autoGenre).filter(Boolean))];
    if (found.length !== 1) return;
    const genre = found[0];
    // 목록에 없는 장르면(Last.fm이 새 값을 준 경우) 항목을 만들어 고른다.
    if (![...sel.options].some((o) => o.value === genre)) {
        sel.insertBefore(new Option(genre, genre), sel.querySelector('option[value="__custom"]'));
    }
    sel.value = genre;
}

/** 장르 칸 아래 한 줄 안내 — 무엇이 자동으로 들어갔는지 보이고 고칠 수 있게. */
function renderGenreMatchNote() {
    const note = overlay?.querySelector('#addsong-genre-note');
    if (!note) return;
    if (pendingSongs.some((m) => m.genreMatching)) {
        note.textContent = '장르 찾는 중…';
        note.dataset.tone = '';
        return;
    }
    const matched = pendingSongs.filter((m) => m.autoGenre);
    if (matched.length === 0) {
        // 가수나 곡명이 비면 조회 자체가 안 된다(Last.fm은 둘 다 필요).
        // 파일 태그가 없는 음원에서 흔한 경우라 무엇을 채우면 되는지 알려 준다.
        const skipped = pendingSongs.some((m) => m.autoGenre === undefined
            && (!(m.artist || '').trim() || !(m.title || '').trim()));
        const tried = pendingSongs.some((m) => m.autoGenre === null);
        if (skipped) {
            note.textContent = '가수와 곡명이 있어야 장르를 찾을 수 있습니다 — 위에 채우면 다시 찾습니다.';
            note.dataset.tone = 'warn';
        } else {
            note.textContent = tried ? '장르를 찾지 못했습니다 — 직접 고르세요.' : '';
            note.dataset.tone = tried ? 'warn' : '';
        }
        return;
    }
    const found = [...new Set(matched.map((m) => m.autoGenre))];
    note.textContent = found.length === 1
        ? `자동으로 찾은 장르: ${found[0]} — 그대로 두거나 바꾸세요.`
        : `곡마다 다른 장르를 찾았습니다(${found.join(' · ')}) — 위에서 하나를 고르면 전부 그 값이 됩니다.`;
    note.dataset.tone = 'ok';
}

/** 분리 모델 선택 — 1차 보컬/반주 + 선택적인 리드/화음 2차 분리. */
async function renderModelChoices() {
    const wrap = overlay.querySelector('#addsong-model-choices');
    let activeId = 'melband_roformer_vocals_mit';
    try { activeId = await invoke('get_model_settings'); } catch (_) {}
    let allModels = [];
    try {
        allModels = await invoke('list_all_models') || [];
    } catch (_) {}
    const { baseModels, harmonyModels } = partitionSeparationModels(allModels);
    const options = [
        { id: 'melband_roformer_vocals_mit', label: '기본 고품질 분리', desc: 'Mel-Band RoFormer Vocals — MIT' },
        ...baseModels.map((m) => ({ id: m.id, label: m.name, desc: '커스텀 모델' })),
    ];
    const selectedBaseId = options.some((o) => o.id === activeId)
        ? activeId
        : 'melband_roformer_vocals_mit';
    const harmonyOptions = harmonyModels.map((m) =>
        `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    wrap.innerHTML = options.map((o) => `
        <label class="addsong-model-option${o.id === selectedBaseId ? ' current-default' : ''}">
            <input type="radio" name="addsong-model" value="${esc(o.id)}" ${o.id === selectedBaseId ? 'checked' : ''}>
            <span class="addsong-model-label">${esc(o.label)}</span>
            <span class="addsong-model-desc">${esc(o.desc)}</span>
        </label>
    `).join('') + `
        <div class="addsong-model-option addsong-harmony-option">
            <label class="addsong-check">
                <input type="checkbox" id="addsong-harmony-check" ${harmonyModels.length ? '' : 'disabled'}>
                보컬 화음 분리
            </label>
            <span class="addsong-model-desc">리드 보컬과 화음/코러스를 별도 채널로 만듭니다.</span>
            <select id="addsong-harmony-model" class="addsong-input" disabled>
                ${harmonyOptions || '<option value="">등록된 Karaoke ONNX 모델 없음</option>'}
            </select>
            <span class="addsong-model-desc">${harmonyModels.length
                ? 'MR 분리 뒤 선택한 모델로 보컬을 한 번 더 처리합니다.'
                : '커스텀 AI 모델에서 Mel-Band RoFormer Karaoke ONNX를 먼저 등록해주세요.'}</span>
        </div>`;

    const harmonyCheck = wrap.querySelector('#addsong-harmony-check');
    const harmonySelect = wrap.querySelector('#addsong-harmony-model');
    if (harmonyCheck && harmonySelect) {
        harmonyCheck.onchange = () => { harmonySelect.disabled = !harmonyCheck.checked; };
    }
}

async function confirmAdd() {
    if (pendingSongs.length === 0) return;
    const btn = overlay.querySelector('#addsong-confirm');
    btn.disabled = true;
    btn.textContent = '추가 중…';

    // 모달을 닫은 뒤(다운로드가 오래 걸릴 수 있어) 정렬 모델을 확인·다운로드하고
    // 대기열에 걸 대상. null이면 정렬 안 함.
    let alignAfterAdd = null;

    // (b) 곡 정보 일괄/단일 적용
    const readChoice = (selId, customId) => {
        const sel = overlay.querySelector(selId);
        return sel.value === '__custom'
            ? overlay.querySelector(customId).value.trim()
            : sel.value.trim();
    };
    const genre = readChoice('#addsong-genre', '#addsong-genre-custom');
    const category = readChoice('#addsong-category', '#addsong-category-custom');
    const tags = overlay.querySelector('#addsong-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const lyricsLink = overlay.querySelector('#addsong-lyrics-link').value.trim();
    if (pendingSongs.length === 1) {
        const title = overlay.querySelector('#addsong-title').value.trim();
        const artist = overlay.querySelector('#addsong-artist').value.trim();
        if (title) pendingSongs[0].title = title;
        if (artist) pendingSongs[0].artist = artist;
    }
    pendingSongs.forEach((m) => {
        // 위에서 고른 값이 있으면 그게 전부에 적용된다(사용자가 명시한 값).
        // 비워 뒀다면 곡마다 자동으로 찾아 둔 장르를 각자 쓴다 — 여러 곡을
        // 한 번에 넣을 때 서로 다른 장르가 하나로 뭉개지지 않게.
        if (genre) m.genre = genre;
        else if (m.autoGenre) m.genre = m.autoGenre;
        if (category) m.categories = [category];
        if (tags.length) m.tags = tags;
        // 가사 링크는 단일 곡일 때만 의미 있음(검색으로 고른 그 곡의 링크)
        if (lyricsLink && pendingSongs.length === 1) {
            m.lyricsLink = lyricsLink;
            m.lyrics_link = lyricsLink;
        }
    });

    // (c)/(d) 옵션
    const doSeparate = overlay.querySelector('#addsong-separate-check').checked;
    const modelId = overlay.querySelector('input[name="addsong-model"]:checked')?.value || null;
    const harmonyModelId = overlay.querySelector('#addsong-harmony-check')?.checked
        ? overlay.querySelector('#addsong-harmony-model')?.value || null
        : null;
    const doAlign = overlay.querySelector('#addsong-lyrics-check').checked;
    const lyricsText = overlay.querySelector('#addsong-lyrics').value.trim();
    const alignLang = overlay.querySelector('#addsong-align-lang').value;

    const songs = pendingSongs.slice();
    try {
        // 1. 라이브러리 등록 먼저 (분리/정렬은 등록된 곡 기준으로 동작)
        state.songLibrary.push(...songs);
        await saveLibrary(state.songLibrary);
        const { refreshFilterDropdowns } = await import('./core.js');
        await refreshFilterDropdowns();
        const { renderLibrary } = await import('./library.js');
        renderLibrary();

        // 2. 가사 저장 (+정렬 대기열) — 가사는 단일 곡에만 의미가 있음
        if (doAlign && lyricsText && songs.length === 1) {
            const { encodeLrc, groupTripletLines } = await import('../lrc-parser.js');
            const lines = lyricsText.split('\n').map((t) => t.trim()).filter(Boolean);
            let segments;
            if (overlay.querySelector('#addsong-triplet-check').checked) {
                // 3줄 모드: [원문/차음/번역]을 스크립트 인식으로 묶음 — 영어
                // 소절(원문 1줄)이 섞여도 밀리지 않는다. AI 정렬은 차음 줄
                // 기준으로 동작(getSyncText).
                segments = groupTripletLines(lines).map((c) => ({ ...c, start: 0, end: 0 }));
            } else {
                segments = lines.map((text) => ({ text, start: 0, end: 0 }));
            }
            await invoke('save_lrc_file', { audioPath: songs[0].path, content: encodeLrc(segments) });
            const song = state.songLibrary.find((s) => s.path === songs[0].path);
            if (song) { song.hasLyrics = true; song.has_lyrics = true; song.lyricSyncStatus = 'unsynced'; }
            const { setAlignmentLanguage } = await import('../alignment-model.js');
            setAlignmentLanguage(alignLang);
            // 정렬 모델 확인·다운로드는 수백 MB라 시간이 걸릴 수 있어 모달을 막지
            // 않는다. 모달을 닫은 뒤(아래 close 이후) 모델을 확인하고, 없으면
            // 다운로드를 물어본 다음 대기열에 건다. deferSeparate면 분리 완료
            // 후 정렬(분리된 보컬 스템 우선)이 정확하다.
            alignAfterAdd = { path: songs[0].path, deferSeparate: !!(doSeparate && modelId) };
        }

        // 3. MR 분리 시작 (여러 곡이면 순서대로 대기열에 걸림)
        if (doSeparate && modelId) {
            const { startMrSeparation } = await import('../audio.js');
            for (const m of songs) {
                const alignThisSong = !!(alignAfterAdd && m.path === alignAfterAdd.path);
                try {
                    const separation = await startMrSeparation(m.path, modelId, harmonyModelId, {
                        alignAfterSeparation: alignThisSong,
                    });
                    if (alignThisSong) {
                        alignAfterAdd.deferredBySeparation = separation?.alignmentDeferred === true;
                    }
                } catch (err) {
                    console.error('[AddSong] separation start failed:', m.path, err);
                }
            }
        }

        const withAlign = doAlign && lyricsText && songs.length === 1;
        const extras = [
            doSeparate ? (harmonyModelId ? 'MR · 보컬 화음 분리' : 'MR 분리') : null,
            withAlign ? (doSeparate ? '분리 완료 후 AI 정렬' : 'AI 정렬') : null,
        ].filter(Boolean);
        showNotification(
            `${songs.length}곡을 추가했습니다.${extras.length ? ` (${extras.join(' · ')} 시작됨)` : ''}`,
            'success'
        );
        close();

        // 모달을 닫은 뒤 정렬 모델을 확인한다. 없으면 다운로드를 물어보고,
        // 받은 다음 대기열에 건다(모달을 프리징시키지 않도록 여기서 처리).
        // 곡 등록은 이미 끝났으므로, 이 단계의 실패가 "곡 추가 실패"로 새지
        // 않도록 별도 try로 감싼다.
        if (alignAfterAdd) {
            try {
                const { ensureAlignmentModelsReady, enqueueAlignment } =
                    await import('../alignment-queue.js');
                if (alignAfterAdd.deferSeparate && alignAfterAdd.deferredBySeparation) {
                    // 공통 분리 진입점이 백엔드 작업 시작 전에 이미 예약했다.
                } else if (alignAfterAdd.deferSeparate) {
                    showNotification(
                        '정렬 모델이 없어 AI 정렬은 건너뜁니다. 가사 싱크 탭에서 모델을 받은 뒤 다시 정렬할 수 있어요.',
                        'info'
                    );
                } else {
                    const ready = await ensureAlignmentModelsReady();
                    if (ready) enqueueAlignment([alignAfterAdd.path]);
                    else showNotification(
                        '정렬 모델이 없어 AI 정렬은 건너뜁니다. 가사 싱크 탭에서 모델을 받은 뒤 다시 정렬할 수 있어요.',
                        'info'
                    );
                }
            } catch (alignErr) {
                console.error('[AddSong] alignment enqueue failed:', alignErr);
                showNotification('AI 정렬 준비 중 오류가 발생했습니다. 가사 싱크 탭에서 다시 시도해 주세요.', 'error');
            }
        }
    } catch (err) {
        console.error('[AddSong] confirm failed:', err);
        // 등록은 메모리에 먼저 밀어 넣고 저장하는 순서라, 저장이 실패하면
        // 화면상의 라이브러리에만 곡이 남는다. 그 상태에서 '추가'를 다시
        // 누르면 같은 곡이 한 번 더 들어가고, 다음번 아무 저장에 그대로
        // 딸려 들어간다. 실패하면 넣은 만큼 되돌린다.
        const added = new Set(songs);
        state.songLibrary = state.songLibrary.filter((s) => !added.has(s));
        try {
            const { renderLibrary } = await import('./library.js');
            renderLibrary();
        } catch (_) {}
        showNotification('곡 추가에 실패했습니다: ' + err, 'error');
        btn.disabled = false;
        btn.textContent = '추가';
    }
}

/**
 * 노래 추가 모달을 연다.
 * @param prefillLocalPaths 드래그드롭 등에서 미리 선택된 로컬 파일 경로들
 */
export async function openAddSongModal(prefillLocalPaths = null) {
    if (overlay) close();
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.id = 'add-song-modal';
    overlay.innerHTML = `
        <div class="modal-content addsong-modal">
            <div class="addsong-header">
                <h3>노래 추가</h3>
                <button type="button" class="marker-delete-btn" id="addsong-close" title="닫기" aria-label="노래 추가 닫기">×</button>
            </div>

            <div class="addsong-section">
                <div class="addsong-section-title">1. 소스</div>
                <!-- 곡명·가수로 검색하면 유튜브 영상 후보와 가사 페이지 링크를
                     한 번에 찾아준다(URL을 직접 구해 붙여넣지 않아도 됨). -->
                <div class="addsong-source-row">
                    <input type="text" id="addsong-search-input" class="addsong-input" placeholder="곡명 · 가수로 검색 (예: 에픽하이 트로트)" spellcheck="false" style="flex:1;">
                    <button type="button" class="app-btn app-btn-primary" id="addsong-search-btn">검색</button>
                </div>
                <div id="addsong-search-panes" class="addsong-search-panes" style="display:none;">
                    <div class="addsong-search-pane">
                        <div class="addsong-pane-title">유튜브 영상</div>
                        <div id="addsong-yt-results" class="addsong-result-list"></div>
                    </div>
                    <div class="addsong-search-pane">
                        <div class="addsong-pane-title">가사 링크</div>
                        <div id="addsong-lyrics-results" class="addsong-result-list"></div>
                    </div>
                </div>
                <div class="addsong-source-row" style="margin-top:10px;">
                    <input type="text" id="addsong-yt-url" class="addsong-input" placeholder="YouTube URL 직접 입력" spellcheck="false" style="flex:1;">
                    <button type="button" class="app-btn" id="addsong-yt-fetch">가져오기</button>
                    <span class="addsong-or">또는</span>
                    <button type="button" class="app-btn" id="addsong-local-pick">로컬 파일 선택…</button>
                </div>
                <div id="addsong-pending" class="addsong-pending"></div>
            </div>

            <div class="addsong-section">
                <div class="addsong-section-title">2. 곡 정보 <span class="addsong-hint">(비워두면 자동 메타데이터 사용)</span></div>
                <div class="addsong-grid">
                    <input type="text" id="addsong-title" class="addsong-input" placeholder="제목">
                    <input type="text" id="addsong-artist" class="addsong-input" placeholder="아티스트">
                    <select id="addsong-genre" class="addsong-input" title="장르 — 음악 스타일(사운드). 예: 락, 힙합, 댄스"></select>
                    <select id="addsong-category" class="addsong-input" title="카테고리 — 씬/시장(출신). 예: K-POP, J-POP, 애니메이션"></select>
                    <input type="text" id="addsong-genre-custom" class="addsong-input" placeholder="장르 직접 입력" style="display:none;">
                    <input type="text" id="addsong-category-custom" class="addsong-input" placeholder="카테고리 직접 입력" style="display:none;">
                    <div id="addsong-genre-note" class="addsong-genre-note" style="grid-column: span 2;"></div>
                    <input type="text" id="addsong-tags" class="addsong-input" placeholder="태그 (쉼표로 구분)" style="grid-column: span 2;">
                    <input type="text" id="addsong-lyrics-link" class="addsong-input" placeholder="가사 링크 (검색에서 선택하면 자동 입력)" spellcheck="false" style="grid-column: span 2;">
                </div>
            </div>

            <div class="addsong-section">
                <div class="addsong-section-title">
                    <label class="addsong-check"><input type="checkbox" id="addsong-separate-check"> 3. MR 분리 바로 시작</label>
                </div>
                <div id="addsong-model-choices" class="addsong-model-choices" style="display:none;"></div>
            </div>

            <div class="addsong-section">
                <div class="addsong-section-title">
                    <label class="addsong-check"><input type="checkbox" id="addsong-lyrics-check"> 4. 가사 등록 + AI 자동 정렬</label>
                </div>
                <div id="addsong-lyrics-wrap" style="display:none;">
                    <textarea id="addsong-lyrics" class="addsong-lyrics" rows="5" placeholder="가사를 붙여넣으세요 (한 줄 = 한 소절). 등록 후 AI가 자동으로 싱크 초안을 잡습니다." spellcheck="false"></textarea>
                    <div class="addsong-source-row" style="margin-top:6px;">
                        <label class="addsong-check" title="일본어 곡처럼 한 소절이 [원문 / 한글 발음(차음) / 번역] 3줄로 된 가사. 위에서부터 3줄씩 한 소절로 묶고, AI 정렬은 차음 줄 기준으로 실행됩니다.">
                            <input type="checkbox" id="addsong-triplet-check"> 원문/차음/번역 3줄 모드 (일본어 곡 등)
                        </label>
                    </div>
                    <div class="addsong-source-row" style="margin-top:6px;">
                        <span class="addsong-hint">정렬 언어:</span>
                        <select id="addsong-align-lang" class="addsong-input" style="width:auto;">
                            <option value="ko">한국어/일본어(차음)</option>
                            <option value="en">English</option>
                            <option value="en-ko">영어 차음 + 한국어 모델 (추천)</option>
                        </select>
                        <span class="addsong-hint">※ 가사 정렬은 한 번에 한 곡일 때만 실행됩니다.</span>
                    </div>
                </div>
            </div>

            <div class="addsong-footer">
                <button type="button" class="app-btn" id="addsong-cancel">취소</button>
                <button type="button" class="app-btn app-btn-primary" id="addsong-confirm" disabled>추가</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // 이벤트 연결
    overlay.querySelector('#addsong-close').onclick = close;
    overlay.querySelector('#addsong-cancel').onclick = close;
    // 바깥 클릭 닫기 — mousedown이 오버레이(바깥)에서 시작된 경우에만.
    // 제목/가사를 드래그하다 마우스를 모달 밖에서 떼면 click 타깃이
    // 오버레이가 되어 창이 꺼지던 문제 방지(닫기는 취소/X/진짜 바깥 클릭만).
    let downOnOverlay = false;
    overlay.onmousedown = (e) => { downOnOverlay = e.target === overlay; };
    overlay.onclick = (e) => { if (e.target === overlay && downOnOverlay) close(); };
    overlay.querySelector('#addsong-yt-fetch').onclick = fetchYoutube;
    overlay.querySelector('#addsong-yt-url').onkeydown = (e) => { if (e.key === 'Enter') fetchYoutube(); };
    overlay.querySelector('#addsong-search-btn').onclick = runSearch;
    overlay.querySelector('#addsong-search-input').onkeydown = (e) => { if (e.key === 'Enter') runSearch(); };
    overlay.querySelector('#addsong-local-pick').onclick = () => pickLocalFiles();
    overlay.querySelector('#addsong-confirm').onclick = confirmAdd;

    const sepCheck = overlay.querySelector('#addsong-separate-check');
    sepCheck.onchange = () => {
        overlay.querySelector('#addsong-model-choices').style.display = sepCheck.checked ? 'flex' : 'none';
    };
    const lyrCheck = overlay.querySelector('#addsong-lyrics-check');
    lyrCheck.onchange = () => {
        overlay.querySelector('#addsong-lyrics-wrap').style.display = lyrCheck.checked ? 'block' : 'none';
    };

    // 장르/카테고리 자동완성 + 정렬 언어 기본값 + 모델 목록
    try {
        const { getAlignmentLanguage } = await import('../alignment-model.js');
        overlay.querySelector('#addsong-align-lang').value = getAlignmentLanguage();
    } catch (_) {}
    // 장르·카테고리 드롭다운 — taxonomy.js 표준 목록 + 라이브러리에 이미 있는
    // 비표준 값(기존) + 직접 입력. 곡이 많아져도 값이 일관되게 유지되도록
    // 자유 입력 대신 선택을 기본으로 한다.
    let dbGenres = [];
    let dbCategories = [];
    try {
        const { getAllGenres, getAllCategories } = await import('../state.js');
        [dbGenres, dbCategories] = await Promise.all([getAllGenres(), getAllCategories()]);
    } catch (_) {}

    const buildOptions = (sel, preset, dbValues, placeholder) => {
        const known = new Set(preset);
        const extras = (dbValues || []).filter((v) => v && !known.has(String(v).trim()));
        sel.innerHTML = [
            `<option value="">${placeholder}</option>`,
            ...preset.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`),
            ...extras.map((v) => `<option value="${esc(v)}">${esc(v)} (기존)</option>`),
            '<option value="__custom">직접 입력…</option>',
        ].join('');
    };
    const bindCustom = (sel, customInput) => {
        sel.onchange = () => {
            customInput.style.display = sel.value === '__custom' ? '' : 'none';
            if (sel.value === '__custom') customInput.focus();
        };
    };

    const genreSel = overlay.querySelector('#addsong-genre');
    buildOptions(genreSel, GENRES, dbGenres, '장르 선택… (사운드)');
    bindCustom(genreSel, overlay.querySelector('#addsong-genre-custom'));
    // 직접 고른 뒤에는 자동 매칭 결과가 그 위를 덮지 않는다.
    genreSel.addEventListener('change', () => { genreTouched = true; renderGenreMatchNote(); });
    overlay.querySelector('#addsong-genre-custom')
        .addEventListener('input', () => { genreTouched = true; });

    // 가수·곡명을 고치면 그 값으로 장르를 다시 찾는다. 파일 태그가 부실해
    // 처음엔 못 찾았다가 사용자가 채워 넣는 흐름이 흔하다.
    let rematchTimer = null;
    const rematchOnEdit = () => {
        if (pendingSongs.length !== 1) return;
        const song = pendingSongs[0];
        song.title = overlay.querySelector('#addsong-title').value.trim() || song.title;
        song.artist = overlay.querySelector('#addsong-artist').value.trim();
        clearTimeout(rematchTimer);
        rematchTimer = setTimeout(() => {
            delete song.autoGenre;   // 다시 찾을 대상으로 되돌린다
            autoMatchGenres();
        }, 600);
    };
    overlay.querySelector('#addsong-title').addEventListener('input', rematchOnEdit);
    overlay.querySelector('#addsong-artist').addEventListener('input', rematchOnEdit);

    const catSel = overlay.querySelector('#addsong-category');
    buildOptions(catSel, CATEGORIES, dbCategories, '카테고리 선택… (씬/시장)');
    bindCustom(catSel, overlay.querySelector('#addsong-category-custom'));
    renderModelChoices();
    renderPendingList();

    if (prefillLocalPaths && prefillLocalPaths.length > 0) {
        await pickLocalFiles(prefillLocalPaths);
    }
}
