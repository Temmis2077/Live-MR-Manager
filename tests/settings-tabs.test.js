/**
 * 설정 화면 하위 탭 회귀 테스트.
 *
 * 이 화면은 두 번 "긴 리스트"로 되돌아갔다. 원인은 매번 같았다 —
 * 카테고리를 섹션 안의 대표 버튼 id로 추론했는데, 그 버튼을 다른 화면으로
 * 옮기거나 지우면 섹션이 카테고리를 잃고 전부 '일반'으로 흘러들었다.
 * 설정과 무관한 작업이 설정 화면을 망가뜨렸고, 오류도 안 났다.
 *
 * 그래서 카테고리를 마크업(data-scat)이 직접 들고, 여기서 그걸 지킨다.
 * index.html을 직접 읽어 검사하므로 DOM 구동이 필요 없다.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve('src/index.html'), 'utf-8');

/** #settings-page 안의 마크업만 잘라 낸다(다른 화면의 settings-group 제외). */
function settingsPageHtml() {
  const start = html.indexOf('id="settings-page"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

/** 설정 페이지 안의 .settings-group 여는 태그들. */
function groupTags() {
  const seg = settingsPageHtml();
  return seg.match(/<section[^>]*class="settings-group"[^>]*>/g) || [];
}

const CATEGORIES = ['general', 'media', 'ai', 'library', 'about'];

describe('설정 하위 탭 — 카테고리 태깅', () => {
  it('설정 페이지에 섹션이 존재한다', () => {
    expect(groupTags().length).toBeGreaterThan(0);
  });

  it('모든 설정 섹션이 data-scat을 직접 선언한다', () => {
    const missing = groupTags().filter((tag) => !/\bdata-scat="/.test(tag));
    // 실패하면 새로 추가한 섹션에 data-scat을 빠뜨린 것이다.
    // 그대로 두면 그 섹션이 '일반' 탭으로 흘러들어 설정이 리스트처럼 보인다.
    expect(missing).toEqual([]);
  });

  it('data-scat 값이 모두 알려진 카테고리다', () => {
    const bad = groupTags()
      .map((tag) => (tag.match(/\bdata-scat="([^"]*)"/) || [])[1])
      .filter((v) => v && !CATEGORIES.includes(v));
    expect(bad).toEqual([]);
  });

  it('하위 탭 버튼의 data-scat도 같은 목록을 쓴다', () => {
    const seg = settingsPageHtml();
    const barIdx = seg.indexOf('id="settings-subtabs"');
    expect(barIdx).toBeGreaterThan(-1);
    const bar = seg.slice(barIdx, barIdx + 2000);
    const btnCats = [...bar.matchAll(/class="settings-subtab-btn"[^>]*data-scat="([^"]+)"/g)]
      .map((m) => m[1]);
    expect(btnCats.length).toBeGreaterThan(0);
    btnCats.forEach((c) => expect(CATEGORIES).toContain(c));
  });

  it('모든 탭 버튼에 대응하는 섹션이 하나 이상 있다 (빈 탭 금지)', () => {
    const secCats = new Set(
      groupTags().map((tag) => (tag.match(/\bdata-scat="([^"]*)"/) || [])[1]),
    );
    const seg = settingsPageHtml();
    const barIdx = seg.indexOf('id="settings-subtabs"');
    const bar = seg.slice(barIdx, barIdx + 2000);
    const btnCats = [...bar.matchAll(/class="settings-subtab-btn"[^>]*data-scat="([^"]+)"/g)]
      .map((m) => m[1]);
    btnCats.forEach((c) => expect(secCats.has(c)).toBe(true));
  });
});

describe('설정 하위 탭 — 앵커 추론이 되살아나지 않게', () => {
  it('settings-tabs.js는 더 이상 대표 버튼 id로 카테고리를 추론하지 않는다', () => {
    const src = fs.readFileSync(path.resolve('src/js/events/settings-tabs.js'), 'utf-8');
    // SCAT_ANCHORS 방식이 돌아오면 같은 회귀가 다시 난다.
    // (주석에서 과거 사정을 설명하는 건 괜찮다 — 선언·사용만 막는다.)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/SCAT_ANCHORS/);
    expect(code).not.toMatch(/getElementById\(id\)[\s\S]{0,80}closest\('\.settings-group'\)/);
    expect(src).toMatch(/data-scat/);
  });

  it('설정 화면에 들어올 때 탭을 다시 적용한다', () => {
    const nav = fs.readFileSync(path.resolve('src/js/events/navigation.js'), 'utf-8');
    expect(nav).toMatch(/refreshSettingsTabs/);
  });
});
