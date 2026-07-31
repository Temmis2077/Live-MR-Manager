/**
 * alignment-model.js — 정렬 언어 ↔ 설치된 모델 매핑 (에디터·배치 공용)
 *
 * 한영 혼합 가사는 `en-ko` 경로가 처리한다. 영어 줄은 한국어 1차 패스에서
 * 제외한 뒤, 필요한 줄만 시간 창 안에서 영어 모델로 재시도한다.
 */

// 언어 코드 → 다운로드/설치 모델 식별자
export const ALIGNMENT_LANGUAGES = {
    ko: { modelFolder: 'wav2vec2-korean-lyrics', downloadableId: 'wav2vec2-korean-lyrics', label: '한국어' },
    en: { modelFolder: 'wav2vec2-english-lyrics', downloadableId: 'wav2vec2-english-lyrics', label: 'English' },
    'en-ko': { modelFolder: 'wav2vec2-korean-lyrics', downloadableId: 'wav2vec2-korean-lyrics', label: '영어 차음 + 한국어 모델' },
};

const LANG_KEY = 'alignmentLanguage';

export function getAlignmentLanguage() {
    const value = localStorage.getItem(LANG_KEY);
    // 이전 버전의 랩/혼합 설정은 혼합 가사 기본 경로로 안전하게 이관한다.
    if (value === 'rap') return 'en-ko';
    return ALIGNMENT_LANGUAGES[value] ? value : 'en-ko';
}

export function setAlignmentLanguage(language) {
    if (ALIGNMENT_LANGUAGES[language]) localStorage.setItem(LANG_KEY, language);
}

/** 이 언어 설정으로 정렬하려면 실제로 필요한 단일 모델 언어 목록. */
export function requiredLanguagesFor(language) {
    return [language === 'en-ko' ? 'ko' : language];
}

/** 설치 모델 목록에서 필요한 모델이 없을 때 다운로드 스펙을 반환한다. */
export function missingModelsForLanguage(models, language) {
    return requiredLanguagesFor(language)
        .filter((lang) => !findModelForLanguage(models, lang))
        .map((lang) => {
            const spec = ALIGNMENT_LANGUAGES[lang];
            return spec && spec.downloadableId
                ? { lang, downloadableId: spec.downloadableId, label: spec.label }
                : null;
        })
        .filter(Boolean);
}

/** 설치 모델 목록(`display|path`)에서 해당 언어의 모델을 찾는다. */
export function findModelForLanguage(models, language) {
    const spec = ALIGNMENT_LANGUAGES[language];
    if (!spec || !spec.modelFolder) return null;
    const usable = (models || []).filter((model) => !model.endsWith('|none'));
    return usable.find((model) => {
        const path = (model.split('|').pop() || '').replace(/\\/g, '/').toLowerCase();
        return path.includes(spec.modelFolder.toLowerCase());
    }) || null;
}
