import { describe, expect, it } from 'vitest';
import {
  GENRES, CATEGORIES, SUBGENRES, parentGenre, isKnownGenre, genreTree,
  remapClassification, migrateLibraryTaxonomy,
} from '../src/js/taxonomy.js';

describe('taxonomy remapClassification', () => {
  it('maps old lowercase sound genres to Korean', () => {
    expect(remapClassification('rock', []).genre).toBe('락');
    expect(remapClassification('ballad', []).genre).toBe('발라드');
    expect(remapClassification('hiphop', []).genre).toBe('힙합');
    expect(remapClassification('rnb', []).genre).toBe('R&B/소울');
  });

  it('moves scene values out of genre into category', () => {
    const r = remapClassification('kpop', []);
    expect(r.genre).toBe('');
    expect(r.categories).toEqual(['K-POP']);
    expect(remapClassification('jpop', []).categories).toEqual(['J-POP']);
    expect(remapClassification('anime', []).categories).toEqual(['애니메이션']);
  });

  it('maps auto-fetched Korean genres (록, 인디 록, K-팝)', () => {
    expect(remapClassification('록', []).genre).toBe('락');
    expect(remapClassification('인디 록', []).genre).toBe('인디');
    const k = remapClassification('K-팝', []);
    expect(k.categories).toEqual(['K-POP']);
  });

  it('keeps already-standard values unchanged', () => {
    const r = remapClassification('힙합', ['K-POP']);
    expect(r.genre).toBe('힙합');
    expect(r.categories).toEqual(['K-POP']);
    expect(r.changed).toBe(false);
  });

  it('preserves unknown custom values as genre', () => {
    const r = remapClassification('내맘대로장르', []);
    expect(r.genre).toBe('내맘대로장르');
  });

  it('reports changed=true when values are remapped', () => {
    expect(remapClassification('rock', ['kpop']).changed).toBe(true);
    expect(remapClassification('rock', ['kpop'])).toMatchObject({ genre: '락', categories: ['K-POP'] });
  });

  it('migrateLibraryTaxonomy rewrites songs in place and counts changes', () => {
    const lib = [
      { title: 'a', genre: 'rock', categories: ['kpop'] },
      { title: 'b', genre: '힙합', categories: ['K-POP'] }, // already standard
      { title: 'c', genre: '록', curationCategory: '애니' },
    ];
    const n = migrateLibraryTaxonomy(lib);
    expect(n).toBe(2);
    expect(lib[0]).toMatchObject({ genre: '락', categories: ['K-POP'], curationCategory: 'K-POP' });
    expect(lib[1].genre).toBe('힙합');
    expect(lib[2]).toMatchObject({ genre: '락', categories: ['애니메이션'] });
  });

  it('taxonomy lists are non-empty and use Korean labels', () => {
    expect(GENRES).toContain('락');
    expect(GENRES).toContain('인디');
    expect(CATEGORIES).toContain('K-POP');
    expect(CATEGORIES).not.toContain('락');
  });
});

describe('taxonomy 서브장르 (2단 분류)', () => {
  it('서브장르에서 대장르를 되짚는다', () => {
    expect(parentGenre('락발라드')).toBe('락');
    expect(parentGenre('펑크(Punk)')).toBe('락');
    expect(parentGenre('시티팝')).toBe('팝');
    expect(parentGenre('신스팝')).toBe('팝');
    expect(parentGenre('펑크(Funk)')).toBe('R&B/소울');
  });

  it('대장르는 자기 자신이 부모이고, 모르는 값은 빈 문자열', () => {
    expect(parentGenre('락')).toBe('락');
    expect(parentGenre('내맘대로장르')).toBe('');
    expect(parentGenre('')).toBe('');
  });

  it('서브장르도 표준 장르로 인정한다', () => {
    expect(isKnownGenre('락발라드')).toBe(true);
    expect(isKnownGenre('락')).toBe(true);
    expect(isKnownGenre('없는장르')).toBe(false);
  });

  it('genreTree는 모든 대장르를 담고 서브장르를 붙인다', () => {
    const tree = genreTree();
    expect(tree).toHaveLength(GENRES.length);
    expect(tree.find((t) => t.genre === '락').subgenres).toEqual(SUBGENRES['락']);
    expect(tree.find((t) => t.genre === '발라드').subgenres).toEqual([]);
  });

  it('모든 서브장르의 부모는 실제 대장르다', () => {
    for (const [parent, subs] of Object.entries(SUBGENRES)) {
      expect(GENRES).toContain(parent);
      for (const s of subs) expect(parentGenre(s)).toBe(parent);
    }
  });
});

describe('taxonomy 실데이터에 남아 있던 비표준 값 (2026-07 점검)', () => {
  it('락발라드·시티팝·신스팝을 서브장르로 옮긴다', () => {
    expect(remapClassification('락발라드', []).genre).toBe('락발라드');
    expect(remapClassification('시티팝', []).genre).toBe('시티팝');
    expect(remapClassification('신스팝', []).genre).toBe('신스팝');
  });

  it('사운드트랙은 장르가 아니라 카테고리 OST로 간다', () => {
    const r = remapClassification('사운드트랙', []);
    expect(r.genre).toBe('');
    expect(r.categories).toEqual(['OST']);
  });

  it('맨 펑크는 뜻이 갈려 Punk로 못박는다', () => {
    expect(GENRES).not.toContain('펑크');
    expect(remapClassification('펑크', []).genre).toBe('펑크(Punk)');
    expect(remapClassification('funk', []).genre).toBe('펑크(Funk)');
  });

  it("카테고리 '기본'은 분류 정보가 아니라 버린다", () => {
    const r = remapClassification('락', ['기본']);
    expect(r.genre).toBe('락');
    expect(r.categories).toEqual([]);
  });

  it("카테고리 '민요'는 국악/전통으로 흡수한다", () => {
    expect(remapClassification('', ['민요']).categories).toEqual(['국악/전통']);
  });

  it('락발라드가 카테고리 자리에 있어도 장르로 되돌린다', () => {
    const r = remapClassification('', ['락발라드']);
    expect(r.genre).toBe('락발라드');
    expect(r.categories).toEqual([]);
  });
});
