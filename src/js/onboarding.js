/**
 * onboarding.js — 시작 가이드의 내용 한 곳
 *
 * 가이드가 세 군데에 나온다: 빈 라이브러리 화면, ⚙ 메뉴의 「시작 가이드」,
 * 첫 실행 환영 화면. 셋이 각자 문구를 들고 있으면 반드시 갈라지므로
 * (단축키 치트시트를 레지스트리에서 그리는 것과 같은 이유) 여기 하나만 둔다.
 *
 * 여기는 '무엇을 말할지'만 담는다. 실제로 무슨 일이 일어나는지는 action 이름으로
 * 가리키고, 그 이름을 실행하는 것은 ui/onboarding-ui.js가 맡는다 — 그래야
 * 이 파일이 DOM·Tauri 없이 테스트된다.
 */

/** 첫 실행 환영 화면을 봤는지 기록하는 키. */
import { brandIcon } from './brand-icons.js';

const SEEN_KEY = 'onboardingSeenV1';

/**
 * 곡을 라이브러리에 넣는 세 갈래.
 *
 * "어떤 버튼을 누르나"가 아니라 **"지금 무엇을 갖고 있나"** 로 나눴다. 처음 온
 * 사람은 앱의 버튼 이름을 모르지만 자기가 뭘 가졌는지는 안다.
 */
export const ADD_PATHS = [
  {
    id: 'local',
    icon: brandIcon('folder', 'brand'),
    title: '음원 파일이 있어요',
    desc: 'mp3 · wav · flac · m4a를 고르세요. 창 아무 데나 끌어다 놓아도 됩니다.',
    action: 'pick-files',
    cta: '파일 고르기',
  },
  {
    id: 'youtube',
    icon: brandIcon('search', 'brand'),
    title: '유튜브에서 찾을래요',
    desc: '곡명과 가수로 검색하면 영상 후보와 가사 페이지를 함께 찾아 줍니다.',
    action: 'open-add-song',
    cta: '검색해서 추가',
  },
  {
    id: 'csv',
    icon: brandIcon('list', 'brand'),
    title: '목록이 CSV · 엑셀로 있어요',
    // 이 경로가 있는 줄 모르고 한 곡씩 넣는 경우가 많아 가장 자세히 적는다.
    desc: '이미 만들어 둔 셋리스트 표를 통째로 가져옵니다. 「경로」 칸에 유튜브 주소를 넣으면 곡까지 만들어지고, 키·BPM·카테고리·태그도 함께 들어갑니다.',
    action: 'csv-template',
    cta: '양식 받기',
    secondaryAction: 'csv-import',
    secondaryCta: '가져오기',
  },
];

/**
 * 처음 알아두면 좋은 것.
 *
 * 기능 나열이 아니라 **"모르면 당황할 것"** 위주로 골랐다 — 분리가 오래 걸리는
 * 이유, 결과물이 어디 있는지, 막혔을 때 어디를 보는지.
 */
export const BASICS = [
  {
    icon: brandIcon('stems', 'brand'),
    title: 'MR 분리는 이 PC에서 돕니다',
    body: '곡을 보컬과 MR로 나누는 계산을 컴퓨터가 직접 합니다. 어디에도 음원을 올리지 않지만, 그만큼 시간이 걸립니다 — CPU만 쓰면 곡당 수 분에서 수십 분까지 걸릴 수 있습니다.',
  },
  {
    icon: brandIcon('bolt', 'brand'),
    title: 'NVIDIA 그래픽카드가 있다면',
    body: '설정 → AI 엔진에서 GPU 가속 팩을 받으면 분리가 크게 빨라집니다. 없어도 그대로 동작합니다.',
  },
  {
    icon: brandIcon('clock', 'brand'),
    title: '처음 한 번은 준비 시간이 있습니다',
    body: '첫 곡을 추가할 때 필요한 도구와 AI 모델을 자동으로 내려받습니다. 따로 설치하실 것은 없고, 진행 상태는 설정 메뉴의 AI 프로세싱에서 볼 수 있습니다.',
  },
  {
    icon: brandIcon('lyrics', 'brand'),
    title: '가사는 싱크를 맞춰 두면 계속 씁니다',
    body: 'AI가 먼저 맞춰 주고, 어긋난 줄만 손보면 됩니다. 맞춰 둔 가사는 라이브 화면과 OBS 오버레이에 그대로 흘러갑니다.',
  },
  {
    icon: brandIcon('live', 'brand'),
    title: '방송 중에는 라이브 화면',
    body: '키·빠르기·볼륨을 큰 버튼으로 조작하는 리모컨 화면입니다. OBS에 얹을 오버레이 주소도 여기서 바로 복사할 수 있습니다.',
  },
  {
    icon: brandIcon('keys', 'brand'),
    title: '막히면 ? 를 눌러 보세요',
    body: '쓸 수 있는 단축키를 한눈에 보여 줍니다. 문제가 생기면 설정 → 도움말·문의에서 로그 폴더를 열어 첨부해 주세요.',
  },
];

/** 첫 실행 환영 화면을 이미 봤는지. */
export function hasSeenGuide(storage = localStorage) {
  try {
    return storage.getItem(SEEN_KEY) === '1';
  } catch (err) {
    // 저장소를 못 쓰는 상황이면 '봤다'고 쳐서 매번 뜨는 것만은 막는다.
    return true;
  }
}

/** 첫 실행 환영 화면을 봤다고 기록한다. */
export function markGuideSeen(storage = localStorage) {
  try {
    storage.setItem(SEEN_KEY, '1');
  } catch (err) {
    console.error('[Onboarding] 시작 가이드 표시 기록 실패:', err);
  }
}

/**
 * 첫 실행 환영 화면을 띄울지.
 *
 * 아직 안 봤고 **라이브러리가 비어 있을 때만** 띄운다. 이전 버전에서 데이터를
 * 가져온 사람은 곡이 이미 있으므로 환영 화면이 뜰 이유가 없다.
 */
export function shouldShowWelcome({ songCount, storage = localStorage } = {}) {
  return !hasSeenGuide(storage) && (songCount || 0) === 0;
}
