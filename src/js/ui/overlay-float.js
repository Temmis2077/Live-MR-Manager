/**
 * overlay-float.js — 오버레이 설정을 라이브 화면 위에 띄우는 패널
 *
 * 라이브 중에는 화면을 떠나는 것 자체가 비용이다(재생·큐·모니터가 다 여기 있다).
 * 그래서 오버레이 설정을 별도 탭으로 보내지 않고 라이브 위에 떠서 열린다.
 *
 * 설계 — 설정 UI를 복제하지 않는다. 기존 #overlay-tab 노드를 패널 안으로
 * 옮기고(appendChild) 닫을 때 원래 자리로 되돌린다. 그래야 프리셋·슬라이더·
 * 리셋 버튼에 붙어 있는 핸들러와 상태가 하나로 유지된다.
 */
import { pushLayer, popLayer } from './layer-stack.js';

const $ = (id) => document.getElementById(id);

let host = null;        // 떠 있는 패널
let slot = null;        // 설정 UI가 들어갈 자리
let homeParent = null;  // 원래 부모
let homeNext = null;    // 원래 다음 형제 (순서 복원용)
let layer = null;       // 레이어 스택 핸들 (Esc·포커스 복귀 담당)

function build() {
  if (host) return;

  host = document.createElement('div');
  host.className = 'ov-float';
  host.id = 'ov-float';
  host.hidden = true;
  host.innerHTML = `
    <div class="ov-float-scrim" data-ov-close></div>
    <div class="ov-float-panel" role="dialog" aria-modal="true" aria-labelledby="ov-float-title">
      <div class="ov-float-head">
        <div>
          <div class="ov-float-title" id="ov-float-title">오버레이 설정</div>
          <div class="ov-float-sub">라이브를 벗어나지 않고 방송 화면을 손볼 수 있습니다.</div>
        </div>
        <button type="button" class="ov-float-close" data-ov-close aria-label="오버레이 설정 닫기">✕</button>
      </div>
      <div class="ov-float-body" id="ov-float-slot"></div>
    </div>`;

  document.body.appendChild(host);
  slot = $('ov-float-slot');

  host.querySelectorAll('[data-ov-close]').forEach((el) => {
    el.addEventListener('click', close);
  });
  // Esc는 ui/layer-stack.js가 맡는다 — 여러 개가 떠 있을 때 최상단 하나만
  // 닫히도록 앱 전체가 같은 규칙을 쓴다.
}

/**
 * 시안(design/)의 오버레이 설정 화면 구성으로 한 번만 재배치한다.
 *
 * 좌: 설정(연결·URL → 프리셋 → 세부) / 우: 미리보기(체커보드 = 투명) + OBS 안내.
 * 요소를 새로 만들지 않고 기존 노드를 옮기기만 한다 — 프리셋·슬라이더·복사
 * 버튼에 이미 붙어 있는 핸들러를 그대로 살리기 위해서다(ID도 유지).
 */
function restructureIntoPanes(tab) {
  if (tab.dataset.paned === '1') return;

  const panes = document.createElement('div');
  panes.className = 'ov-panes';
  const left = document.createElement('div');
  left.className = 'ov-pane-left';
  const right = document.createElement('div');
  right.className = 'ov-pane-right';
  panes.append(left, right);

  // 옮길 블록을 미리 잡아둔다(옮기는 순간 DOM 순서가 바뀌므로).
  const previewTabs = tab.querySelector('.preview-tabs-container');
  const previewStatus = tab.querySelector('.overlay-preview-status');
  const previewBox = tab.querySelector('.overlay-preview-wrapper');
  // 각 카드는 "안에 무엇이 있는가"로 찾는다 — 구조가 바뀌어도 덜 깨진다.
  const urlCard = tab.querySelector('#overlay-url-display')?.closest('.ai-model-card');
  const designCard = tab.querySelector('#overlay-preset-dropdown')?.closest('.ai-model-card');
  const visibilityCard = tab.querySelector('.ov-visibility-card');
  const offsetCard = tab.querySelector('.ov-offset-card');
  const lyricOptions = tab.querySelector('.lyric-line-visibility-toggle')?.closest('div[style*="background"]');
  const forceVisibleRow = tab.querySelector('#toggle-overlay-force-visible')?.closest('.group-header');
  const forceVisibleTitle = forceVisibleRow?.querySelector('h3');
  if (forceVisibleTitle) forceVisibleTitle.textContent = '미리보기 상태';

  const container = tab.querySelector('.overlay-tab-container') || tab;
  container.appendChild(panes);

  // 우측 — 미리보기가 위, 그 아래 OBS 안내
  const head = document.createElement('div');
  head.className = 'ov-preview-head';
  head.innerHTML = `
    <div>
      <div class="ov-preview-title">OBS 미리보기</div>
      <div class="ov-preview-sub">격자 무늬는 실제 방송에서 투명하게 나가는 부분입니다.</div>
    </div>`;
  right.appendChild(head);
  if (previewStatus) head.appendChild(previewStatus);
  if (previewTabs) right.appendChild(previewTabs);
  if (previewBox) {
    previewBox.classList.add('ov-preview-canvas');
    right.appendChild(previewBox);
  }

  const categoryNav = document.createElement('nav');
  categoryNav.className = 'ov-category-nav';
  categoryNav.setAttribute('role', 'tablist');
  categoryNav.setAttribute('aria-label', '오버레이 설정 분류');

  const categoryBody = document.createElement('div');
  categoryBody.className = 'ov-category-body';
  const categories = [
    { id: 'layout', label: '화면 구성', hint: '표시 항목 · 타이밍' },
    { id: 'design', label: '디자인', hint: '프리셋 · 크기 · 색' },
    { id: 'lyrics', label: '가사', hint: '원문 · 차음 · 번역' },
    { id: 'connection', label: 'OBS 연결', hint: '주소 · 네트워크' },
  ];

  const panels = new Map();
  const selectCategory = (id, focus = false) => {
    const safeId = panels.has(id) ? id : 'layout';
    categoryNav.querySelectorAll('[data-ov-category]').forEach((button) => {
      const active = button.dataset.ovCategory === safeId;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    panels.forEach((panel, panelId) => { panel.hidden = panelId !== safeId; });
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  tab._selectOverlayCategory = selectCategory;

  categories.forEach((category, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ov-category-tab';
    button.dataset.ovCategory = category.id;
    button.id = `ov-category-${category.id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `ov-category-panel-${category.id}`);
    button.innerHTML = `<span>${category.label}</span><small>${category.hint}</small>`;
    button.addEventListener('click', () => selectCategory(category.id));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
      selectCategory(categories[next].id, true);
    });
    categoryNav.appendChild(button);

    const panel = document.createElement('section');
    panel.className = 'ov-category-panel';
    panel.id = `ov-category-panel-${category.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panels.set(category.id, panel);
    categoryBody.appendChild(panel);
  });

  left.append(categoryNav, categoryBody);

  if (forceVisibleRow) panels.get('layout').appendChild(forceVisibleRow);
  if (visibilityCard) panels.get('layout').appendChild(visibilityCard);
  if (offsetCard) panels.get('layout').appendChild(offsetCard);
  if (designCard) panels.get('design').appendChild(designCard);
  if (lyricOptions) {
    const lyricCard = document.createElement('div');
    lyricCard.className = 'ai-model-card ov-lyrics-card';
    lyricCard.innerHTML = '<div class="ai-title-large">가사 표시 줄</div><div class="ai-model-desc">인앱 가사창과 OBS에 보여줄 줄을 각각 선택합니다.</div>';
    lyricCard.appendChild(lyricOptions);
    panels.get('lyrics').appendChild(lyricCard);
  }

  if (urlCard) {
    const connectionDetails = document.createElement('details');
    connectionDetails.className = 'ov-connection-details';
    connectionDetails.innerHTML = `
      <summary>
        <span><strong>브라우저 소스 주소 보기</strong><small>OBS에 처음 추가하거나 주소를 다시 확인할 때만 펼치세요.</small></span>
      </summary>`;
    connectionDetails.appendChild(urlCard);
    panels.get('connection').appendChild(connectionDetails);
  }

  const guide = document.createElement('div');
  guide.className = 'ov-guide';
  guide.innerHTML = `
    <div class="ov-guide-title">OBS 연결은 처음 한 번만</div>
    <div class="ov-guide-body">소스 추가 → <strong>브라우저</strong> → 주소 붙여넣기 → “장면이 활성화될 때 새로 고침”을 켜세요. 색상 키는 필요 없습니다.</div>`;
  panels.get('connection').appendChild(guide);

  // 위 목록에 없는 나머지도 전부 왼쪽으로 쓸어 담는다.
  //
  // 예전에는 아는 카드만 옮기고 끝냈다. 그래서 설정 화면에 카드를 새로 넣으면
  // 그 카드만 .ov-panes 바깥에 남아 패널을 뚫고 나갔다(가사 타이밍 보정 카드가
  // 실제로 그렇게 됐다). 오버레이와 무관한 작업이 이 화면을 깨뜨리면 안 된다.
  // 순서는 위에서 정한 것이 유지되고, 모르는 카드는 그 아래에 붙는다.
  Array.from(container.children).forEach((child) => {
    if (child !== panes && child.childElementCount > 0) panels.get('layout').appendChild(child);
  });

  // 창을 다시 열 때는 항상 실제 조절 화면부터 보인다. OBS 주소를 마지막으로
  // 확인했더라도 다음 진입까지 주소 화면이 따라오지 않게 한다.
  selectCategory('layout');

  tab.dataset.paned = '1';
}

export function openOverlayFloat() {
  build();
  // 이미 열려 있으면 아무것도 하지 않는다. 그대로 두면 pushLayer가 한 번 더
  // 불려 앞의 핸들을 잃어버리고, 그 레이어가 스택에 영영 남는다.
  if (!host.hidden) return;

  const tab = $('overlay-tab');
  if (!tab) return;
  restructureIntoPanes(tab);
  tab._selectOverlayCategory?.('layout');

  // 원래 자리를 기억해 둔다 — 닫을 때 그대로 돌려놓아야 탭으로 열 때도 정상.
  if (tab.parentElement !== slot) {
    homeParent = tab.parentElement;
    homeNext = tab.nextElementSibling;
    slot.appendChild(tab);
  }

  host.hidden = false;
  document.body.classList.add('ov-float-open');

  tab.style.display = 'block';

  // 미리보기 iframe은 처음 열 때 한 번만 붙인다 — 열 때마다 다시 불러오면
  // 미리보기가 늦게 뜨고 현재 상태가 끊긴다.
  const iframe = $('overlay-iframe');
  if (iframe && !iframe.src) iframe.src = 'overlay-info.html?preview=true';

  // 레이어에 올리면 초점 이동·Tab 순환·닫은 뒤 초점 복귀를 한 번에 받는다.
  // 보이게 된 직후 바로 올려야 한다 — 미루면 그 사이 초점이 body로 빠진다.
  layer = pushLayer({
    id: 'overlay-float',
    el: host.querySelector('.ov-float-panel'),
    close,
  });

  // 숨겨져 있던 동안 미리보기 크기 계산이 밀려 있다 — 보이게 된 뒤 한 번 알린다.
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

export function close() {
  if (!host || host.hidden) return;
  const tab = $('overlay-tab');

  host.hidden = true;
  document.body.classList.remove('ov-float-open');

  if (tab) {
    tab.style.display = 'none';
    // 원래 자리로 복귀 — 그래야 ⚙ 메뉴에서 전체 화면으로 열 때도 그대로 뜬다.
    if (homeParent) {
      if (homeNext && homeNext.parentElement === homeParent) homeParent.insertBefore(tab, homeNext);
      else homeParent.appendChild(tab);
    }
  }

  popLayer(layer);
  layer = null;
}

export function isOpen() {
  return !!host && !host.hidden;
}
