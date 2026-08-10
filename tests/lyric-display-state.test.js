/**
 * 가사 표시 상태를 갈아끼우는 경로 회귀 테스트.
 *
 * 표시용 가사가 바뀌는 경로가 셋이었고(곡 선택 / 편집기에서 열기 / 싱크 저장)
 * 각자 다른 것만 치웠다. 그래서 싱크를 고치면 마커가 옛것으로 남아 오버레이가
 * 이유 없이 비고, 사이드카를 다시 안 읽어 단어 단위 진행도가 사라졌다.
 *
 * 이제 setDisplayLyrics 하나로 모았다. 여기서 그 규칙을 지킨다 — 새 경로가
 * 생겨도 직접 대입하면 실패한다.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('src/js');

/** src/js 아래 모든 .js 파일. */
function allSources(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'libs') continue;   // 서드파티 번들 제외
      allSources(p, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const OWNER = path.join(SRC, 'lyric-drawer.js');

describe('표시용 가사는 한 곳에서만 갈아끼운다', () => {
  it('lyric-drawer.js 밖에서 state.currentLyrics에 직접 대입하지 않는다', () => {
    const offenders = allSources()
      .filter((f) => f !== OWNER)
      .filter((f) => /state\.currentLyrics\s*=[^=]/.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(SRC, f));
    // 직접 대입하면 마커·인덱스·오버레이 구간을 같이 못 치워 표시가 깨진다.
    // setDisplayLyrics(segments, markers)를 쓸 것.
    expect(offenders).toEqual([]);
  });

  it('lyric-drawer.js 밖에서 state.currentMarkers에 직접 대입하지 않는다', () => {
    const offenders = allSources()
      .filter((f) => f !== OWNER)
      .filter((f) => /state\.currentMarkers\s*=[^=]/.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('setDisplayLyrics가 치워야 할 것을 모두 치운다', () => {
    const src = fs.readFileSync(OWNER, 'utf-8');
    const body = src.slice(src.indexOf('export function setDisplayLyrics'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);
    // 가사·마커·인덱스·오버레이 구간·중복 억제 캐시 — 하나라도 빠지면
    // 예전처럼 옛 값이 남아 표시가 깨진다.
    expect(fn).toMatch(/state\.currentLyrics\s*=/);
    expect(fn).toMatch(/state\.currentMarkers\s*=/);
    expect(fn).toMatch(/state\.currentLyricIndex\s*=\s*-1/);
    expect(fn).toMatch(/state\.overlayLyricWindow\s*=\s*null/);
    expect(fn).toMatch(/lastOverlayCurrent\s*=\s*null/);
    expect(fn).toMatch(/lastOverlayNext\s*=\s*null/);
  });

  it('마커를 안 주면 빈 것으로 초기화한다 (옛 마커를 남기지 않는다)', () => {
    const src = fs.readFileSync(OWNER, 'utf-8');
    const body = src.slice(src.indexOf('export function setDisplayLyrics'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);
    // 옛 간주·보컬 시작 마커가 남으면 isInInstrumental이 엉뚱한 구간에서
    // 참이 되어 오버레이가 이유 없이 빈다.
    expect(fn).toMatch(/markers\s*\|\|\s*\{\s*vocalStartSec:\s*null/);
  });
});

describe('싱크를 저장한 뒤에도 사이드카를 다시 읽는다', () => {
  it('편집기 저장 경로가 loadLyricsAndMarkers를 쓴다', () => {
    const src = fs.readFileSync(path.join(SRC, 'alignment-viewer.js'), 'utf-8');
    // parseLrc만 쓰면 단어 타임(사이드카)과 마커가 빠진다.
    const after = src.slice(src.indexOf('editedIsPlaying'));
    const block = after.slice(0, 1200);
    expect(block).toMatch(/loadLyricsAndMarkers/);
    expect(block).toMatch(/setDisplayLyrics/);
  });
});
