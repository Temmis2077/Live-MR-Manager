/**
 * alignment-model.js — 정렬 언어 ↔ 설치된 모델 매핑 (에디터·배치 공용)
 *
 * `get_model_list`는 설치된 모델을 `display|경로` 문자열로 반환한다. 경로에는
 * 다운로드 시 쓴 모델 id 폴더명(wav2vec2-korean-lyrics / wav2vec2-english-lyrics)이
 * 들어 있으므로, 그 id로 언어에 맞는 모델을 고른다. "첫 번째 무조건" 방식은
 * 두 모델이 다 설치됐을 때 비결정적이라 이 헬퍼로 대체.
 *
 * '랩/혼합(rap)'은 단일 모델이 아니라 한국어+영어 두 모델을 순차로 돌린 뒤
 * 줄마다 우세 언어(한글/라틴 글자 비율) 결과를 채택하는 듀얼 모드다 —
 * 힙합처럼 한 곡에 한국어 줄과 영어 줄이 섞인 가사를 위해.
 */

// 언어 코드 → { modelId(다운로드/폴더 식별용), downloadableId(list_downloadable_alignment_models의 id) }
export const ALIGNMENT_LANGUAGES = {
    ko: { modelFolder: 'wav2vec2-korean-lyrics', downloadableId: 'wav2vec2-korean-lyrics', label: '한국어' },
    en: { modelFolder: 'wav2vec2-english-lyrics', downloadableId: 'wav2vec2-english-lyrics', label: 'English' },
    rap: { label: '랩/혼합 (한+영)' }, // 듀얼 모드 — 자체 모델 없음, ko+en 둘 다 필요
};

const LANG_KEY = 'alignmentLanguage';

export function getAlignmentLanguage() {
    const v = localStorage.getItem(LANG_KEY);
    return ALIGNMENT_LANGUAGES[v] ? v : 'ko';
}

export function setAlignmentLanguage(lang) {
    if (ALIGNMENT_LANGUAGES[lang]) localStorage.setItem(LANG_KEY, lang);
}

/** 이 언어 설정으로 정렬하려면 실제로 필요한 (단일 모델) 언어 목록. */
export function requiredLanguagesFor(lang) {
    return lang === 'rap' ? ['ko', 'en'] : [lang];
}

/** 설치 모델 목록(`get_model_list` 결과)에서, 주어진 언어로 정렬하는 데 필요한데
 *  아직 설치되지 않은 모델들의 다운로드 스펙을 반환한다.
 *  반환: [{ lang, downloadableId, label }] (없으면 빈 배열 = 모두 설치됨). */
export function missingModelsForLanguage(models, lang) {
    const missing = [];
    for (const l of requiredLanguagesFor(lang)) {
        if (!findModelForLanguage(models, l)) {
            const spec = ALIGNMENT_LANGUAGES[l];
            if (spec && spec.downloadableId) {
                missing.push({ lang: l, downloadableId: spec.downloadableId, label: spec.label });
            }
        }
    }
    return missing;
}

/** 설치 모델 목록(`get_model_list` 결과: `display|path` 배열)에서 주어진 언어에
 *  해당하는 항목을 찾아 반환. 없으면 null. (rap 같은 듀얼 모드는 자체 모델이
 *  없으므로 null — requiredLanguagesFor로 풀어서 개별 조회할 것.) */
export function findModelForLanguage(models, lang) {
    const spec = ALIGNMENT_LANGUAGES[lang];
    if (!spec || !spec.modelFolder) return null;
    const usable = (models || []).filter((m) => !m.endsWith('|none'));
    // 경로(| 뒤)에 모델 폴더명이 포함된 항목을 우선 매칭.
    const matched = usable.find((m) => {
        const path = (m.split('|').pop() || '').replace(/\\/g, '/').toLowerCase();
        return path.includes(spec.modelFolder.toLowerCase());
    });
    return matched || null;
}

/** 한 줄 가사의 우세 스크립트 판정: 한글 글자 수 vs 라틴 글자 수.
 *  동률(비어있음 포함)은 'ko' — 한국어 모델도 라틴 단어를 보간 처리하므로
 *  안전한 기본값. */
export function dominantScriptLang(text) {
    let hangul = 0;
    let latin = 0;
    for (const c of text || '') {
        const cp = c.codePointAt(0);
        if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x3131 && cp <= 0x318e)) hangul++;
        else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
    }
    return latin > hangul ? 'en' : 'ko';
}

/**
 * 듀얼(한국어+영어) 정렬 결과를 줄 단위로 병합한다.
 *
 * 두 결과는 같은 가사 입력에서 나오므로 줄 순서·개수가 같다(인덱스 병합).
 * 줄마다 우세 스크립트 언어의 결과를 채택 — 한국어 줄은 한국어 모델이,
 * 영어 줄은 영어 모델이 실제 음향과 정렬한 시각이라 정확하다(반대 모델은
 * 그 줄을 보간만 함). 서로 다른 Viterbi 경로에서 온 시각이 섞이므로 마지막에
 * 시간 단조성을 보정한다(앞줄 시작보다 뒤로 가지 않게 클램프).
 *
 * @param koLines 한국어 모델 결과 lines ({text, start_ms, end_ms})
 * @param enLines 영어 모델 결과 lines
 * @returns 병합된 lines (길이가 다르면 긴 쪽 기준, 없는 쪽은 있는 쪽 사용)
 */
const MIN_GAP_MS = 200;

/** 배치 비중 — 글자가 많은 줄이 더 오래 불린다고 본다. */
function lineWeight(text) {
    return Math.max(1, String(text || '').replace(/\s+/g, '').length);
}

/** lines를 [fromMs, toMs] 구간에 글자 수 비례로 균등 배치한다(제자리 수정). */
function distributeInGap(lines, fromMs, toMs) {
    const span = Math.max(0, toMs - fromMs);
    const total = lines.reduce((s, l) => s + lineWeight(l.text), 0);
    let cursor = fromMs;
    lines.forEach((l) => {
        const share = total > 0 ? (span * lineWeight(l.text)) / total : 0;
        l.start_ms = Math.round(cursor);
        cursor += share;
        l.end_ms = Math.round(Math.max(l.start_ms + MIN_GAP_MS, cursor));
    });
}

/** run이 [fromMs, toMs] 안에 순서대로(최소 간격 확보) 들어가 있는지. */
function runFitsGap(lines, fromMs, toMs) {
    let prev = fromMs;
    for (const l of lines) {
        if (typeof l.start_ms !== 'number') return false;
        if (l.start_ms < prev || l.start_ms > toMs) return false;
        prev = l.start_ms + MIN_GAP_MS;
    }
    return prev <= toMs + MIN_GAP_MS;
}

/**
 * 듀얼(한국어+영어) 정렬 결과를 줄 단위로 병합한다.
 *
 * 두 결과는 같은 가사 입력에서 나오므로 줄 순서·개수가 같다(인덱스 병합).
 * 줄마다 우세 스크립트 언어의 결과를 채택 — 그 줄을 실제 음향과 정렬한 건
 * 해당 언어 모델이고, 반대 모델은 그 줄을 보간만 하기 때문이다.
 *
 * **문제**: 두 패스는 서로 다른 Viterbi 경로라 시간축이 어긋난다. 특히 곡의
 * 소수 언어 쪽 모델은 다른 언어 노래 구간을 지나며 누적 드리프트가 크다
 * (실측: 한국어 위주 곡에서 한국어 줄은 오차 0.03~0.5초인데, 영어 줄은
 * 뒤로 갈수록 8초 → 16초까지 밀림).
 *
 * 예전에는 순서가 뒤집히면 앞 줄 시작 시각으로 클램프했는데, 그러면 밀린 줄
 * 하나가 뒤따르는 정확한 줄들을 전부 자기 시각으로 끌어당겨 **여러 줄이 한 점에
 * 쌓였다**(실측: 6줄이 같은 타임스탬프).
 *
 * 그래서 **줄 수가 많은 쪽 패스를 기준(anchor)으로 삼고**, 소수 언어 줄들은
 * 앵커 사이 구간에 넣는다. 자기 시각이 그 구간에 순서대로 들어맞으면 그대로
 * 두고(정확한 정렬을 버리지 않는다), 구간을 벗어나면 글자 수 비례로 재배치한다.
 *
 * @param koLines 한국어 모델 결과 lines ({text, start_ms, end_ms})
 * @param enLines 영어 모델 결과 lines
 */
export function mergeDualAlignmentLines(koLines, enLines) {
    const ko = Array.isArray(koLines) ? koLines : [];
    const en = Array.isArray(enLines) ? enLines : [];
    const n = Math.max(ko.length, en.length);
    const merged = [];
    for (let i = 0; i < n; i++) {
        const k = ko[i];
        const e = en[i];
        const text = (k && k.text) || (e && e.text) || '';
        const lang = dominantScriptLang(text);
        const pick = (k && e) ? (lang === 'en' ? e : k) : (k || e);
        merged.push({ ...pick, _lang: lang });
    }

    // 기준 패스 = 줄이 더 많은 언어. 앵커가 많을수록 시간축이 안정적이다.
    let koCount = 0;
    merged.forEach((l) => { if (l._lang === 'ko') koCount++; });
    const refLang = koCount >= merged.length - koCount ? 'ko' : 'en';

    // 기준 언어 줄(앵커) 사이의 비기준 줄 묶음을 구간에 맞춰 배치한다.
    const anchorIdx = [];
    merged.forEach((l, i) => {
        if (l._lang === refLang && typeof l.start_ms === 'number') anchorIdx.push(i);
    });

    if (anchorIdx.length > 0) {
        let cursor = 0;
        for (let a = 0; a <= anchorIdx.length; a++) {
            const from = a === 0 ? 0 : anchorIdx[a - 1];
            const to = a === anchorIdx.length ? merged.length : anchorIdx[a];
            const run = merged.slice(a === 0 ? 0 : from + 1, to);
            if (run.length === 0) { cursor = to; continue; }

            const prevAnchor = a === 0 ? null : merged[from];
            const nextAnchor = a === anchorIdx.length ? null : merged[to];
            const gapFrom = prevAnchor
                ? Math.max(prevAnchor.start_ms + MIN_GAP_MS, prevAnchor.end_ms || 0)
                : 0;
            const gapTo = nextAnchor
                ? nextAnchor.start_ms - MIN_GAP_MS
                : Math.max(gapFrom, (run[run.length - 1]?.end_ms) || gapFrom);

            if (gapTo <= gapFrom || !runFitsGap(run, gapFrom, gapTo)) {
                distributeInGap(run, gapFrom, Math.max(gapFrom, gapTo));
            }
            cursor = to;
        }
    }

    // 마지막 안전망: 그래도 남은 역전은 최소 간격을 주며 밀어낸다.
    // (예전처럼 같은 시각으로 눌러 쌓이지 않도록 반드시 MIN_GAP_MS를 더한다.)
    let prevStart = -Infinity;
    merged.forEach((line) => {
        if (typeof line.start_ms !== 'number') return;
        if (line.start_ms < prevStart) line.start_ms = prevStart;
        if (typeof line.end_ms !== 'number' || line.end_ms < line.start_ms + MIN_GAP_MS) {
            line.end_ms = line.start_ms + MIN_GAP_MS;
        }
        prevStart = line.start_ms + MIN_GAP_MS;
    });

    merged.forEach((l) => { delete l._lang; });
    return merged;
}
