//! lyrics_db.rs — LRCLIB에서 이미 싱크된 가사(LRC)를 받아 로컬에 저장한다.
//!
//! 배경: 곡을 추가할 때마다 가사를 웹에서 찾아 붙여넣고 AI 정렬을 돌리는 게
//! 가장 번거로운 단계다. [LRCLIB](https://lrclib.net)은 음악 플레이어용으로
//! 만들어진 무인증 공개 API로, 타임코드가 이미 붙은 LRC를 준다. 여기서 찾히면
//! 정렬을 돌릴 필요가 없다.
//!
//! ## 길이 대조가 핵심
//! 같은 곡 제목으로 검색해도 길이가 제각각인 후보가 여럿 나온다(같은 곡의
//! TV 사이즈·확장판·라이브 등). 길이를 안 맞추고 아무거나 쓰면 전체가 밀린
//! 가사가 붙어서, 차라리 가사가 없느니만 못하다. 그래서 후보는 반드시 곡
//! 길이로 거른다.
//!
//! ## 가사는 로컬에만 둔다
//! 받은 LRC 본문은 프런트엔드로 넘기지 않고 Rust에서 바로 파일로 쓴다.
//! 명령이 돌려주는 건 "찾았는지 / 어느 후보와 몇 초 차이인지" 같은 요약뿐이다.
//! 가사 저작권은 각 권리자에게 있고, OSW는 사용자 PC 밖으로 내보내지 않는다.

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle};

const LRCLIB_BASE: &str = "https://lrclib.net";

/// LRCLIB에 보내는 User-Agent. 공개 API지만 어떤 앱이 쓰는지 밝히는 게 예의다.
fn user_agent() -> String {
    format!("OSW/{} (https://github.com/Temmis2077/OSW)", env!("CARGO_PKG_VERSION"))
}

/// 곡 길이 허용 오차(초). LRCLIB의 duration은 소수점까지 있고 음원마다 인코딩
/// 차이로 1~2초는 흔들린다. 3초를 넘어가면 다른 버전으로 본다.
const DURATION_TOLERANCE_SEC: f64 = 3.0;

#[derive(Debug, Deserialize)]
struct LrclibTrack {
    #[serde(rename = "trackName")]
    track_name: Option<String>,
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    duration: Option<f64>,
    instrumental: Option<bool>,
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
}

impl LrclibTrack {
    fn has_synced(&self) -> bool {
        self.synced_lyrics.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
    }

    /// 요청한 길이와 몇 초 차이인지. 길이 정보가 없으면 None.
    fn duration_diff(&self, want: Option<f64>) -> Option<f64> {
        match (self.duration, want) {
            (Some(d), Some(w)) if w > 0.0 => Some((d - w).abs()),
            _ => None,
        }
    }
}

/// 프런트로 돌려주는 결과 — 가사 본문은 들어 있지 않다.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncedLyricsOutcome {
    /// 가사를 찾아 저장했는지.
    pub saved: bool,
    /// 타임코드가 있는 가사인지(false면 가사만 있어 정렬이 더 필요하다).
    pub synced: bool,
    /// 매칭된 후보의 표시용 이름 (예: "IU — Through the Night").
    pub matched: String,
    /// 매칭된 후보의 길이(초).
    pub matched_duration: Option<f64>,
    /// 곡 길이와의 차이(초). 사용자가 매칭이 미덥지 않을 때 판단할 근거.
    pub duration_diff: Option<f64>,
    /// 저장한 .lrc 경로.
    pub saved_path: String,
    /// 저장하지 못했을 때의 사유(사용자에게 보여줄 문장).
    pub reason: String,
}

fn label(t: &LrclibTrack) -> String {
    let artist = t.artist_name.as_deref().unwrap_or("").trim();
    let track = t.track_name.as_deref().unwrap_or("").trim();
    match (artist.is_empty(), track.is_empty()) {
        (false, false) => format!("{} — {}", artist, track),
        (true, false) => track.to_string(),
        (false, true) => artist.to_string(),
        _ => String::new(),
    }
}

/// 후보 중 가장 나은 것을 고른다.
///
/// 1) 길이가 허용 오차 안인 것만 남긴다(길이를 모르면 거르지 않는다).
/// 2) 타임코드가 있는 것을 우선한다.
/// 3) 그 다음 길이가 가장 가까운 것.
fn pick_best(mut candidates: Vec<LrclibTrack>, want_duration: Option<f64>) -> Option<LrclibTrack> {
    candidates.retain(|t| {
        if t.instrumental.unwrap_or(false) {
            return false; // 연주곡 항목은 가사가 없다
        }
        if !t.has_synced() && t.plain_lyrics.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            return false; // 가사가 아예 없는 항목
        }
        match t.duration_diff(want_duration) {
            Some(diff) => diff <= DURATION_TOLERANCE_SEC,
            // 길이를 모르면(우리 쪽이든 저쪽이든) 일단 남긴다 — 다만 뒤로 밀린다.
            None => true,
        }
    });

    candidates.sort_by(|a, b| {
        // 타임코드 있는 쪽 먼저
        let synced = b.has_synced().cmp(&a.has_synced());
        if synced != std::cmp::Ordering::Equal {
            return synced;
        }
        // 길이가 가까운 쪽 먼저 (길이를 모르면 맨 뒤)
        let da = a.duration_diff(want_duration).unwrap_or(f64::MAX);
        let db = b.duration_diff(want_duration).unwrap_or(f64::MAX);
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
    });

    candidates.into_iter().next()
}

async fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(user_agent())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))
}

/// `/api/get` — 가수·곡명·길이가 다 맞을 때만 한 건을 준다. 맞으면 가장 정확하다.
async fn lrclib_get(
    client: &reqwest::Client,
    artist: &str,
    track: &str,
    duration: Option<f64>,
) -> Option<LrclibTrack> {
    let duration = duration?;
    let resp = client
        .get(format!("{}/api/get", LRCLIB_BASE))
        .query(&[
            ("artist_name", artist),
            ("track_name", track),
            ("duration", &format!("{}", duration.round() as i64)),
        ])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None; // 404 = 그 길이로는 없음
    }
    resp.json::<LrclibTrack>().await.ok()
}

/// `/api/search` — 후보를 여러 건 준다. 길이는 우리가 직접 걸러야 한다.
async fn lrclib_search(
    client: &reqwest::Client,
    artist: &str,
    track: &str,
) -> Vec<LrclibTrack> {
    let mut query: Vec<(&str, &str)> = vec![("track_name", track)];
    if !artist.is_empty() {
        query.push(("artist_name", artist));
    }
    let Ok(resp) = client
        .get(format!("{}/api/search", LRCLIB_BASE))
        .query(&query)
        .send()
        .await
    else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    resp.json::<Vec<LrclibTrack>>().await.unwrap_or_default()
}

/// 싱크된 가사를 찾아 곡 옆에 `.lrc`로 저장한다.
///
/// `duration_sec`을 넘기면 정확도가 크게 올라간다 — 같은 제목의 다른 길이
/// 버전이 붙는 걸 막아준다.
#[command]
pub async fn fetch_synced_lyrics(
    handle: AppHandle,
    path: String,
    artist: String,
    title: String,
    duration_sec: Option<f64>,
) -> Result<SyncedLyricsOutcome, String> {
    let artist = artist.trim().to_string();
    let title = title.trim().to_string();
    if title.is_empty() {
        return Ok(SyncedLyricsOutcome {
            reason: "곡 제목이 없어 가사를 찾을 수 없습니다.".into(),
            ..Default::default()
        });
    }

    let client = http_client().await?;

    // 1) 정확 매칭 → 2) 검색 후 길이로 거르기
    let exact = if artist.is_empty() {
        None
    } else {
        lrclib_get(&client, &artist, &title, duration_sec).await
    };
    let best = match exact {
        Some(t) if t.has_synced() || t.plain_lyrics.is_some() => Some(t),
        _ => pick_best(lrclib_search(&client, &artist, &title).await, duration_sec),
    };

    let Some(track) = best else {
        return Ok(SyncedLyricsOutcome {
            reason: "LRCLIB에서 이 곡의 가사를 찾지 못했습니다.".into(),
            ..Default::default()
        });
    };

    let synced = track.has_synced();
    // 타임코드가 있으면 그것을, 없으면 일반 가사라도 저장한다(정렬의 입력이 된다).
    let content = if synced {
        track.synced_lyrics.clone().unwrap_or_default()
    } else {
        track.plain_lyrics.clone().unwrap_or_default()
    };
    if content.trim().is_empty() {
        return Ok(SyncedLyricsOutcome {
            reason: "가사 내용이 비어 있습니다.".into(),
            ..Default::default()
        });
    }

    let matched = label(&track);
    let duration_diff = track.duration_diff(duration_sec);
    let matched_duration = track.duration;

    // 가사 본문은 여기서 바로 파일로 나간다 — 프런트로 넘기지 않는다.
    let saved_path = crate::alignment::save_lrc_file(handle, path, content).await?;

    Ok(SyncedLyricsOutcome {
        saved: true,
        synced,
        matched,
        matched_duration,
        duration_diff,
        saved_path,
        reason: String::new(),
    })
}

/* ─────────────────────── 곡 정보 자동 채우기 ───────────────────────
   출처를 항목마다 다르게 잡는다:
   * 장르·태그 — Last.fm 태그를 프로젝트 분류 체계로 번역(metadata_fetcher).
     사람이 붙인 태그라 "이 곡이 어떤 분위기인가"에는 오디오 분석보다 낫다.
   * 키·BPM — 실제 음원을 분석(key_bpm). 외부 DB는 같은 곡의 다른 버전 값을
     주기 쉬운데, 여기서는 사용자가 가진 그 파일의 값이 필요하다.

   비어 있는 항목만 채우고 사용자가 적어 둔 값은 덮어쓰지 않는다. */

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutofillOutcome {
    pub genre: Option<String>,
    pub tags: Option<Vec<String>>,
    pub song_key: Option<String>,
    pub bpm: Option<i32>,
    /// 채우지 못한 항목의 사유 (예: "장르: Last.fm 태그 없음").
    pub notes: Vec<String>,
}

/// 곡 하나의 빈 정보를 채운다. 실패한 항목은 notes에 남기고 나머지는 채운다 —
/// 하나가 안 된다고 전체를 실패로 돌리면 쓸모가 없다.
#[command]
pub async fn autofill_song_info(
    app: AppHandle,
    path: String,
    artist: String,
    title: String,
    want_genre: bool,
    want_key_bpm: bool,
) -> Result<AutofillOutcome, String> {
    let mut out = AutofillOutcome::default();
    let artist = artist.trim().to_string();
    let title = title.trim().to_string();

    if want_genre {
        if artist.is_empty() || title.is_empty() {
            out.notes.push("장르: 가수와 곡명이 모두 있어야 찾을 수 있습니다.".into());
        } else {
            match crate::metadata_fetcher::fetch_and_process_tags(app, artist.clone(), title.clone()).await {
                Ok(meta) => {
                    if !meta.genre.trim().is_empty() {
                        out.genre = Some(meta.genre);
                    }
                    if !meta.tags.is_empty() {
                        out.tags = Some(meta.tags);
                    }
                    if out.genre.is_none() && out.tags.is_none() {
                        out.notes.push("장르: 이 곡에 붙은 태그를 찾지 못했습니다.".into());
                    }
                }
                Err(e) => out.notes.push(format!("장르: {}", e)),
            }
        }
    }

    if want_key_bpm {
        // 분석은 무겁고 CPU를 오래 쓴다 — 블로킹 스레드로 보낸다.
        let p = path.clone();
        let analysis = tauri::async_runtime::spawn_blocking(move || {
            crate::key_bpm::analyze_key_bpm_for_path(&p)
        })
        .await
        .map_err(|e| format!("키·BPM 분석 실패: {}", e))?;

        match analysis {
            Ok(a) => {
                if !a.key.trim().is_empty() {
                    out.song_key = Some(a.key);
                }
                if a.bpm > 0.0 {
                    out.bpm = Some(a.bpm.round() as i32);
                }
            }
            Err(e) => out.notes.push(format!("키·BPM: {}", e)),
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(artist: &str, name: &str, dur: f64, synced: bool) -> LrclibTrack {
        LrclibTrack {
            track_name: Some(name.into()),
            artist_name: Some(artist.into()),
            duration: Some(dur),
            instrumental: Some(false),
            synced_lyrics: if synced { Some("[00:01.00] x".into()) } else { None },
            plain_lyrics: Some("x".into()),
        }
    }

    #[test]
    fn rejects_candidates_whose_length_does_not_match() {
        // 같은 제목이라도 TV 사이즈·확장판이면 통째로 밀린 가사가 붙는다.
        let got = pick_best(
            vec![t("YOASOBI", "アイドル", 122.0, true), t("YOASOBI", "アイドル", 217.0, true)],
            Some(216.0),
        );
        assert_eq!(got.unwrap().duration, Some(217.0));

        // 허용 오차를 넘는 후보만 있으면 아무것도 고르지 않는다.
        assert!(pick_best(vec![t("A", "B", 122.0, true)], Some(216.0)).is_none());
    }

    #[test]
    fn prefers_synced_over_plain_then_closest_length() {
        let got = pick_best(
            vec![t("A", "B", 200.5, false), t("A", "B", 201.0, true)],
            Some(200.0),
        )
        .unwrap();
        assert!(got.has_synced(), "타임코드가 있는 후보를 먼저 골라야 한다");

        // 둘 다 타임코드가 있으면 길이가 가까운 쪽
        let got = pick_best(
            vec![t("A", "B", 202.5, true), t("A", "B", 200.2, true)],
            Some(200.0),
        )
        .unwrap();
        assert_eq!(got.duration, Some(200.2));
    }

    #[test]
    fn skips_instrumental_and_empty_entries() {
        let mut inst = t("A", "B", 200.0, true);
        inst.instrumental = Some(true);
        assert!(pick_best(vec![inst], Some(200.0)).is_none());

        let mut empty = t("A", "B", 200.0, false);
        empty.plain_lyrics = Some("   ".into());
        empty.synced_lyrics = None;
        assert!(pick_best(vec![empty], Some(200.0)).is_none());
    }

    #[test]
    fn keeps_candidate_when_length_is_unknown() {
        // 우리 쪽 길이를 모르면 거를 근거가 없다 — 후보를 살려두되 사용자가
        // 판단할 수 있게 duration_diff는 None으로 남는다.
        let got = pick_best(vec![t("A", "B", 200.0, true)], None);
        assert!(got.is_some());
        assert_eq!(got.unwrap().duration_diff(None), None);
    }

    #[test]
    fn builds_readable_label() {
        assert_eq!(label(&t("IU", "Through the Night", 283.0, true)), "IU — Through the Night");
        let mut no_artist = t("", "제목만", 100.0, true);
        no_artist.artist_name = Some("  ".into());
        assert_eq!(label(&no_artist), "제목만");
    }
}
