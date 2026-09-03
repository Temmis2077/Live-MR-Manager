import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

describe('Red Orbit design system contract', () => {
  it('keeps the approved palette and semantic state tokens in the single source', () => {
    const css = read('src/styles/base.css');
    for (const token of [
      '--signal: #C95760', '--signal-hover: #D66B73', '--signal-active: #AD3E48',
      '--orbit: #9662B8', '--orbit-highlight: #B487CB', '--orbit-active: #754A91',
      '--orbit-deep: #654176', '--orbit-border: #4B3655', '--danger: #7F2932',
      '--wine: #522B31', '--bg-color: #121015', '--surface-1: #18151B',
      '--surface-2: #1E1A21', '--surface-3: #252029', '--text-main: #E7E0E6',
      '--text-muted: #B3AAB2', '--text-dim: #887F87', '--success:', '--warning:', '--info:', '--error:',
    ]) expect(css).toContain(token);
  });

  it('bundles the approved local fonts and their licenses', () => {
    for (const path of [
      'src/assets/fonts/LINESeedKR-Bold.woff2',
      'src/assets/fonts/SpaceMono-Regular.ttf',
      'src/assets/fonts/LINESeed-OFL.txt',
      'src/assets/fonts/SpaceMono-OFL.txt',
    ]) expect(existsSync(path), path).toBe(true);
  });

  it('loads the shared brand layer last', () => {
    const imports = read('src/style.css');
      const brand = imports.lastIndexOf("./styles/brand-system.css");
      expect(brand).toBeGreaterThan(-1);
      expect(brand).toBeGreaterThan(imports.lastIndexOf('@import'));
  });

  it('maps legacy themes to dark and does not expose a theme selector', () => {
    const main = read('src/main.js');
    const html = read('src/index.html');
    expect(main).toMatch(/function normalizeTheme\(_value\)[\s\S]*return 'dark'/);
    expect(html).not.toContain('theme-mode-select');
  });

  it('keeps Style Lab coverage for components, three screen samples, and all state meanings', () => {
    const lab = read('src/style-lab.html');
    expect((lab.match(/class="screen-sample"/g) || [])).toHaveLength(3);
    for (const text of ['재생 시작', 'Hover', 'Focus', '처리 중', '처리 대기', '초기화', 'AI 분리 중', '준비됨', '검토 필요', '처리 실패', '선택한 곡을 지울까요?']) {
      expect(lab).toContain(text);
    }
    for (const icon of ['재생', '궤도', '스템', '분리', '가사', '라이브']) expect(lab).toContain(`>${icon}<`);
    expect(lab).toContain('명도·면적 비교');
    expect(lab).toContain('Soft · 균형형 +1');
  });

  it('documents prohibited color use, WCAG AA, and the Style Lab approval flow', () => {
    const guide = read('docs/UI_DESIGN_GUIDELINES.md');
    for (const text of ['색상 사용 금지 사례', 'WCAG AA', 'Style Lab 승인 절차', '1280×720', '1440×900']) {
      expect(guide).toContain(text);
    }
  });

  it('does not reintroduce functional emoji or legacy accent colors in core UI', () => {
    const runtime = [
      'src/index.html', 'src/js/live-screen.js', 'src/js/ui/app-bar.js',
      'src/js/ui/library.js', 'src/js/alignment-viewer.js', 'src/js/onboarding.js',
    ].map(read).join('\n');
    expect(runtime).not.toMatch(/[🎵🎤🎚🎛🎧📁🔍⚡✨📝🎶]/u);

    const coreCss = [
      'src/styles/live.css', 'src/styles/alignment.css', 'src/styles/pages.css',
      'src/styles/player.css', 'src/styles/brand-system.css',
    ].map(read).join('\n');
    expect(coreCss.toLowerCase()).not.toMatch(/#(?:8b5cf6|a78bfa|7c3aed|6d28d9|8b45d6|a874e0|6366f1|3b82f6)/);
  });

  it('gives static icon-only close buttons an accessible name', () => {
    const html = read('src/index.html');
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) || [];
    const iconOnly = buttons.filter((button) => {
      const inner = button.replace(/^<button[^>]*>|<\/button>$/g, '');
      const visibleText = inner.replace(/<[^>]+>/g, '').replace(/&times;|×/g, '').trim();
      return !visibleText && /<svg|&times;|×/.test(inner);
    });
    expect(iconOnly.length).toBeGreaterThan(0);
    for (const button of iconOnly) expect(button).toMatch(/aria-label=/);
  });

  it('applies the Red Orbit performer hierarchy to the separate lyrics window', () => {
    const view = read('src/lyrics-view.html');
    expect(view).toContain('--signal: #C95760');
    expect(view).toContain('border-radius: 4px 10px 10px 10px');
    expect(view).toContain('class="play-signal"');
    expect(view).toContain('aria-label="항상 위에 표시"');
    expect(view).not.toContain('📌');
    expect(view.toLowerCase()).not.toContain('#8b5cf6');
  });

  it('limits the softened signal colour to rails and compact state accents', () => {
    const brand = read('src/styles/brand-system.css');
    expect(brand).toContain('border-left: 3px solid var(--signal)');
    expect(brand).toContain('background: var(--surface-2) !important');
    expect(brand).toContain('background: var(--surface-3) !important');
    expect(brand).not.toMatch(/\.appbar-add-song\s*\{[^}]*background:\s*var\(--signal\)/s);
  });

  it('uses the native Tauri event channel for in-app overlay views', () => {
    const shared = read('src/js/overlay/shared.js');
    expect(shared).toContain("tauri.event.listen('overlay-state-update'");
    expect(shared).toContain("tauri.core.invoke('get_overlay_state')");
    expect(shared).toContain("transport: 'tauri-event'");
    expect(shared).toContain('return connectWebSocket(onMessage, wsPort, onDisconnect)');
  });

  it('defines one compact workspace layout contract for every primary screen', () => {
    const base = read('src/styles/base.css');
    const layout = read('src/styles/layout.css');
    const html = read('src/index.html');
    for (const token of [
      '--space-1: 4px', '--space-2: 8px', '--space-3: 12px',
      '--space-4: 16px', '--space-6: 24px', '--space-8: 32px',
      '--control-sm: 28px', '--control-md: 34px', '--control-lg: 42px',
      '--panel-secondary: 288px', '--panel-detail: 356px', '--content-readable: 960px',
    ]) expect(base).toContain(token);
    for (const className of ['workspace', 'workspace-body', 'workspace-main', 'workspace-panel', 'workspace-drawer', 'action-row']) {
      expect(layout).toContain(`.${className}`);
    }
    for (const variant of ['workspace--library', 'workspace--live', 'workspace--alignment', 'workspace--settings', 'workspace--tasks']) {
      expect(html).toContain(variant);
    }
  });

  it('drives the app bar from an explicit action registry instead of hidden nav clicks', () => {
    const appBar = read('src/js/ui/app-bar.js');
    expect(appBar).toContain('export const APP_ACTIONS');
    expect(appBar).toContain("kind: 'screen'");
    expect(appBar).toContain("kind: 'tool'");
    expect(appBar).not.toContain('function clickNav');
  });

  it('lets pointer and keyboard users dismiss notifications immediately', () => {
    const utils = read('src/js/utils.js');
    const css = read('src/styles/notifications.css');
    expect(utils).toContain('toast.addEventListener("click", dismiss)');
    expect(utils).toContain('event.key !== "Enter" && event.key !== " "');
    expect(utils).toContain('눌러서 닫기');
    expect(css).toContain('.toast:focus-visible');
    expect(css).toContain('cursor: pointer');
  });

  it('groups overlay controls by task and keeps OBS addresses collapsed', () => {
    const overlay = read('src/js/ui/overlay-float.js');
    const css = read('src/styles/overlay-float.css');
    for (const label of ['화면 구성', '디자인', '가사', 'OBS 연결']) expect(overlay).toContain(label);
    expect(overlay).toContain("connectionDetails.className = 'ov-connection-details'");
    expect(overlay).not.toContain('connectionDetails.open = true');
    expect(overlay).toContain("tab._selectOverlayCategory?.('layout')");
    expect(css).toContain('grid-template-columns: minmax(520px, 1fr) minmax(360px, 420px)');
    expect(css).toContain('.ov-category-panel[hidden]');
    expect(css).toContain('height: clamp(260px, 52vh, 420px)');
    expect(css).toContain('.ov-connection-details[open] > .ai-model-card');
    expect(css).toContain('overflow-y: auto');
  });

  it('uses preview tabs only to switch render targets, not design settings', () => {
    const overlay = read('src/js/events/controls/overlay.js');
    expect(overlay).toContain('function normalizeOverlayConfig');
    expect(overlay).toContain('delete config.byTarget');
    expect(overlay).toContain('updateOverlaySettings(true)');
    expect(overlay).toContain('fontSize, effectFloat, effectGlow, visibility, design');
    expect(overlay).not.toContain('config.byTarget[currentTarget]');
    expect(overlay).not.toContain('const perTarget =');
  });
});
