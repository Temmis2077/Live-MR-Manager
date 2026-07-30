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

export function openOverlayFloat() {
  build();
  const tab = $('overlay-tab');
  if (!tab) return;

  // 원래 자리를 기억해 둔다 — 닫을 때 그대로 돌려놓아야 탭으로 열 때도 정상.
  if (tab.parentElement !== slot) {
    homeParent = tab.parentElement;
    homeNext = tab.nextElementSibling;
    slot.appendChild(tab);
  }

  lastFocus = document.activeElement;
  host.hidden = false;
  document.body.classList.add('ov-float-open');

  // 탭에서는 switchTab이 display를 켜 준다. 패널에서는 직접 켠다.
  tab.style.display = 'block';

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
