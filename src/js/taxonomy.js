/**
 * taxonomy.js — 장르/카테고리 단일 소스 (곡 추가·편집·필터 공용)
 *
 * 기준 (docs/GENRE_CATEGORY_STANDARD.md):
 *  - 장르(Genre)    = 음악 스타일/사운드. "무엇처럼 들리는가". 예: 락, 힙합, 댄스.
 *  - 카테고리(Category) = 씬/시장/출신. "어디 음악인가". 예: K-POP, J-POP, 애니.
 * 저장 값 = 표시 라벨(한국어)로 통일한다(예전엔 소문자 키 kpop/ballad와
 * 자동수집 한국어 록/K-팝이 섞여 있었다). 예전 값은 remapClassification이
 * 새 기준으로 옮긴다.
 */

// 장르 — 음악 스타일. 저장 값 === 표시 라벨.
// '펑크'는 뺐다 — Punk와 Funk가 같은 한글이라 어느 쪽인지 알 수 없었다.
// 각각 서브장르 '펑크(Punk)'(락), '펑크(Funk)'(R&B/소울)로 나눈다.
export const GENRES = [
    '발라드', '댄스', '팝', '락', '메탈', '힙합', 'R&B/소울', '인디',
    '재즈', 'EDM', '포크/어쿠스틱', '클래식', '트로트', 'CCM', '기타',
];

// 카테고리 — 씬/시장/출신.
export const CATEGORIES = [
    'K-POP', 'J-POP', 'POP(해외)', '애니메이션', '보컬로이드', '게임',
    'OST', '뮤지컬', '국악/전통', '라이브/커버', '기타',
];

/**
 * 서브장르 — 대장르 아래의 세부 분류. 저장은 장르 필드 하나에 가장 구체적인
 * 값을 넣고(예: '락발라드'), 대장르는 parentGenre()로 되짚는다. 컬럼을 새로
 * 만들지 않아 스키마 변경 없이 2단 분류가 된다.
 *
 * 실제 라이브러리에 있는 값만 넣는다 — 쓰지 않는 칸을 만들어 두지 않는다.
 * '펑크'는 Punk와 Funk가 같은 한글이라 뜻이 갈린다. 라이브러리의 펑크 곡이
 * 레이지본·크라잉넛(펑크록)이어서 맨 '펑크'는 Punk로 옮긴다.
 */
export const SUBGENRES = {
    '락': ['락발라드', '펑크(Punk)'],
    '팝': ['시티팝', '신스팝'],
    'R&B/소울': ['펑크(Funk)'],
};

const SUB_TO_PARENT = new Map();
for (const [parent, subs] of Object.entries(SUBGENRES)) {
    for (const s of subs) SUB_TO_PARENT.set(s, parent);
}

const GENRE_SET = new Set(GENRES);
const CATEGORY_SET = new Set(CATEGORIES);
const SUBGENRE_SET = new Set(SUB_TO_PARENT.keys());

/** 장르 값이 표준(대장르 또는 서브장르)인지. */
export function isKnownGenre(value) {
    const v = String(value || '').trim();
    return GENRE_SET.has(v) || SUBGENRE_SET.has(v);
}

/** 어떤 장르 값의 대장르. 대장르면 자기 자신, 모르는 값이면 빈 문자열. */
export function parentGenre(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (SUB_TO_PARENT.has(v)) return SUB_TO_PARENT.get(v);
    if (GENRE_SET.has(v)) return v;
    return '';
}

/** 목록·필터에 쓸 트리 — [{ genre, subgenres: [] }]. */
export function genreTree() {
    return GENRES.map((g) => ({ genre: g, subgenres: SUBGENRES[g] ? [...SUBGENRES[g]] : [] }));
}

// 예전 값(소문자 키 / 자동수집 한국어) → 새 기준. `genre` 또는 `category`로
// 옮긴다(예전 장르에 kpop 같은 '씬' 값이 들어 있던 것을 카테고리로 이동).
const REMAP = {
    // 예전 소문자 장르 키 → 사운드 장르
    ballad: { genre: '발라드' }, dance: { genre: '댄스' }, pop: { genre: '팝' },
    rock: { genre: '락' }, metal: { genre: '메탈' }, hiphop: { genre: '힙합' },
    rnb: { genre: 'R&B/소울' }, 'r&b': { genre: 'R&B/소울' }, soul: { genre: 'R&B/소울' },
    indie: { genre: '인디' }, jazz: { genre: '재즈' }, edm: { genre: 'EDM' },
    electronic: { genre: 'EDM' }, folk: { genre: '포크/어쿠스틱' }, acoustic: { genre: '포크/어쿠스틱' },
    classical: { genre: '클래식' }, trot: { genre: '트로트' },
    punk: { genre: '펑크(Punk)' }, funk: { genre: '펑크(Funk)' },
    ccm: { genre: 'CCM' }, etc: { genre: '기타' },
    // 예전 소문자 값이지만 사실은 '씬' → 카테고리로 이동
    kpop: { category: 'K-POP' }, jpop: { category: 'J-POP' }, anime: { category: '애니메이션' },
    vocaloid: { category: '보컬로이드' }, ost: { category: 'OST' }, game: { category: '게임' },
    musical: { category: '뮤지컬' },
    // 자동수집 한국어 장르명 → 매핑
    '록': { genre: '락' }, '팝 록': { genre: '락' }, '얼터너티브 록': { genre: '락' },
    '하드 록': { genre: '락' }, '메탈': { genre: '메탈' }, '헤비메탈': { genre: '메탈' },
    '힙합': { genre: '힙합' }, '랩': { genre: '힙합' }, '알앤비': { genre: 'R&B/소울' },
    '알앤비/소울': { genre: 'R&B/소울' }, '소울': { genre: 'R&B/소울' },
    '인디 록': { genre: '인디' }, '인디': { genre: '인디' }, '인디팝': { genre: '인디' },
    '재즈': { genre: '재즈' }, '클래식': { genre: '클래식' }, '클래식 음악': { genre: '클래식' },
    '트로트': { genre: '트로트' }, '발라드': { genre: '발라드' }, '댄스': { genre: '댄스' },
    '팝': { genre: '팝' }, '일렉트로닉': { genre: 'EDM' }, '일렉트로니카': { genre: 'EDM' },
    '어쿠스틱': { genre: '포크/어쿠스틱' }, '포크': { genre: '포크/어쿠스틱' },
    // 라이브러리의 '펑크' 곡이 레이지본·크라잉넛(펑크록)이라 Punk로 본다.
    '펑크': { genre: '펑크(Punk)' }, '펑크록': { genre: '펑크(Punk)' }, '훵크': { genre: '펑크(Funk)' },
    // 자동수집/자유입력 카테고리성 한국어 → 카테고리
    'k-팝': { category: 'K-POP' }, '케이팝': { category: 'K-POP' },
    'j-팝': { category: 'J-POP' }, '제이팝': { category: 'J-POP' },
    '애니': { category: '애니메이션' }, '애니메이션': { category: '애니메이션' },
    '애니송': { category: '애니메이션' }, '보컬로이드': { category: '보컬로이드' },
    '게임': { category: '게임' }, 'ost': { category: 'OST' }, '오에스티': { category: 'OST' },
    '뮤지컬': { category: '뮤지컬' }, '국악': { category: '국악/전통' }, '전통': { category: '국악/전통' },
    // 실제 라이브러리에 남아 있던 비표준 값들(2026-07 점검).
    // 이것들이 REMAP에 없어서 classifyOne이 '커스텀'으로 보존했고,
    // 그래서 장르 목록에 락발라드·시티팝·신스팝·사운드트랙이 떠돌았다.
    '락발라드': { genre: '락발라드' },   // 락의 서브장르로 승격
    '록발라드': { genre: '락발라드' },
    '시티팝': { genre: '시티팝' },       // 팝의 서브장르
    '씨티팝': { genre: '시티팝' },
    '신스팝': { genre: '신스팝' },       // 팝의 서브장르
    '신디팝': { genre: '신스팝' },
    '사운드트랙': { category: 'OST' },   // 사운드는 곡마다 달라 '씬'인 OST로
    'soundtrack': { category: 'OST' },
    '민요': { category: '국악/전통' },
    '가요': { genre: '발라드' },
    // '기본'은 예전 기본 보관함 이름이다 — 분류 정보가 아니라서 버린다.
    '기본': {},
    'default': {},
    'unknown': {},
    '미분류': {},
};

/** 한 값을 새 기준으로 해석 — { genre?, category? }. 이미 표준이면 그대로,
 *  매핑에 없으면(사용자 커스텀) 원본을 그대로 장르로 취급. */
function classifyOne(raw) {
    const v = String(raw || '').trim();
    if (!v) return {};
    if (GENRE_SET.has(v) || SUBGENRE_SET.has(v)) return { genre: v };
    if (CATEGORY_SET.has(v)) return { category: v };
    const hit = REMAP[v.toLowerCase()] || REMAP[v];
    if (hit) return { ...hit };
    return { genre: v, custom: true }; // 모르는 값 — 장르 자리에 그대로 보존
}

/**
 * 곡의 예전 장르/카테고리 값을 새 기준으로 재매핑.
 * @returns { genre: string, categories: string[], changed: boolean }
 */
export function remapClassification(oldGenre, oldCategories) {
    let genre = '';
    const cats = [];
    const pushCat = (c) => { if (c && !cats.includes(c)) cats.push(c); };

    // 장르 필드 해석
    const g = classifyOne(oldGenre);
    if (g.genre) genre = g.genre;
    else if (g.category) pushCat(g.category); // 예전 장르에 씬 값이 있었음

    // 카테고리 필드(들) 해석
    (Array.isArray(oldCategories) ? oldCategories : [oldCategories]).forEach((c) => {
        const r = classifyOne(c);
        if (r.category) pushCat(r.category);
        else if (r.genre && !r.custom && !genre) genre = r.genre; // 씬 자리에 사운드가 있었고 장르가 비었으면 채움
        else if (r.genre && r.custom) pushCat(c); // 모르는 값은 카테고리로 보존
    });

    const origCats = (Array.isArray(oldCategories) ? oldCategories : []).map((x) => String(x || '').trim()).filter(Boolean);
    const changed = genre !== String(oldGenre || '').trim()
        || cats.length !== origCats.length
        || cats.some((c, i) => c !== origCats[i]);
    return { genre, categories: cats, changed };
}

/**
 * 라이브러리 전체를 새 기준으로 일괄 재매핑(인메모리). 바뀐 곡 수를 반환하며,
 * 각 곡의 genre/categories/curationCategory를 갱신한다. 저장은 호출부 담당.
 */
export function migrateLibraryTaxonomy(library) {
    if (!Array.isArray(library)) return 0;
    let count = 0;
    library.forEach((song) => {
        if (!song) return;
        const cats = song.categories || (song.curationCategory ? [song.curationCategory] : []);
        const { genre, categories, changed } = remapClassification(song.genre, cats);
        if (!changed) return;
        song.genre = genre || undefined;
        song.categories = categories;
        song.curationCategory = categories[0] || null;
        song.curation_category = song.curationCategory;
        count++;
    });
    return count;
}
