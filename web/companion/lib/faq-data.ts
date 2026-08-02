export type FaqItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "what-is-app",
    category: "시작하기",
    question: "OSW는 어떤 앱인가요?",
    answer:
      "방송·연습용 MR을 관리하는 Windows 데스크톱 앱입니다. 유튜브·로컬 음원 재생, AI로 MR 분리, 가사 동기화, OBS 오버레이 등을 한곳에서 다룰 수 있습니다. 음원 파일은 내 PC에서만 처리됩니다.",
  },
  {
    id: "what-is-site",
    category: "시작하기",
    question: "이 웹페이지는 무엇인가요?",
    answer:
      "OSW와 멜로밍 노래책을 함께 쓰는 방법을 안내하는 공식 도움말 페이지입니다. 앱 다운로드 링크, 자주 묻는 질문, 멜로밍 로그인 후 앱으로 돌아오는 연결 화면도 제공합니다.",
  },
  {
    id: "meloming-why",
    category: "멜로밍 노래책",
    question: "멜로밍 노래책과 연동하면 좋은 점은?",
    answer:
      "앱에서 정리한 곡 목록·KEY/BPM·숙련도·난이도 등을 멜로밍 노래책과 맞출 수 있습니다. 연습·방송용 라이브러리와 시청자에게 보이는 노래책을 따로 관리하지 않아도 됩니다.",
  },
  {
    id: "meloming-sync",
    category: "멜로밍 노래책",
    question: "어떤 정보가 동기화되나요?",
    answer:
      "곡 제목, 가수, 썸네일, KEY, BPM, 숙련도·난이도, 카테고리, 가사, 유튜브 링크 같은 곡 정보입니다. MR·녹음 파일 자체는 멜로밍으로 올라가지 않으며, 항상 내 컴퓨터에만 있습니다.",
  },
  {
    id: "channel-id",
    category: "멜로밍 노래책",
    question: "채널 주소를 따로 입력해야 하나요?",
    answer:
      "아니요. 우측 상단 「멜로밍 로그인」만 하면 앱이 계정에 연결된 멜로밍 채널을 자동으로 찾습니다. 가져오기는 로그인 없이도 사용할 수 있고, 보내기는 로그인이 필요합니다.",
  },
  {
    id: "import-songs",
    category: "멜로밍 노래책",
    question: "멜로밍 노래책을 앱으로 가져오려면?",
    answer:
      "앱 **설정 → 멜로밍 노래책 → 가져오기**를 누르세요. 멜로밍 노래책 곡이 앱 라이브러리에 병합·갱신됩니다. 로그인 없이도 사용할 수 있습니다.",
  },
  {
    id: "export-songs",
    category: "멜로밍 노래책",
    question: "앱에 있는 곡을 멜로밍 노래책에 올리려면?",
    answer:
      "우측 상단 **멜로밍 로그인** 후, 앱 **설정 → 멜로밍 노래책 → 보내기**를 사용하세요. 없는 아티스트·카테고리는 보내기 시 자동으로 등록됩니다. KEY/BPM·숙련도·난이도·가사(.lrc)도 함께 전송됩니다.",
  },
  {
    id: "oauth-errors",
    category: "멜로밍 노래책",
    question: "멜로밍 로그인·보내기가 실패할 때",
    answer:
      "「OAuth 설정이 없습니다」가 뜨면 앱을 **최신 버전(v0.5.1+)**으로 업데이트해 주세요. 그 외에는 멜로밍 OAuth 서버에서 500 INTERNAL_ERROR 또는 401 Invalid redirect_uri가 간헐적으로 발생할 수 있습니다. 잠시 후 다시 로그인해 주세요. 지속되면 Discord 또는 GitHub Issues(멜로밍 연동 템플릿)로 문의해 주세요.",
  },
  {
    id: "push-tips",
    category: "멜로밍 노래책",
    question: "보내기(Push)가 일부 곡만 실패할 때",
    answer:
      "아티스트 매칭 실패, 유튜브 메타 부족, 권한(403)·없는 곡(404) 등이 원인일 수 있습니다. 앱 알림에 표시된 건너뜀·오류 메시지를 확인하세요.",
  },
  {
    id: "login-flow",
    category: "멜로밍 노래책",
    question: "멜로밍 로그인 후 이 페이지가 뜨는 이유는?",
    answer:
      "데스크톱 앱에서 「멜로밍 로그인」을 시작하면 브라우저가 이 페이지(/oauth/callback)를 거친 뒤 설치된 OSW 앱으로 돌아갑니다. 웹에서 /login으로 시작한 경우에는 웹 세션으로 처리됩니다.",
  },
  {
    id: "contact",
    category: "문의",
    question: "문의는 어디로 하면 되나요?",
    answer:
      "설치·사용법·연동 질문은 Discord(https://discord.gg/qfJnk3VJyf) 또는 OSW Companion 문의 허브를 이용해 주세요. 재현 가능한 버그는 GitHub Issues 버그 신고 템플릿으로, 멜로밍 연동 문제는 멜로밍 연동 템플릿으로 등록해 주세요. 토큰·Client Secret·전체 로그는 올리지 마세요.",
  },
  {
    id: "contact-privacy",
    category: "문의",
    question: "문의할 때 주의할 점은?",
    answer:
      "OAuth access·refresh token, Client Secret, API Key, 전체 채널 ID·로그 파일은 공개 채널이나 Issues에 올리지 마세요. 버그 신고 시 앱 버전·Windows 버전·재현 단계만 적어도 충분한 경우가 많습니다.",
  },
  {
    id: "proficiency",
    category: "곡 정보",
    question: "숙련도와 난이도란?",
    answer:
      "멜로밍 노래책과 같은 1~5 단계입니다. 숙련도는 내가 그 곡을 얼마나 잘 부르는지, 난이도는 곡 자체가 얼마나 어려운지를 나타냅니다. 앱 곡 정보 편집에서 **별을 클릭**해 설정할 수 있습니다.",
  },
  {
    id: "key-bpm",
    category: "곡 정보",
    question: "KEY와 BPM은 어떻게 넣나요?",
    answer:
      "앱에서 곡 정보를 열고 KEY·BPM을 직접 입력하거나, 「KEY/BPM 분석」으로 자동 추정할 수 있습니다. 멜로밍 노래책과 맞출 때 함께 동기화됩니다.",
  },
  {
    id: "privacy",
    category: "안전·개인정보",
    question: "내 음원이 인터넷으로 올라가나요?",
    answer:
      "아니요. MR 분리·재생에 쓰는 음원 파일은 PC 안에서만 처리됩니다. 멜로밍과 주고받는 것은 곡 이름·링크·가사 같은 텍스트 정보입니다.",
  },
];

export const FAQ_CATEGORIES = [
  "전체",
  ...Array.from(new Set(FAQ_ITEMS.map((item) => item.category))),
];
