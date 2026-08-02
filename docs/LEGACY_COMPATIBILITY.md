# OSW 레거시 호환 기준

OSW가 새 이름과 저장소를 기본으로 사용하더라도 기존 설치의 데이터와 대용량
도구를 잃지 않기 위해 아래 식별자는 제한적으로 유지합니다. 새 UI·문서·릴리즈
링크·생성되는 콜백에는 사용하지 않습니다.

| 레거시 식별자 | 유지 범위 | 새 기본값 |
| --- | --- | --- |
| `live-mr-manager://` | 기존 OAuth 콜백 입력 허용 | `osw://` |
| `%LOCALAPPDATA%\com.autumncolor77.live-mr-manager\` | 첫 실행 데이터 마이그레이션과 진단 스크립트 폴백 | `%LOCALAPPDATA%\com.osw.desktop\` |
| `%LOCALAPPDATA%\LiveMRManager\tools\` | 기존 GPU 팩·모델·FFmpeg를 재다운로드하지 않는 공유 캐시 | 경로 유지 |
| `live-mr-manager-lastfm.boohun2771.workers.dev` | 배포된 Last.fm 프록시 엔드포인트의 호스트명 | 새 엔드포인트가 배포되기 전까지 유지 |
| `lmrm.vercel.app` OAuth API·Redirect URI | 멜로밍에 등록된 OAuth 교환·콜백 계약 | 새 도메인 등록과 실제 OAuth 검증 전까지 기능 엔드포인트만 유지 |
| `AutumnColor77/Live-MR-Manager` | MIT 저작권·파생 출처 고지 | 개발·지원·릴리즈 링크는 `Temmis2077/OSW` |

새 코드에서 레거시 값을 추가할 때는 신규 출력이 아니라 마이그레이션·폴백·법적
고지 중 하나인지 명시해야 합니다. 사용자에게 생성하거나 안내하는 저장소 주소,
딥링크, User-Agent와 제품명은 OSW를 사용합니다.
