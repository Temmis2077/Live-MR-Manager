/**
 * eng-to-kor.js — 영어 가사를 한국어 차음(발음)으로 변환
 *
 * 혼합(랩) 정렬 모드에서 영어 wav2vec2 모델 대신 한국어 모델로
 * 영어 가사를 정렬하기 위한 전처리 단계다. 영어 모델은 한국어 음성의
 * 음향 특징을 제대로 해석하지 못해 emission probability가 망가진다.
 * 대신 영어 텍스트를 한국어 음소로 변환하면 같은 오디오에서
 * 한국어 모델이 훨씬 정확하게 정렬할 수 있다.
 *
 * 변환 파이프라인:
 *   1. 수축형(I'm, don't, it's) → 풀어쓰기
 *   2. 단어 사전 조회 → 알려진 단어는 사전값
 *   3. 사전에 없는 단어 → 음절 단위 규칙 매핑
 *   4. 결과를 공백으로 연결
 */

// ── 수축형 풀어쓰기 ──
const CONTRACTIONS = {
  "i'm": "im",
  "i'll": "i will",
  "i'd": "i would",
  "i've": "i have",
  "you're": "youre",
  "you'll": "you will",
  "you'd": "you would",
  "you've": "you have",
  "he's": "he is",
  "she's": "she is",
  "it's": "its",
  "we're": "we are",
  "we'll": "we will",
  "we've": "we have",
  "they're": "they are",
  "they'll": "they will",
  "they've": "they have",
  "can't": "cant",
  "don't": "do not",
  "won't": "will not",
  "ain't": "am not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "haven't": "have not",
  "hasn't": "has not",
  "hadn't": "had not",
  "couldn't": "could not",
  "wouldn't": "would not",
  "shouldn't": "should not",
  "doesn't": "does not",
  "didn't": "did not",
  "gonna": "going to",
  "wanna": "want to",
  "gotta": "got to",
  "kinda": "kind of",
  "sorta": "sort of",
  "lemme": "let me",
  "gimme": "give me",
  "outta": "out of",
  "'cause": "because",
  "'em": "them",
  "'til": "until",
  "o'clock": "o clock",
};

// ── 단어 사전 (K-pop 가사 고빈도 영어 표현) ──
const WORD_DICT = {
  // 관사/대명사
  "a": "어", "an": "언", "the": "더",
  "im": "아임", "youre": "유어", "cant": "캔트",
  "dont": "돈트", "wont": "원트", "isnt": "이즌트",
  "i": "아이", "me": "미", "my": "마이", "mine": "마인",
  "you": "유", "your": "유어", "yours": "유어스",
  "he": "히", "him": "힘", "his": "히즈",
  "she": "쉬", "her": "허", "hers": "허즈",
  "it": "잇", "its": "잇츠",
  "we": "위", "us": "어스", "our": "아워", "ours": "아워즈",
  "they": "데이", "them": "뎀", "their": "데어", "theirs": "데어즈",
  "this": "디스", "that": "댓", "these": "디즈", "those": "도즈",
  "who": "후", "whom": "훔", "whose": "후즈",
  "what": "왓", "which": "위치", "where": "웨어", "when": "웬",
  "why": "와이", "how": "하우",
  "all": "올", "every": "에브리", "some": "썸", "any": "애니",

  // be 동사
  "am": "앰", "is": "이즈", "are": "아", "was": "워즈", "were": "월",
  "be": "비", "been": "빈", "being": "비잉",
  "will": "윌", "would": "우드", "shall": "쉘", "should": "슈드",
  "can": "캔", "could": "쿠드", "may": "메이", "might": "마이트",
  "must": "머스트", "have": "해브", "has": "해즈", "had": "해드",
  "do": "두", "does": "더즈", "did": "디드", "done": "던",

  // 전치사
  "in": "인", "on": "온", "at": "앳", "to": "투", "for": "포",
  "from": "프롬", "of": "오브", "with": "위드", "without": "위다웃",
  "by": "바이", "into": "인투", "onto": "온투", "upon": "어폰",
  "about": "어바웃", "above": "어버브", "after": "애프터",
  "before": "비포", "between": "비트윈", "under": "언더",
  "over": "오버", "through": "쓰루", "around": "어라운드",

  // 부사
  "not": "낫", "no": "노", "yes": "예스", "now": "나우",
  "then": "덴", "here": "히어", "there": "데어",
  "so": "쏘", "too": "투", "very": "베리", "just": "저스트",
  "still": "스틸", "already": "올레디", "always": "올웨이즈",
  "never": "네버", "ever": "에버", "again": "어겐",
  "only": "온리", "even": "이븐", "also": "올쏘",
  "well": "웰", "forever": "포에버", "together": "투게더",

  // 형용사
  "good": "굿", "bad": "배드", "big": "빅", "small": "스몰",
  "new": "뉴", "old": "올드", "high": "하이", "low": "로우",
  "long": "롱", "short": "숏", "hot": "핫", "cold": "콜드",
  "right": "라이트", "wrong": "롱", "true": "트루", "false": "폴스",
  "happy": "해피", "sad": "새드", "mad": "매드", "crazy": "크레이지",
  "beautiful": "뷰티풀", "pretty": "프리티", "ugly": "어글리",
  "sweet": "스윗", "bitter": "비터", "deep": "딥", "shallow": "쉘로우",
  "dark": "다크", "bright": "브라이트", "cold": "콜드", "warm": "웜",

  // 동사 (기본형 + 과거)
  "go": "고", "went": "웬트", "come": "컴", "came": "케임",
  "get": "겟", "got": "갓", "give": "기브", "gave": "게이브",
  "take": "테이크", "took": "툭", "make": "메이크", "made": "메이드",
  "see": "시", "saw": "쏘", "know": "노우", "knew": "뉴",
  "think": "씽크", "thought": "쏫", "feel": "필", "felt": "펠트",
  "find": "파인드", "found": "파운드", "tell": "텔", "told": "톨드",
  "say": "세이", "said": "세드", "speak": "스피크", "spoke": "스포크",
  "hear": "히어", "heard": "허드", "hold": "홀드", "held": "헬드",
  "let": "렛", "put": "풋", "set": "셋", "run": "런", "ran": "랜",
  "walk": "워크", "talk": "톡", "look": "룩", "live": "리브",
  "love": "러브", "hate": "헤이트", "like": "라이크", "want": "원트",
  "need": "니드", "try": "트라이", "cry": "크라이", "fly": "플라이",
  "die": "다이", "kill": "킬", "save": "세이브", "lose": "루즈",
  "break": "브레이크", "cut": "컷", "fall": "폴", "fell": "펠",
  "rise": "라이즈", "rose": "로즈", "grow": "그로우", "grew": "그루",
  "stay": "스테이", "leave": "리브", "left": "레프트",
  "wait": "웨이트", "stop": "스탑", "start": "스타트",
  "finish": "피니시", "end": "엔드", "begin": "비긴", "began": "비갠",
  "believe": "빌리브", "forget": "포겟", "forgot": "포갓",
  "remember": "리멤버", "forgive": "포기브", "promise": "프라미스",

  // K-pop 영어 가사 초고빈도
  "oh": "오", "yeah": "예", "hey": "헤이", "baby": "베이비",
  "girl": "걸", "boy": "보이", "man": "맨", "lady": "레이디",
  "drowning": "드라우닝", "raining": "레이닝", "taking": "테이킹",
  "waiting": "웨이팅", "making": "메이킹", "going": "고잉",
  "coming": "커밍", "living": "리빙", "loving": "러빙",
  "breath": "브레쓰", "breathe": "브리드",
  "night": "나이트", "day": "데이", "morning": "모닝",
  "tonight": "투나잇", "today": "투데이", "tomorrow": "투모로우",
  "yesterday": "예스터데이",
  "life": "라이프", "lives": "라이브즈",
  "time": "타임", "times": "타임즈",
  "dream": "드림", "dreams": "드림즈",
  "heart": "하트", "hearts": "하츠",
  "love": "러브", "lover": "러버",
  "world": "월드", "fire": "파이어", "water": "워터",
  "heaven": "헤븐", "hell": "헬", "angel": "엔젤", "devil": "데빌",
  "alone": "얼론", "lonely": "론리",
  "sorry": "쏘리", "please": "플리즈",
  "thank": "땡크", "thanks": "땡스",
  "really": "릴리", "ready": "레디",
  "money": "머니", "power": "파워", "party": "파티",
  "dance": "댄스", "music": "뮤직", "song": "송",
  "nobody": "노바디", "nothing": "너띵", "something": "썸띵",
  "everything": "에브리띵", "anything": "애니띵",
  "somebody": "썸바디", "everybody": "에브리바디",
  "anybody": "애니바디", "someone": "썸원", "everyone": "에브리원",
  "back": "백", "down": "다운", "up": "업", "off": "오프",
  "inside": "인사이드", "outside": "아웃사이드",

  // 청크/구절 — 띄어쓰기 복원 시 개별 단어로 분해됨
};

// ── 문자 단위 fallback 매핑 ──
const CHAR_MAP = {
  'a': 'ㅏ', 'b': 'ㅂ', 'c': 'ㅋ', 'd': 'ㄷ', 'e': 'ㅔ',
  'f': 'ㅍ', 'g': 'ㄱ', 'h': 'ㅎ', 'i': 'ㅣ', 'j': 'ㅈ',
  'k': 'ㅋ', 'l': 'ㄹ', 'm': 'ㅁ', 'n': 'ㄴ', 'o': 'ㅗ',
  'p': 'ㅍ', 'q': 'ㅋ', 'r': 'ㄹ', 's': 'ㅅ', 't': 'ㅌ',
  'u': 'ㅜ', 'v': 'ㅂ', 'w': 'ㅝ', 'x': 'ㄱㅅ', 'y': 'ㅇ',
  'z': 'ㅈ',
};

/** 한글 자모를 조합형 음절로 합성 (초성+중성+종성) */
function composeSyllable(cho, jung, jong) {
  const choIdx = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'.indexOf(cho);
  const jungIdx = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.indexOf(jung);
  const jongMap = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
  const jongIdx = jong ? jongMap.indexOf(jong) : 0;
  if (choIdx < 0 || jungIdx < 0 || jongIdx < 0) return cho + jung + (jong || '');
  return String.fromCodePoint(0xac00 + (choIdx * 21 + jungIdx) * 28 + jongIdx);
}

/** 영어 문자열을 대략적인 한글 음절열로 변환 (사전 미등록 단어용). */
function spellOut(raw) {
  const s = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return raw;

  // 자음 / 모음 분리
  const vowels = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
  const jamos = [];
  let i = 0;
  while (i < s.length) {
    // th → ㅆ / ㄸ
    if (s[i] === 't' && s[i + 1] === 'h') { jamos.push(i === 0 || vowels.has(s[i - 1]) ? 'ㄸ' : 'ㅆ'); i += 2; continue; }
    // sh → ㅅ
    if (s[i] === 's' && s[i + 1] === 'h') { jamos.push('ㅅ'); i += 2; continue; }
    // ch → ㅊ
    if (s[i] === 'c' && s[i + 1] === 'h') { jamos.push('ㅊ'); i += 2; continue; }
    // ph → ㅍ
    if (s[i] === 'p' && s[i + 1] === 'h') { jamos.push('ㅍ'); i += 2; continue; }
    // wh → ㅎ
    if (s[i] === 'w' && s[i + 1] === 'h') { jamos.push('ㅎ'); i += 2; continue; }
    // ng → ㅇ (말미)
    jamos.push(CHAR_MAP[s[i]] || s[i]);
    i++;
  }

  // 자모 → 음절 조합 (간단: CV, CVC 규칙 적용)
  const syllables = [];
  i = 0;
  while (i < jamos.length) {
    const c = jamos[i];
    const isVowel = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.includes(c);
    if (isVowel) {
      // 단독 모음 → ㅇ + 모음
      syllables.push(composeSyllable('ㅇ', c, ''));
      i++;
    } else if (i + 1 < jamos.length && 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.includes(jamos[i + 1])) {
      // 자음 + 모음 → 음절
      const cho = c;
      const jung = jamos[i + 1];
      const jong = (i + 2 < jamos.length && !'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.includes(jamos[i + 2])) ? jamos[i + 2] : '';
      syllables.push(composeSyllable(cho, jung, jong));
      i += jong ? 3 : 2;
    } else {
      // 단독 자음 → 그냥 붙임
      syllables.push(c);
      i++;
    }
  }
  return syllables.join('');
}

// ── 공개 API ──

/**
 * 영어 텍스트 한 줄을 한국어 차음으로 변환한다.
 * @param {string} text 변환할 영어 텍스트
 * @returns {string} 한글 차음 문자열
 */
export function engToKorPhonetic(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    // LRC 가사는 스마트 따옴표를 자주 사용하므로 ASCII 축약형 규칙 전에
    // 표준화한다. 그렇지 않으면 I’m → 이ㅁ처럼 자모 조각이 생성된다.
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    // 수축형 풀기
    .split(/\s+/)
    .map((word) => {
      const clean = word.replace(/[^a-z']/g, '');
      const expanded = CONTRACTIONS[clean];
      if (expanded) return expanded;
      if (clean.endsWith("'s")) return clean.slice(0, -2); // 소유격/축약
      if (clean.endsWith("n't")) return clean.slice(0, -3);
      return clean;
    })
    .join(' ')
    // 단어 단위 변환
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => WORD_DICT[word] || spellOut(word))
    .join(' ');
}

/**
 * 전체 가사 줄 배열에서 영어 줄을 찾아 한국어 차음으로 변환한다.
 * 한글 줄은 그대로 둔다.
 * @param {string[]} lines 전체 가사 줄 배열
 * @returns {{ texts: string[], indexMap: Map<number, number> }}
 *   texts: 변환된 텍스트 배열 (인덱스 유지)
 *   indexMap: 변환된 줄의 원문 인덱스 → 변환 여부 매핑
 */
export function convertMixedLyrics(lines) {
  const texts = [];
  const enIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isEnglishLine(line)) {
      texts.push(engToKorPhonetic(line));
      enIndices.push(i);
    } else {
      texts.push(line);
    }
  }
  return { texts, enIndices };
}

/** 한 줄이 영어 위주인지 판별 (라틴 글자 > 한글). */
export function isEnglishLine(text) {
  let latin = 0, hangul = 0;
  for (const c of text || '') {
    const cp = c.codePointAt(0);
    if (cp >= 0xac00 && cp <= 0xd7a3) hangul++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
  }
  return latin > 0 && latin > hangul;
}

function hasLatinLetters(text) {
  return /[A-Za-z]/.test(String(text || ''));
}

function hasHangulLetters(text) {
  return /[\u3131-\u318e\uac00-\ud7a3]/.test(String(text || ''));
}

/** Alias used by the alignment preprocessor. */
export const transliterateEnglish = engToKorPhonetic;

/**
 * Convert only Latin words in a mixed line. Korean text and non-Latin tokens
 * are retained so a line such as "사랑 my love" remains alignable as one cue.
 */
function transliterateMixedLine(text) {
  return String(text || '')
    .split(/(\s+)/)
    .map((part) => /[A-Za-z]/.test(part) ? engToKorPhonetic(part) : part)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether an existing pronunciation was manually supplied/edited.
 * An English triplet is considered generated when it exactly equals the
 * current deterministic conversion of its original line.
 */
export function hasUserEditedPronunciation(segment) {
  if (!segment || typeof segment !== 'object') return false;
  const original = String(segment.original || '').trim();
  const pronunciation = String(segment.pronunciation || '').trim();
  if (!original || !pronunciation || !hasLatinLetters(original)) return false;
  return transliterateMixedLine(original) !== pronunciation;
}

/**
 * Prepare segments and text for the Korean acoustic model. The function is
 * pure: it returns cloned segments and never changes the caller's LRC state.
 * Existing user-edited pronunciations are always preserved.
 */
export function buildAlignmentLyrics(segments) {
  const preparedSegments = (segments || []).map((segment) => {
    const s = { ...segment };
    const source = String(s.original || s.text || '').trim();
    // 한영 혼합 줄도 라틴 부분만 차음해야 한다. 한국어 모델에 영어 원문을
    // 그대로 넣으면 그 줄의 토큰 폭이 0이 되어 이후 경로를 망칠 수 있다.
    if (!source || !hasLatinLetters(source)) return s;

    const existing = String(s.pronunciation || '').trim();
    const pronunciation = existing && hasUserEditedPronunciation(s)
      ? existing
      : transliterateMixedLine(source);
    if (!pronunciation || pronunciation.length < 2) {
      // 원문은 그대로 두고 한국어 패스에서는 제외한다. 영어 모델 폴백은
      // 이 세그먼트 ID를 별도 요청으로 다시 시도할 수 있다.
      return { ...s, _alignmentSkip: true, _fallbackCandidate: isEnglishLine(source) };
    }

    return {
      ...s,
      text: source,
      original: source,
      pronunciation,
      translation: s.translation || '',
      _phoneticGenerated: !(existing && hasUserEditedPronunciation(s)),
      // 순수 영어 줄은 차음 토큰이 한국어 전역 CTC 경로의 토큰 예산을
      // 소비해 인접 한국어 줄을 밀 수 있다. 원문 세그먼트는 유지하되
      // 한국어 1차 입력에서는 빈 줄로 보존하고, 영어 window fallback에서
      // 원문으로 별도 정렬한다. 한영 혼합 줄은 이 경로에서 제외하지 않는다.
      _skipPrimary: isEnglishLine(source) && !hasHangulLetters(source),
    };
  });

  const entries = [];
  const allTexts = [];
  preparedSegments.forEach((segment, segmentIndex) => {
    const text = String(segment.pronunciation || segment.text || '').trim();
    if (!text) return;
    const entry = {
      inputIndex: allTexts.length,
      segmentIndex,
      text,
      isEnglish: isEnglishLine(segment.original || segment.text || ''),
      generated: segment._phoneticGenerated === true,
      fallbackCandidate: segment._fallbackCandidate === true
        || isEnglishLine(segment.original || segment.text || ''),
      skipPrimary: segment._alignmentSkip === true || segment._skipPrimary === true,
    };
    allTexts.push(text);
    entries.push(entry);
  });
  return { allTexts, entries, segments: preparedSegments };
}

/**
 * 차음 변환된 정렬 결과의 영어 줄을 원문으로 되돌린다.
 * 차음 변환된 텍스트를 키로 사용할 수 없으므로, 원문 인덱스 기반으로 매핑한다.
 *
 * @param {object[]} resultLines AI 정렬 결과 lines [{text, start_ms, end_ms}]
 * @param {string[]} originalLines 원본 가사 줄 배열
 * @param {number[]} enIndices 영어 줄의 원본 인덱스 배열
 */
export function restoreEnglishOriginals(resultLines, originalLines, enIndices) {
  const enSet = new Set(enIndices);
  return resultLines.map((line, i) => {
    if (enSet.has(i) && originalLines[i]) {
      return { ...line, text: originalLines[i].trim() };
    }
    return line;
  });
}
