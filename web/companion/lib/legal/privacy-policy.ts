export const PRIVACY_EFFECTIVE_DATE = "2026년 6월 27일";

export const GITHUB_ISSUES_URL =
  "https://github.com/Temmis2077/Live-MR-Manager-Mod/issues";

export const QA_URL = "https://lmrm.vercel.app/qa";

export type LegalTable = {
  headers: string[];
  rows: string[][];
};

export type LegalSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  list?: string[];
  table?: LegalTable;
  note?: string;
};

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    id: "intro",
    title: "1. 총칙",
    paragraphs: [
      "OSW(이하 「서비스」)는 Windows 데스크톱 앱과 Companion 웹사이트(lmrm.vercel.app)를 통해 방송·연습용 MR 관리 및 멜로밍 노래책 연동 안내를 제공합니다.",
      "본 개인정보 처리방침은 서비스 이용 과정에서 처리되는 정보의 범위, 목적, 보유 기간 등을 설명합니다.",
      "개인정보 처리자: 개인 개발자 AutumnColor77",
      `시행일: ${PRIVACY_EFFECTIVE_DATE}`,
      `일반 문의·커뮤니티: 문의 허브(${QA_URL}) 및 Discord(해당 페이지 안내). Discord 대화는 운영 목적으로 확인될 수 있으니 토큰·비밀번호 등 민감 정보는 올리지 마세요.`,
      `개인정보·공식 버그 신고: GitHub Issues (${GITHUB_ISSUES_URL})`,
    ],
  },
  {
    id: "items",
    title: "2. 처리하는 개인정보 항목",
    paragraphs: [
      "서비스는 별도의 회원가입을 운영하지 않습니다. 멜로밍 계정 연동·기능 사용 여부에 따라 아래 정보가 처리될 수 있습니다.",
      "OSW는 MR 분리·재생에 사용하는 음원 파일을 서버에 업로드하지 않습니다. 멜로밍과 주고받는 정보는 곡 제목·아티스트·URL·가사 텍스트·숙련도·난이도 등 노래책(신청곡) 메타데이터에 한합니다.",
    ],
    list: [
      "멜로밍 OAuth 연동 시: 사용자 식별자, 닉네임, 프로필 이미지 URL, OAuth access·refresh token",
      "멜로밍 채널·노래책 연동 시: 채널 ID·이름·연결 주소(치지직·SOOP·씨미 등), 노래책 메타(제목·아티스트·KEY/BPM·숙련도·난이도·카테고리·가사·URL 등)",
      "Companion 웹 접속 시: IP 주소, User-Agent 등 접속 로그(Vercel 호스팅 기본 로그)",
      "데스크톱 앱 — 메타데이터 검색 기능 사용 시: 곡·아티스트 검색어(Last.fm API, 운영자 Cloudflare Workers 경유)",
      "데스크톱 앱 — 업데이트 확인 시: 앱 버전 정보(GitHub Releases 조회)",
      "로컬 전용(외부 미전송): 음원 파일, AI MR 분리 결과, OBS 오버레이용 재생 정보(동일 PC·LAN 내)",
    ],
    note: "방송 스케줄(schedule:read) 권한은 요청하지 않으며, 스케줄 정보를 수집·이용하지 않습니다. UI용 프로필(닉네임·이미지 URL)은 별도 회원 DB에 영구 저장하지 않고, 표시·API 호출 시 멜로밍으로부터 조회합니다.",
  },
  {
    id: "oauth-scopes",
    title: "3. 멜로밍 OAuth 동의 범위",
    paragraphs: [
      "멜로밍 로그인 시 동의 화면에 표시되는 권한 범위 내에서만 정보를 이용합니다.",
    ],
    table: {
      headers: ["Scope", "설명", "이용 목적"],
      rows: [
        [
          "profile:read",
          "닉네임, 프로필 이미지 확인",
          "로그인 상태·계정 UI 표시",
        ],
        [
          "channels:read",
          "소유 채널 정보 확인",
          "채널 연결·가져오기(Pull) 대상 확인",
        ],
        [
          "songbook:read",
          "채널 신청곡(노래책) 목록 확인",
          "노래책 가져오기",
        ],
        [
          "songbook:write",
          "채널 신청곡 추가·수정",
          "노래책 보내기(Push)",
        ],
        [
          "schedule:read",
          "방송 스케줄 확인",
          "요청하지 않음(미수집)",
        ],
      ],
    },
    note: "멜로밍 계정·프로필의 원천 데이터 처리에 관한 사항은 멜로밍(meloming.com) 정책을 따릅니다.",
  },
  {
    id: "purpose",
    title: "4. 개인정보의 처리 목적",
    list: [
      "멜로밍 OAuth 로그인·토큰 관리 및 연동 API 호출",
      "계정·채널·노래책 연동 UI 제공",
      "Companion 웹 FAQ·다운로드·OAuth 콜백 브릿지 제공",
      "데스크톱 앱 업데이트 안내(GitHub Releases)",
      "곡 메타데이터 검색 보조(Last.fm — 기능 사용 시에만)",
      "서비스 안정성·보안(접속 로그 등)",
    ],
  },
  {
    id: "retention",
    title: "5. 보유 및 이용 기간",
    list: [
      "OAuth PKCE 쿠키(웹): 최대 10분, 로그인 완료 또는 만료 시 삭제",
      "OAuth 세션 쿠키(웹): 최대 7일, 로그아웃·만료 시 삭제",
      "OAuth 토큰·채널 설정(앱): 사용자가 로그아웃·삭제하거나 앱을 제거할 때까지 로컬 PC에 저장(%LOCALAPPDATA%\\com.autumncolor77.live-mr-manager\\)",
      "동기화된 곡 메타(앱): 로컬 SQLite(library.db)에 저장, 사용자가 삭제·앱 제거 시까지",
      "Companion 웹 접속 로그: Vercel 호스팅 정책에 따름(별도 회원 DB 미저장)",
    ],
  },
  {
    id: "third-party",
    title: "6. 제3자 제공 및 처리 위탁",
    paragraphs: [
      "멜로밍 연동: OAuth 동의 범위 내에서 멜로밍 OpenAPI를 호출합니다. 노래책 메타·프로필 조회·전송은 연동 기능 사용 시에 한합니다.",
      "Last.fm: 데스크톱 앱에서 메타데이터 검색 기능을 사용할 때, 운영자가 운영하는 Cloudflare Workers를 경유하여 Last.fm API에 곡·아티스트 검색어가 전송됩니다. 해당 기능을 사용하지 않으면 Last.fm으로 데이터가 전송되지 않습니다.",
    ],
    table: {
      headers: ["수탁·연동 대상", "목적", "전송·처리 항목"],
      rows: [
        [
          "멜로밍(openapi.meloming.com)",
          "OAuth·노래책 연동",
          "동의 scope 범위 내 프로필·채널·노래책 메타·토큰",
        ],
        ["Vercel", "Companion 웹 호스팅", "접속 로그, OAuth 중계"],
        [
          "Cloudflare(Workers)",
          "Last.fm API 중계",
          "곡·아티스트 검색어(기능 사용 시)",
        ],
        ["Last.fm", "음악 메타 조회", "곡·아티스트 검색어(기능 사용 시)"],
        ["GitHub", "릴리즈·업데이트 정보", "앱 버전 조회"],
        [
          "HuggingFace",
          "AI 모델 다운로드",
          "모델 파일 요청(개인 식별 정보 없음)",
        ],
      ],
    },
  },
  {
    id: "overseas",
    title: "7. 개인정보의 국외 이전",
    paragraphs: [
      "Vercel, Cloudflare, GitHub, HuggingFace, Last.fm 등 해외에 서버를 둔 서비스를 이용할 수 있습니다. 각 서비스의 정책에 따라 정보가 해당 국가에서 처리될 수 있습니다.",
    ],
  },
  {
    id: "rights",
    title: "8. 정보주체의 권리",
    paragraphs: [
      "개인정보 열람·정정·삭제·처리 정지 등을 요청하실 수 있습니다. GitHub Issues로 문의해 주세요.",
      "멜로밍 연동 해제: 데스크톱 앱에서 「멜로밍 로그아웃」, Companion 웹에서 로그아웃을 사용할 수 있습니다.",
      "로컬 데이터 삭제: Windows에서 %LOCALAPPDATA%\\com.autumncolor77.live-mr-manager\\ 폴더를 삭제하면 앱 로컬 데이터(라이브러리·토큰·캐시 등)가 제거됩니다.",
    ],
  },
  {
    id: "cookies",
    title: "9. 쿠키 및 유사 기술(Companion 웹)",
    paragraphs: [
      "Companion 웹은 멜로밍 OAuth 중계·웹 로그인을 위해 httpOnly 쿠키를 사용합니다. 마케팅·행동 분석용 쿠키는 사용하지 않습니다. 쿠키 거부 시 웹 로그인 기능을 이용할 수 없습니다.",
    ],
    table: {
      headers: ["쿠키 이름", "용도", "보유 기간"],
      rows: [
        ["lmrm_oauth_state", "OAuth CSRF 방지(state)", "최대 10분"],
        ["lmrm_oauth_verifier", "PKCE code_verifier", "최대 10분"],
        ["lmrm_oauth_redirect_uri", "OAuth redirect URI", "최대 10분"],
        ["lmrm_access_token", "멜로밍 access token", "최대 7일"],
        ["lmrm_refresh_token", "멜로밍 refresh token", "최대 7일"],
        ["lmrm_expires_at", "토큰 만료 시각", "최대 7일"],
      ],
    },
  },
  {
    id: "security",
    title: "10. 개인정보의 안전성 확보 조치",
    list: [
      "OAuth client secret은 Companion 서버 환경 변수에만 보관(프론트엔드·앱 바이너리 미포함)",
      "웹 세션 쿠키 httpOnly·HTTPS(production) 적용",
      "음원·MR 분리 결과는 사용자 PC 로컬에서만 처리",
      "멜로밍 OAuth 토큰은 데스크톱 앱 로컬 SQLite에 저장(프론트 JS 미노출)",
    ],
  },
  {
    id: "children",
    title: "11. 아동의 개인정보",
    paragraphs: [
      "서비스는 만 14세 미만 아동을 대상으로 하지 않습니다. 만 14세 미만 아동의 개인정보가 처리된 사실을 알게 된 경우, 지체 없이 삭제 등 필요한 조치를 하겠습니다.",
    ],
  },
  {
    id: "changes",
    title: "12. 개인정보 처리방침 변경",
    paragraphs: [
      "본 방침을 변경하는 경우 Companion 웹에 게시하고 시행일을 명시합니다. 중요한 변경은 페이지 상단 또는 공지를 통해 안내할 수 있습니다.",
      "서비스 이용 조건은 [이용약관](/terms)을 참고해 주세요.",
    ],
  },
];
