import { describe, expect, it, beforeEach, vi } from 'vitest';

// localStorage 목 (jsdom 없이 순수 로직 테스트)
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

import {
  getAlignmentLanguage,
  setAlignmentLanguage,
  findModelForLanguage,
  requiredLanguagesFor,
  missingModelsForLanguage,
  dominantScriptLang,
  mergeDualAlignmentLines,
  ALIGNMENT_LANGUAGES,
} from '../src/js/alignment-model.js';

describe('alignment language selection', () => {
  beforeEach(() => { for (const k in store) delete store[k]; });

  it('defaults to ko and persists valid values', () => {
    expect(getAlignmentLanguage()).toBe('ko');
    setAlignmentLanguage('en');
    expect(getAlignmentLanguage()).toBe('en');
    setAlignmentLanguage('invalid');
    expect(getAlignmentLanguage()).toBe('en'); // 잘못된 값은 무시
  });
});

describe('findModelForLanguage', () => {
  const models = [
    '한국어 가사 정렬 모델|C:\\Users\\x\\models\\wav2vec2-korean-lyrics',
    '영어 가사 정렬 모델|C:\\Users\\x\\models\\wav2vec2-english-lyrics',
  ];

  it('matches the correct model per language by folder id in path', () => {
    expect(findModelForLanguage(models, 'ko')).toBe(models[0]);
    expect(findModelForLanguage(models, 'en')).toBe(models[1]);
  });

  it('returns null when the language model is not installed', () => {
    expect(findModelForLanguage([models[0]], 'en')).toBeNull();
    expect(findModelForLanguage(['사용 가능한 모델 없음|none'], 'ko')).toBeNull();
    expect(findModelForLanguage([], 'ko')).toBeNull();
  });

  it('exposes downloadable ids for both languages', () => {
    expect(ALIGNMENT_LANGUAGES.ko.downloadableId).toBe('wav2vec2-korean-lyrics');
    expect(ALIGNMENT_LANGUAGES.en.downloadableId).toBe('wav2vec2-english-lyrics');
  });

  it('rap (dual) mode has no model of its own and expands to ko+en', () => {
    expect(findModelForLanguage(models, 'rap')).toBeNull();
    expect(requiredLanguagesFor('rap')).toEqual(['ko', 'en']);
    expect(requiredLanguagesFor('ko')).toEqual(['ko']);
    expect(requiredLanguagesFor('en')).toEqual(['en']);
  });

  it('accepts rap as a persistable language', () => {
    setAlignmentLanguage('rap');
    expect(getAlignmentLanguage()).toBe('rap');
  });

  describe('missingModelsForLanguage', () => {
    it('returns empty when the single-language model is installed', () => {
      expect(missingModelsForLanguage(models, 'ko')).toEqual([]);
      expect(missingModelsForLanguage(models, 'en')).toEqual([]);
    });

    it('reports the missing model with its downloadable id', () => {
      const missing = missingModelsForLanguage([models[0]], 'en');
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ lang: 'en', downloadableId: 'wav2vec2-english-lyrics' });
    });

    it('rap requires both ko and en — reports whichever is missing', () => {
      expect(missingModelsForLanguage(models, 'rap')).toEqual([]);
      expect(missingModelsForLanguage([models[1]], 'rap').map((m) => m.lang)).toEqual(['ko']);
      expect(missingModelsForLanguage([], 'rap').map((m) => m.lang)).toEqual(['ko', 'en']);
    });
  });
});

describe('dominantScriptLang', () => {
  it('classifies lines by hangul vs latin letter count', () => {
    expect(dominantScriptLang('난 벨라스케스, 밀레, 엘 fuckin 그레코')).toBe('ko');
    expect(dominantScriptLang("I'm a born hater, Dali, Ban, Picasso")).toBe('en');
    expect(dominantScriptLang('yeah 나쁜 놈들 다 hands up')).toBe('en'); // 라틴 우세
  });

  it('ties and empty text default to ko (safe fallback)', () => {
    expect(dominantScriptLang('')).toBe('ko');
    expect(dominantScriptLang('123 !!')).toBe('ko');
  });
});

describe('mergeDualAlignmentLines (랩/혼합 줄별 병합)', () => {
  it('picks per-line result from the dominant-language model', () => {
    const ko = [
      { text: '난 벨라스케스 밀레', start_ms: 1000, end_ms: 3000 },
      { text: 'I did it my way', start_ms: 3000, end_ms: 5000 }, // ko 모델은 보간값
    ];
    const en = [
      { text: '난 벨라스케스 밀레', start_ms: 900, end_ms: 2800 }, // en 모델은 보간값
      { text: 'I did it my way', start_ms: 4000, end_ms: 6000 },
    ];
    const merged = mergeDualAlignmentLines(ko, en);
    expect(merged[0].start_ms).toBe(1000); // 한국어 줄 → ko 결과
    expect(merged[1].start_ms).toBe(4000); // 영어 줄 → en 결과
  });

  it('repairs monotonicity without stacking lines on one timestamp', () => {
    const ko = [
      { text: '한국어 줄', start_ms: 10000, end_ms: 12000 },
      { text: 'english line', start_ms: 12000, end_ms: 14000 },
    ];
    const en = [
      { text: '한국어 줄', start_ms: 1000, end_ms: 2000 },
      { text: 'english line', start_ms: 8000, end_ms: 9000 }, // ko 줄(10s)보다 앞
    ];
    const merged = mergeDualAlignmentLines(ko, en);
    expect(merged[0].start_ms).toBe(10000);
    // 예전엔 앞 줄과 같은 10000으로 눌렀는데, 그러면 여러 줄이 한 점에 쌓인다.
    // 이제는 앵커 뒤 구간으로 밀어 서로 다른 시각을 갖는다.
    expect(merged[1].start_ms).toBeGreaterThan(merged[0].start_ms);
    expect(merged[1].end_ms).toBeGreaterThanOrEqual(merged[1].start_ms + 200);
  });

  it('드리프트한 소수 언어 패스가 정확한 다수 언어 줄을 끌어당기지 않는다', () => {
    // 실측 사례(멸종위기사랑): 한국어 위주 곡에서 한국어 패스는 오차 0.03~0.5초로
    // 정확했지만, 영어 패스는 뒤로 갈수록 8초 → 16초까지 밀렸다. 예전 병합은
    // 밀린 영어 줄에 뒤따르는 한국어 줄들을 전부 같은 시각으로 눌러 붙였다.
    const koPass = [
      { text: '왔다네 정말로', start_ms: 18480, end_ms: 21000 },
      { text: '아무도 안 믿었던', start_ms: 21060, end_ms: 26000 },
      { text: '사랑의 종말론', start_ms: 26860, end_ms: 29000 },
      // 영어 줄은 한국어 모델이 보간만 한 값
      { text: "It's over tonight", start_ms: 29500, end_ms: 30000 },
      { text: 'God mercy', start_ms: 30000, end_ms: 30500 },
      { text: 'Where the hell', start_ms: 30500, end_ms: 31000 },
      { text: 'Did you hear that', start_ms: 31000, end_ms: 31500 },
      { text: 'You heard that', start_ms: 31500, end_ms: 32000 },
      { text: "What's it sound", start_ms: 32000, end_ms: 32500 },
      { text: 'Back in the day', start_ms: 32500, end_ms: 33000 },
      // 한국어 줄 — 정확
      { text: '한 사람당 하나의', start_ms: 52540, end_ms: 55000 },
      { text: '사랑이 있었대', start_ms: 55450, end_ms: 58000 },
      { text: '내일이면', start_ms: 58260, end_ms: 60000 },
      { text: '인류가 잃어버릴', start_ms: 60770, end_ms: 63000 },
      { text: '멸종위기사랑', start_ms: 63880, end_ms: 66000 },
    ];
    const enPass = koPass.map((l) => ({ ...l }));
    // 영어 패스: 첫 줄은 맞지만 뒤로 갈수록 누적 드리프트
    const drifted = {
      "It's over tonight": 28000,
      'God mercy': 34600,
      'Where the hell': 47360,
      'Did you hear that': 55740,
      'You heard that': 60960,
      "What's it sound": 64100,
      'Back in the day': 66960, // 실제로는 50730이어야 함 — 16초 밀림
    };
    enPass.forEach((l) => {
      if (drifted[l.text] != null) { l.start_ms = drifted[l.text]; l.end_ms = l.start_ms + 1500; }
    });

    const merged = mergeDualAlignmentLines(koPass, enPass);

    // 1) 어떤 두 줄도 같은 시각에 쌓이지 않는다 (예전 실패: 6줄이 01:06.96)
    const starts = merged.map((l) => l.start_ms);
    expect(new Set(starts).size).toBe(starts.length);

    // 2) 시간이 단조 증가한다
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }

    // 3) 정확했던 한국어 줄들은 그대로 유지된다 (드리프트에 끌려가지 않음)
    const byText = Object.fromEntries(merged.map((l) => [l.text, l.start_ms]));
    expect(byText['한 사람당 하나의']).toBe(52540);
    expect(byText['멸종위기사랑']).toBe(63880);
    expect(byText['왔다네 정말로']).toBe(18480);

    // 4) 영어 줄들은 앞뒤 한국어 앵커 사이(사랑의 종말론 ~ 한 사람당 하나의)에 놓인다
    const engTexts = Object.keys(drifted);
    engTexts.forEach((t) => {
      expect(byText[t]).toBeGreaterThan(26860);
      expect(byText[t]).toBeLessThan(52540);
    });
  });

  it('handles length mismatch by falling back to whichever side exists', () => {
    const ko = [{ text: '가', start_ms: 1000, end_ms: 2000 }];
    const en = [];
    const merged = mergeDualAlignmentLines(ko, en);
    expect(merged).toHaveLength(1);
    expect(merged[0].start_ms).toBe(1000);
  });
});
