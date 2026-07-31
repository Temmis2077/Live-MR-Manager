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
const $ = (id) => document.getElementById(id);

let host = null;        // 떠 있는 패널
let slot = null;        // 설정 UI가 들어갈 자리
let homeParent = null;  // 원래 부모
let homeNext = null;    // 원래 다음 형제 (순서 복원용)
let lastFocus = null;

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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !host.hidden) close();
  });
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
  const designCard = tab.querySelector('#overlay-preset-row')?.closest('.ai-model-card');
  const forceVisibleRow = tab.querySelector('#toggle-overlay-force-visible')?.closest('.group-header');

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

  const guide = document.createElement('div');
  guide.className = 'ov-guide';
  guide.innerHTML = `
    <div class="ov-guide-title">OBS 쪽 설정은 한 번만</div>
    <div class="ov-guide-body">
      소스 추가 → <strong>브라우저</strong> → 왼쪽 주소 붙여넣기 →
      “장면이 활성화될 때 새로 고침” 켜기.
      배경은 투명하게 전달되므로 <strong>색상 키를 쓸 필요가 없습니다.</strong>
    </div>
    <div class="ov-guide-body" style="margin-top:8px">
      방송 중에는 이 창을 닫아도 됩니다. 라이브 화면에서 만진 값이 오버레이에 바로 반영됩니다.
    </div>`;
  right.appendChild(guide);

  // 좌측 — 연결·URL이 맨 위(시안 순서), 그 아래 디자인 설정
  if (forceVisibleRow) left.appendChild(forceVisibleRow);
  if (urlCard) left.appendChild(urlCard);
  if (designCard) left.appendChild(designCard);

  tab.dataset.paned = '1';
}

export function openOverlayFloat() {
  build();
  const tab = $('overlay-tab');
  if (!tab) return;
  restructureIntoPanes(tab);

  // 원래 자리를 기억해 둔다 — 닫을 때 그대로 돌려놓아야 탭으로 열 때도 정상.
  if (tab.parentElement !== slot) {
    homeParent = tab.parentElement;
    homeNext = tab.nextElementSibling;
    slot.appendChild(tab);
  }

  lastFocus = document.activeElement;
  host.hidden = false;
  document.body.classList.add('ov-float-open');

  tab.style.display = 'block';

  // 미리보기 iframe은 처음 열 때 한 번만 붙인다 — 열 때마다 다시 불러오면
  // 미리보기가 늦게 뜨고 현재 상태가 끊긴다.
  const iframe = $('overlay-iframe');
  if (iframe && !iframe.src) iframe.src = 'overlay-info.html?preview=true';

  // 키보드 사용자가 패널 안에서 시작하도록 초점을 옮긴다. 보이게 된 직후
  // 바로 잡아야 한다 — rAF로 미루면 그 사이에 초점이 body로 빠진다.
  host.querySelector('.ov-float-close')?.focus();

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

  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

export function isOpen() {
  return !!host && !host.hidden;
}
