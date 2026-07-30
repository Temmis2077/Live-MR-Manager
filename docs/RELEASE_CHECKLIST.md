# 릴리즈 체크리스트

태그를 밀면 `.github/workflows/release.yml`이 NSIS 설치 파일을 만들어 GitHub
릴리즈에 올립니다(현재 `prerelease: true`). 태그 전에 아래를 확인합니다.

## 1. 버전 맞추기

세 곳이 전부 같아야 합니다.

| 파일 | 키 |
| --- | --- |
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |

```bash
grep -h '"version"' package.json src-tauri/tauri.conf.json && grep '^version' src-tauri/Cargo.toml
```

## 2. 검사

```bash
npm test
cd src-tauri && cargo test --lib
```

## 3. UI 최종 확인

- [ ] 창 최소 크기(1024px)와 1280px에서 가로 스크롤이 없다
- [ ] 기능 없는 버튼이 노출되지 않는다 (녹음 콘솔은 잠긴 상태)
- [ ] 옛 브랜드 문자열(`Live MR Manager`, `Mod`, 옛 버전 번호)이 화면에 없다
- [ ] 멜로밍 관련 UI가 노출되지 않는다

## 4. 첫 실행 경로 (새 PC / 새 사용자 기준)

- [ ] 마이그레이션 안내가 뜨고, 예/아니오 모두 정상 동작
- [ ] 곡 추가 시 ffmpeg·yt-dlp를 자동으로 받고 진행
- [ ] 곡 추가 시 정렬 모델이 없으면 받으라고 안내
- [ ] GPU 팩 다운로드 버튼이 동작 (아래 5번 선행 필요)

## 5. 릴리즈 자산 (수동 업로드)

앱이 하드코딩된 주소에서 받으므로, 태그와 자산이 **미리** 올라가 있어야 합니다.

| 태그 | 자산 | 참조 위치 |
| --- | --- | --- |
| `gpu-pack-v1` | `manifest.json` + 분할 파일 | `src-tauri/src/gpu_pack.rs` |
| `ai-align-model-v1` | `model.onnx`, `tokens.txt` | `src-tauri/src/alignment.rs` |
| `align-model-en-v1` | `model.onnx`, `tokens.txt` | `src-tauri/src/alignment.rs` |

```bash
# 참조된 주소가 실제로 살아 있는지 확인
grep -rn "releases/download" src-tauri/src/*.rs | grep -v yt-dlp
```

> 자산은 전부 `Temmis2077/OSW` 한 레포에 있습니다. 코드의 주소도 이 레포를
> 가리킵니다 — 레포 이름을 또 바꾼다면 GitHub 리다이렉트에 기대지 말고
> 코드의 주소를 함께 고치세요(위 `grep`으로 확인).
>
> 현재 `gpu-pack-v1` 태그는 아직 없습니다. GPU 가속 팩을 쓰려면 이 태그와
> 자산을 먼저 올려야 합니다.

## 6. 문서

- [ ] `RELEASE_NOTES.md`에 이번 버전 항목이 있다
- [ ] 새 서드파티를 추가했다면 `docs/THIRD-PARTY.md`에 적었다
- [ ] README의 기능 설명이 실제 동작과 맞는다

## 7. 태그 밀기

```bash
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

## 8. 릴리즈 후

- [ ] 설치 파일을 **깨끗한 PC**에서 실제로 설치·실행
- [ ] 릴리즈 본문에 `RELEASE_NOTES.md` 내용 반영
- [ ] 정식 릴리즈로 올릴 준비가 되면 `prerelease: true`를 끈다
