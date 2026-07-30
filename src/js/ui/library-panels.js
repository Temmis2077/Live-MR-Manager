/**
 * library-panels.js — 음원 관리 3단 레이아웃의 좌·우 패널
 *
 * claude.ai/design 시안 구성: 좌측 보관함(카테고리)·태그, 우측 인스펙터.
 * 두 패널은 기존 필터·메타데이터 경로를 그대로 쓴다 —
 *  - 보관함/태그 클릭은 라이브러리 필터(lib-category-filter, 검색어)를 움직이고
 *    renderLibrary()가 결과를 다시 그린다(필터 로직이 한 곳에만 있게).
 *  - 인스펙터의 저장은 update_song_metadata를 호출한다(곡 관리 모달과 동일).
 * 실제로 값이 없는 항목(예: 저장 용량 추정)은 만들어 넣지 않는다.
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { invoke } from '../tauri-bridge.js';
import { getSongCategoryFromMetadata, getLyricSyncStatus } from '../library-filters.js';
import { getThumbnailUrl, showNotification } from '../utils.js';

const $ = (id) => document.getElementById(id);

/** 인스펙터가 보여줄 곡 — 표에서 마지막으로 클릭한 곡. */
let inspectedPath = null;

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function isSeparated(song) {
  return !!(song && (song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path));
}

/* ────────────────────────────── 좌측: 보관함 · 태그 ───────── */

/** 라이브러리에 실제로 쓰인 카테고리와 곡 수를 센다. */
function collectCollections() {
  const counts = new Map();
  for (const s of state.songLibrary || []) {
    const c = getSongCategoryFromMetadata(s);
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function collectTags() {
  const counts = new Map();
  for (const s of state.songLibrary || []) {
    for (const t of s.tags || []) {
      const k = String(t).trim();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** 현재 활성 태그 — 검색창에 태그를 넣는 방식이라 검색어와 일치하는지로 판단. */
function activeTag() {
  const q = (elements.libSearchInput?.value || '').trim();
  return q;
}

export function renderCollections() {
  const list = $('lib-coll-list');
  const tagList = $('lib-tag-list');
  const foot = $('lib-side-foot');
  if (!list) return;

  const total = (state.songLibrary || []).length;
  const cur = elements.libCategoryFilter?.value || 'all';
  const colls = collectCollections();

  const rows = [
    `<button type="button" class="lib-coll${cur === 'all' ? ' active' : ''}" data-coll="all">
       <span class="lib-coll-dot"></span>
       <span class="lib-coll-name">전체</span>
       <span class="lib-coll-count">${total}</span>
     </button>`,
    ...colls.map(([name, n]) => `
      <button type="button" class="lib-coll${cur === name ? ' active' : ''}" data-coll="${esc(name)}">
        <span class="lib-coll-dot"></span>
        <span class="lib-coll-name" title="${esc(name)}">${esc(name)}</span>
        <span class="lib-coll-count">${n}</span>
      </button>`),
  ];
  list.innerHTML = rows.join('');

  list.querySelectorAll('.lib-coll').forEach((btn) => {
    btn.onclick = async () => {
      const val = btn.dataset.coll;
      // 기존 카테고리 필터를 그대로 움직인다 — 필터 로직은 library-filters.js 한 곳.
      if (elements.libCategoryFilter) elements.libCategoryFilter.value = val;
      // 커스텀 드롭다운 표시도 맞춘다(있을 때만).
      const dd = $('lib-category-dropdown');
      if (dd) {
        const sel = dd.querySelector('.selected-text');
        const opt = [...dd.querySelectorAll('.option-item')].find((o) => o.dataset.value === val);
        dd.querySelectorAll('.option-item').forEach((o) => o.classList.toggle('selected', o === opt));
        if (sel && opt) sel.textContent = opt.textContent;
        else if (sel && val === 'all') sel.textContent = '카테고리 전체';
      }
      const { renderLibrary } = await import('./library.js');
      renderLibrary();
      renderCollections();
    };
  });

  // 태그 — 클릭하면 그 태그로 검색한다(검색이 태그도 대상으로 하므로 실제로 걸러진다).
  if (tagList) {
    const tags = collectTags();
    const act = activeTag();
    tagList.innerHTML = tags.length
      ? tags.map(([name, n]) => `
          <button type="button" class="lib-tag${act === name ? ' active' : ''}" data-tag="${esc(name)}" title="${esc(name)} · ${n}곡">
            ${esc(name)}
          </button>`).join('')
      : '<div class="lib-side-empty">아직 태그가 없습니다. 곡을 고른 뒤 오른쪽에서 태그를 넣어 보세요.</div>';

    tagList.querySelectorAll('.lib-tag').forEach((btn) => {
      btn.onclick = async () => {
        const name = btn.dataset.tag;
        if (!elements.libSearchInput) return;
        // 같은 태그를 다시 누르면 해제.
        elements.libSearchInput.value = (activeTag() === name) ? '' : name;
        elements.libSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
        const { renderLibrary } = await import('./library.js');
        renderLibrary();
        renderCollections();
      };
    });
  }

  // 하단 요약 — 실제로 셀 수 있는 값만(전체 곡 / MR 준비된 곡).
  if (foot) {
    const ready = (state.songLibrary || []).filter(isSeparated).length;
    const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
    foot.innerHTML = `
      <div class="lib-stat-row"><span>MR 준비됨</span><span>${ready} / ${total}</span></div>
      <div class="lib-stat-bar"><div class="lib-stat-fill" style="width:${pct}%"></div></div>
      <div class="lib-stat-note">MR이 없는 곡은 표에서 “원곡만”으로 표시됩니다. 곡을 고르고 오른쪽에서 분리를 시작할 수 있습니다.</div>
    `;
  }
}

/* ────────────────────────────── 우측: 인스펙터 ───────────── */

/** 표에서 곡을 클릭할 때 호출 — 인스펙터 대상 지정. */
export function setInspectedSong(path) {
  inspectedPath = path;
  renderInspector();
}

function findSong(path) {
  return (state.songLibrary || []).find((s) => s.path === path) || null;
}

function fmtDate(ts) {
  if (!ts) return '-';
  const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('ko-KR');
}

export function renderInspector() {
  const box = $('lib-inspector');
  if (!box) return;

  // 대상이 없으면 재생 중인 곡을 기본으로 — 빈 화면보다 유용하다.
  const song = findSong(inspectedPath) || findSong(state.currentTrack?.path);
  if (!song) {
    box.innerHTML = `<div class="insp-empty">표에서 곡을 클릭하면<br>여기에서 정보를 고치고 스템을 확인할 수 있습니다.</div>`;
    return;
  }

  const sep = isSeparated(song);
  const task = (state.activeTasks || {})[song.path];
  const running = !!(task && task.status !== 'Finished');
  const sync = getLyricSyncStatus(song);
  const syncText = sync === 'synced' ? '싱크 완료' : (sync === 'unsynced' ? '가사만 있음' : '가사 없음');

  const stemRow = (name, done) => `
    <div class="insp-stem${done ? ' done' : ''}">
      <span class="insp-stem-bar"></span>
      <span class="insp-stem-name">${name}</span>
      <span class="insp-stem-status">${done ? '있음' : (running ? '분리 중' : '없음')}</span>
    </div>`;

  box.innerHTML = `
    <div class="insp-section">
      <div class="insp-head">
        <div class="insp-art"><img src="${esc(getThumbnailUrl(song.thumbnail, song))}" alt=""></div>
        <div style="min-width:0; flex:1">
          <div class="insp-label">선택한 곡</div>
          <div class="insp-title">${esc(song.title || '제목 없음')}</div>
          <div class="insp-artist">${esc(song.artist || '가수 정보 없음')}</div>
        </div>
      </div>
      <div class="insp-actions">
        <button type="button" class="insp-btn primary" id="insp-play">재생</button>
        <button type="button" class="insp-btn" id="insp-separate">${sep ? '다시 분리' : 'MR 분리'}</button>
      </div>
    </div>

    <div class="insp-section">
      <div class="insp-label">정보 수정</div>
      <div class="insp-fields">
        <div>
          <div class="insp-field-label">제목</div>
          <input class="insp-input" id="insp-title-in" value="${esc(song.title || '')}">
        </div>
        <div>
          <div class="insp-field-label">가수</div>
          <input class="insp-input" id="insp-artist-in" value="${esc(song.artist || '')}">
        </div>
        <div>
          <div class="insp-field-label">장르</div>
          <input class="insp-input" id="insp-genre-in" value="${esc(song.genre || '')}">
        </div>
        <div class="insp-row-2">
          <div>
            <div class="insp-field-label">키</div>
            <input class="insp-input" id="insp-key-in" value="${esc(song.songKey || song.song_key || '')}">
          </div>
          <div>
            <div class="insp-field-label">BPM</div>
            <input class="insp-input" id="insp-bpm-in" value="${esc(song.bpm ?? '')}" inputmode="numeric">
          </div>
        </div>
        <div>
          <div class="insp-field-label">태그 (쉼표로 구분)</div>
          <input class="insp-input" id="insp-tags-in" value="${esc((song.tags || []).join(', '))}">
        </div>
      </div>
      <div class="insp-actions">
        <button type="button" class="insp-btn primary" id="insp-save">저장</button>
      </div>
    </div>

    <div class="insp-section">
      <div class="insp-label">스템 파일</div>
      <div style="margin-top:9px">
        ${stemRow('보컬', sep)}
        ${stemRow('반주 (MR)', sep)}
      </div>
      <div class="insp-meta-row" style="margin-top:10px">
        <span>가사</span><span>${syncText}</span>
      </div>
    </div>

    <div class="insp-section" style="border-bottom:none">
      <div class="insp-label">파일 · 처리 이력</div>
      <div class="insp-meta-row"><span>길이</span><span>${esc(song.duration || '-')}</span></div>
      <div class="insp-meta-row"><span>추가일</span><span>${fmtDate(song.dateAdded ?? song.date_added)}</span></div>
      <div class="insp-meta-row"><span>재생 횟수</span><span>${song.playCount ?? song.play_count ?? 0}</span></div>
      <div class="insp-meta-row"><span>경로</span><span title="${esc(song.path)}">${esc(song.path)}</span></div>
      <div class="insp-actions">
        <button type="button" class="insp-btn" id="insp-folder">폴더 열기</button>
        <button type="button" class="insp-btn danger" id="insp-delete">곡 삭제</button>
      </div>
    </div>
  `;

  wireInspector(song);
}

function wireInspector(song) {
  const idx = (state.songLibrary || []).findIndex((s) => s.path === song.path);

  $('insp-play')?.addEventListener('click', async () => {
    if (idx < 0) return;
    const { selectTrack } = await import('../player.js');
    selectTrack(idx);
  });

  $('insp-separate')?.addEventListener('click', async () => {
    const { startMrSeparation } = await import('../audio.js');
    try {
      await startMrSeparation(song.path, null);
    } catch (_) { /* startMrSeparation이 자체 알림을 띄운다 */ }
  });

  $('insp-save')?.addEventListener('click', async () => {
    const bpmRaw = ($('insp-bpm-in')?.value || '').trim();
    const bpm = bpmRaw === '' ? null : Number.parseInt(bpmRaw, 10);
    if (bpmRaw !== '' && !Number.isFinite(bpm)) {
      showNotification('BPM은 숫자로 입력해 주세요.', 'warning');
      return;
    }
    const updated = {
      ...song,
      title: ($('insp-title-in')?.value || '').trim() || song.title,
      artist: ($('insp-artist-in')?.value || '').trim(),
      genre: ($('insp-genre-in')?.value || '').trim(),
      songKey: ($('insp-key-in')?.value || '').trim(),
      bpm,
      tags: ($('insp-tags-in')?.value || '').split(',').map((t) => t.trim()).filter(Boolean),
    };
    try {
      await invoke('update_song_metadata', { song: updated });
      // 로컬 상태도 갱신해 표·패널이 바로 반영되게 한다.
      if (idx >= 0) state.songLibrary[idx] = updated;
      const { renderLibrary } = await import('./library.js');
      renderLibrary();
      renderCollections();
      renderInspector();
      showNotification('곡 정보를 저장했습니다.', 'success');
    } catch (err) {
      showNotification('저장하지 못했습니다: ' + err, 'error');
    }
  });

  $('insp-folder')?.addEventListener('click', async () => {
    try {
      await invoke('open_mr_folder', { path: song.path });
    } catch (err) {
      showNotification('폴더를 열지 못했습니다: ' + err, 'error');
    }
  });

  $('insp-delete')?.addEventListener('click', async () => {
    if (idx < 0) return;
    const { openConfirmModal } = await import('./modals.js');
    openConfirmModal('곡 삭제', `'${song.title}' 곡을 목록에서 삭제할까요?`, async () => {
      const { performDeleteSong, renderLibrary } = await import('./library.js');
      try {
        await performDeleteSong(idx);
        inspectedPath = null;
        renderLibrary();
        renderCollections();
        renderInspector();
        showNotification('곡을 삭제했습니다.', 'success');
      } catch (err) {
        showNotification('삭제하지 못했습니다: ' + err, 'error');
      }
    });
  });
}

/** 음악 탭 진입 시 3단 패널을 갱신한다. */
export function refreshLibraryPanels() {
  renderCollections();
  renderInspector();
}
