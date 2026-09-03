# OSW 프론트–백엔드 연결 규칙

## 유일하게 허용되는 경로

```text
UI → src/ipc/services/<domain> → src/generated/ipc.ts
   → Tauri command → src-tauri/src/ipc → application service
```

- UI에서 `invoke`, `listen`, `window.__TAURI__`, `@tauri-apps/api/core`를 새로 사용하지 않는다.
- UI는 생성 바인딩을 직접 import하지 않고 도메인 service만 사용한다.
- `src/ipc/transport.ts`의 `invokeLegacy`는 기존 명령 이전용이며 새 명령에 사용하지 않는다.
- Rust DTO와 command가 원본이다. 생성 파일은 직접 수정하지 않는다.

## 새 command 추가

1. 해당 Rust 도메인의 IPC facade에 command와 DTO를 추가한다.
2. DTO에 `serde`와 `specta::Type`, command에 `tauri::command`와 `specta::specta`를 선언한다.
3. `src-tauri/src/ipc/mod.rs`의 contract builder와 Tauri handler에 한 번씩 등록한다.
4. `npm run generate:ipc`로 TypeScript 바인딩과 카탈로그를 생성한다.
5. 프론트 도메인 service와 같은 인터페이스의 browser mock을 추가한다.
6. UI는 service 메서드만 호출한다.

인자는 camelCase JSON, Rust command 이름은 전역 고유 snake_case를 사용한다.

## Command와 event

- 조회·변경·작업 시작·취소처럼 요청에 성공/실패가 귀속되면 command를 쓴다.
- 재생·분리·정렬·다운로드의 지속 진행과 여러 창 상태 방송만 event를 쓴다.
- 장기 작업 command는 최종적으로 `operationId`를 반환하고 진행 event도 같은 ID를 포함한다.
- 재생 진행 event는 UI 스냅샷이며 오디오 clock의 원본이 아니다.

## 오류

이전이 끝난 command는 `ApiError`를 반환한다.

- `code`: 안정적인 프로그램 분기 키
- `message`: 사용자에게 보일 기본 설명
- `recoverable`: 재시도·장치 재선택 가능 여부
- `details`: 문자열 진단 정보 또는 `null`; 토큰과 비밀 값 금지

이전 중인 문자열 오류는 service의 정규화기를 거치며 UI에서 문자열을 분석하지 않는다.

## Browser mock

- mock은 `src/ipc/mocks/<domain>.ts`에 둔다.
- 실제 service와 동일한 인터페이스와 오류 형태를 구현한다.
- 정상 응답만 만들지 말고 빈 결과·복구 가능한 실패·취소 상태를 테스트할 수 있어야 한다.
- `tauri-bridge.js`의 중앙 switch에는 새 mock을 추가하지 않는다.

## 검사

```powershell
npm run generate:ipc
npm run check:ipc
npm run typecheck
npm test
cd src-tauri
cargo test --lib
```

`check:ipc`는 기존 직접 호출 수가 증가하거나 새로운 파일이 우회 경로를 만들면 실패한다. 도메인 이전 때마다 ceiling을 실제 감소한 값으로 낮춘다.

