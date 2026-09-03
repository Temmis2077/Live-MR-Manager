import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/js/lrc-parser.js', () => ({
  getDisplayLineModel: (seg) => seg.displayModel || [
    { text: seg.text, role: 'text', progressTarget: true },
  ],
}));

describe('세 화면 가사 와이프 마크업', () => {
  beforeEach(() => {
    globalThis.document = {
      createElement() {
        let value = '';
        return {
          set textContent(next) {
            value = String(next)
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;');
          },
          get innerHTML() { return value; },
        };
      },
      getElementById() { return null; },
    };
  });

  it('기본 글자와 강조 글자가 완전히 같은 내용을 사용한다', async () => {
    const { karaokeLineHtml } = await import('../src/js/live-lyrics.js');
    const html = karaokeLineHtml({ displayModel: [
      { text: '아무리 <우겨도>', role: 'text', progressTarget: true },
    ] });
    const primary = '아무리 &lt;우겨도&gt;';
    expect(html).toContain(`<span class="live-lyric-base">${primary}</span>`);
    expect(html).toContain(`<span class="live-lyric-wipe" aria-hidden="true">${primary}</span>`);
    expect(html.match(new RegExp(primary, 'g'))).toHaveLength(2);
  });

  it('3줄 모드에서는 차음만 진행 대상으로 둔다', async () => {
    const { karaokeLineHtml } = await import('../src/js/live-lyrics.js');
    const html = karaokeLineHtml({ displayModel: [
      { text: '原文', role: 'original', progressTarget: false },
      { text: '차음', role: 'pronunciation', progressTarget: true },
      { text: '번역', role: 'translation', progressTarget: false },
    ] });
    expect(html.match(/live-lyric-sub/g)).toHaveLength(2);
    expect(html.match(/data-progress-target="true"/g)).toHaveLength(1);
    expect(html).toContain('data-lyric-role="pronunciation" data-progress-target="true"');
    expect(html.match(/차음/g)).toHaveLength(2);
    expect(html.match(/번역/g)).toHaveLength(1);
  });

  it('모든 표면이 같은 0~1 CSS 변수 이름을 사용한다', async () => {
    const fs = await import('node:fs');
    const liveCss = fs.readFileSync('src/styles/live.css', 'utf8');
    const screen = fs.readFileSync('src/js/live-screen.js', 'utf8');
    const overlay = fs.readFileSync('src/overlay-lyrics.html', 'utf8');
    expect(liveCss).toContain('clip-path: inset(0 calc((1 - var(--lyric-wipe, 0)) * 100%) 0 0)');
    expect(liveCss).toContain('.live-lyric-display-line > .live-lyric-base');
    expect(liveCss).toContain('-webkit-text-fill-color: var(--accent-secondary)');
    expect(screen).toContain('paintLyricElementProgress(curEl, ratio)');
    expect(overlay).toContain("setProperty('--lyric-wipe', ratio.toFixed(4))");
    expect(overlay).not.toContain('distributeWipeAcrossLines');
    expect(overlay).not.toContain('getClientRects()');
    expect(`${liveCss}${screen}${overlay}`).not.toMatch(/--karaoke-progress|--lyric-progress|var\(--wipe[,)]/);
  });

  it('일시정지와 앱 연결 종료 시 오버레이를 숨긴다', async () => {
    const fs = await import('node:fs');
    const lyrics = fs.readFileSync('src/overlay-lyrics.html', 'utf8');
    const info = fs.readFileSync('src/overlay-info.html', 'utf8');
    const shared = fs.readFileSync('src/js/overlay/shared.js', 'utf8');
    expect(lyrics).toContain('if (!data.is_playing && !isPreview)');
    expect(lyrics).toContain('connectWS(updateOverlay, undefined, () =>');
    expect(info).toContain('connectWS(update, undefined, () =>');
    expect(shared).toContain("if (typeof onDisconnect === 'function') onDisconnect()");
  });

  it('반복 패킷은 가사 DOM을 다시 만들지 않고 진행률을 보존한다', async () => {
    const fs = await import('node:fs');
    const lyrics = fs.readFileSync('src/overlay-lyrics.html', 'utf8');
    expect(lyrics).toContain('currentText === displayedCurrent && nextText === displayedNext');
    expect(lyrics).toContain("wipe.innerHTML = source?.innerHTML || ''");
    expect(lyrics).not.toContain('ResizeObserver');
    expect(lyrics).not.toContain('rebuildWipeRows');
    expect(lyrics).toContain('if (!overlay.classList.contains(directionClass))');
    expect(lyrics.match(/classList\.remove\('dir-left', 'dir-right', 'dir-top', 'dir-bottom'\)/g))
      .toHaveLength(1);
  });

  it('중앙 가사는 리드인에서 가창으로 바뀔 때 같은 DOM을 다시 만들지 않는다', async () => {
    const fs = await import('node:fs');
    const screen = fs.readFileSync('src/js/live-screen.js', 'utf8');
    expect(screen).toContain('const key = html;');
    expect(screen).toContain('const cueKey = `${performerModel.displayIndex}`;');
    expect(screen).not.toContain("`${model.pending ? 'pre' : 'sing'}|${html}`");
  });

  it('앱 미리보기는 실제 가사 상태를 바꾸지 않고 전용 메시지로 즉시 갱신한다', async () => {
    const fs = await import('node:fs');
    const lyrics = fs.readFileSync('src/overlay-lyrics.html', 'utf8');
    const info = fs.readFileSync('src/overlay-info.html', 'utf8');
    const controls = fs.readFileSync('src/js/events/controls/overlay.js', 'utf8');
    expect(lyrics).toContain("previewStyleFromMessage(event.data, 'lyrics')");
    expect(info).toContain("previewStyleFromMessage(event.data, 'info')");
    expect(controls).toContain("type: 'osw-overlay-preview-style'");
    expect(controls).toContain('overlayIframe.contentWindow.postMessage');
    expect(controls).not.toContain('updateOverlayLyrics(');
  });

  it('곡 정보 오버레이는 공용 연결 외의 Tauri 이벤트를 중복 구독하지 않는다', async () => {
    const fs = await import('node:fs');
    const info = fs.readFileSync('src/overlay-info.html', 'utf8');
    expect(info).not.toContain("__TAURI__.event.listen('overlay-state-update'");
    expect(info).toContain('connectWS(update, undefined, () =>');
  });
});
