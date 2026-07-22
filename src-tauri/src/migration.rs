//! 구 식별자(com.autumncolor77.live-mr-manager)의 사용자 데이터를 새 식별자
//! (com.osw.desktop)로 가져온다.
//!
//! 배경: OSW로 독립하며 Tauri 식별자를 바꿨다. 앱 데이터 루트(라이브러리 DB·
//! 모델·분리 결과 캐시)는 식별자 경로(`%LOCALAPPDATA%\<식별자>\`) 아래에 있으므로,
//! 식별자를 바꾸면 새 위치에서 빈 상태로 시작한다. 그래서 **첫 실행 시** 구
//! 데이터를 감지해 사용자에게 가져올지 물어보고, 예이면 새 위치로 옮긴다.
//!
//! 반드시 `AppPaths::from_handle`(새 하위 폴더 생성)와 DB 최초 오픈보다 **먼저**
//! 실행해야 한다 — 그래야 이름 충돌·파일 잠금이 없다. 같은 볼륨이라 rename으로
//! 즉시 옮기고(대용량 분리 캐시도 프리징 없음), rename이 실패하면 복사로 폴백한다.
//! 관리형 도구 폴더(`LiveMRManager\tools\`, ffmpeg·yt-dlp·GPU팩)는 식별자와
//! 무관한 별도 경로라 건드리지 않는다.

use std::path::{Path, PathBuf};

const OLD_IDENTIFIER: &str = "com.autumncolor77.live-mr-manager";
const NEW_IDENTIFIER: &str = "com.osw.desktop";
/// 결정을 한 번만 묻기 위한 마커(새 루트에 기록).
const MARKER: &str = ".migration_checked";
/// 옮기지 않는 최상위 항목(임시 파일·마커 자신).
const SKIP: &[&str] = &["temp", MARKER];

/// 앱 데이터 루트(`%LOCALAPPDATA%\<식별자>\`). Tauri의 app_local_data_dir과 동일한
/// 규칙이지만 AppHandle 없이 계산한다 — 마이그레이션은 Tauri 창·이벤트 루프가
/// 생기기 전에 실행돼야 하기 때문(그때는 handle을 쓸 수 없다).
fn local_data_dir(identifier: &str) -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    Some(base.join(identifier))
}

/// 첫 실행 시 구 데이터를 감지해 가져올지 묻고, 예이면 새 위치로 옮긴다.
/// Tauri 빌더를 만들기 전에 호출한다(창이 없어야 모달이 안전하다).
pub fn maybe_migrate_legacy_data() {
    let Some(new_dir) = local_data_dir(NEW_IDENTIFIER) else { return; };
    // 이미 한 번 물어봤으면 다시 하지 않는다.
    if new_dir.join(MARKER).exists() {
        return;
    }
    let Some(old_dir) = local_data_dir(OLD_IDENTIFIER) else { return; };

    let has_legacy = old_dir.join("library.db").exists();
    if !has_legacy {
        // 가져올 구 데이터가 없다 — 마커만 남겨 다음부터 건너뛴다.
        // (마커가 없는 동안 새 폴더에 생긴 파일은 결정 전 산출물이라 신뢰하지
        //  않으므로, "새 폴더에 library.db가 있으면 스킵" 같은 판정은 두지 않는다.
        //  마커가 곧 결정 기록이다.)
        let _ = std::fs::create_dir_all(&new_dir);
        let _ = std::fs::write(new_dir.join(MARKER), b"skip");
        return;
    }

    let msg = format!(
        "이전 버전(Live MR Manager)의 데이터를 발견했습니다.\n\n\
         라이브러리·분리 결과(MR)·다운로드한 AI 모델을 OSW로 가져올까요?\n\n\
         위치: {}\n\n\
         '예'를 누르면 새 위치로 옮깁니다(같은 드라이브라 즉시 완료). \
         '아니오'를 누르면 빈 상태로 시작합니다.",
        old_dir.display()
    );

    let result = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Info)
        .set_title("OSW 데이터 가져오기")
        .set_description(&msg)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show();
    let do_migrate = matches!(result, rfd::MessageDialogResult::Yes);

    let _ = std::fs::create_dir_all(&new_dir);
    if do_migrate {
        let moved = move_legacy_entries(&old_dir, &new_dir);
        crate::audio_player::sys_log(&format!(
            "[Migration] 구 데이터 {}개 항목을 새 위치로 이전: {:?} → {:?}",
            moved, old_dir, new_dir
        ));
    }
    let _ = std::fs::write(
        new_dir.join(MARKER),
        if do_migrate { b"migrated".as_slice() } else { b"declined".as_slice() },
    );
}

/// 구 루트의 최상위 항목을 rename으로 옮긴다(같은 볼륨이라 즉시). rename 실패 시
/// 복사+삭제로 폴백한다.
///
/// 대상이 이미 있으면 지우고 덮어쓴다 — 이 함수는 마커가 없을 때(= 아직 결정
/// 전)만 호출되고, 그 사이 새 폴더에 생긴 파일은 사용자가 만든 데이터가 아니라
/// 결정 전 산출물(예: 이전 크래시가 만든 빈 library.db)이기 때문. 정상 첫 실행
/// 에선 창·DB보다 먼저 돌므로 대상이 비어 이 분기가 필요 없다.
fn move_legacy_entries(old_dir: &Path, new_dir: &Path) -> usize {
    let mut moved = 0usize;
    let Ok(entries) = std::fs::read_dir(old_dir) else { return 0; };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if SKIP.iter().any(|s| **s == *name.to_string_lossy()) {
            continue;
        }
        let src = entry.path();
        let dest = new_dir.join(&name);
        if dest.exists() {
            let _ = if dest.is_dir() {
                std::fs::remove_dir_all(&dest)
            } else {
                std::fs::remove_file(&dest)
            };
        }
        if std::fs::rename(&src, &dest).is_ok() {
            moved += 1;
        } else if copy_recursive(&src, &dest).is_ok() {
            let _ = if src.is_dir() {
                std::fs::remove_dir_all(&src)
            } else {
                std::fs::remove_file(&src)
            };
            moved += 1;
        }
    }
    moved
}

fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dest)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("osw_migtest_{tag}_{nanos}"))
    }

    #[test]
    fn local_data_dir_joins_identifier_under_localappdata() {
        // LOCALAPPDATA가 있으면 그 아래 식별자 폴더를 돌려준다.
        std::env::set_var("LOCALAPPDATA", "C:/Users/x/AppData/Local");
        let d = local_data_dir(NEW_IDENTIFIER).unwrap();
        assert!(d.ends_with(NEW_IDENTIFIER));
        assert_eq!(d.parent().unwrap(), Path::new("C:/Users/x/AppData/Local"));
    }

    #[test]
    fn move_overwrites_stray_dest_but_skips_temp_and_marker() {
        let base = unique_tmp("move");
        let old = base.join("old");
        let new = base.join("new");
        // 구 데이터: library.db, models/model.onnx, temp/junk, 마커
        std::fs::create_dir_all(old.join("models")).unwrap();
        std::fs::create_dir_all(old.join("temp")).unwrap();
        std::fs::write(old.join("library.db"), b"REAL_DB").unwrap();
        std::fs::write(old.join("models/model.onnx"), b"MODEL").unwrap();
        std::fs::write(old.join("temp/junk"), b"junk").unwrap();
        std::fs::write(old.join(MARKER), b"x").unwrap();
        // 새 위치엔 크래시가 남긴 빈 library.db가 있다 — 진짜 데이터로 덮어써야 함.
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("library.db"), b"EMPTY_STRAY").unwrap();

        let moved = move_legacy_entries(&old, &new);

        // 구 진짜 데이터가 크래시 산출물을 덮어썼다.
        assert_eq!(std::fs::read(new.join("library.db")).unwrap(), b"REAL_DB");
        assert_eq!(std::fs::read(new.join("models/model.onnx")).unwrap(), b"MODEL");
        assert!(!old.join("library.db").exists(), "이동 후 구 위치엔 없어야");
        // temp·마커는 이동 안 함
        assert!(!new.join("temp").exists(), "temp는 옮기지 않는다");
        assert!(!new.join(MARKER).exists(), "마커는 옮기지 않는다");
        assert!(moved >= 2);

        let _ = std::fs::remove_dir_all(&base);
    }
}
