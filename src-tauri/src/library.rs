use tauri::AppHandle;
use std::fs::File;
use std::io::BufReader;
use id3::{Tag, TagLike};
use rusqlite::{params, Error as SqliteError};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use rodio::Source;
use crate::state::DB;
use crate::types::SongMetadata;
use crate::ipc::ApiError;

fn library_error(code: &str, error: String) -> ApiError {
    ApiError::recoverable(code, error)
}

pub fn to_sqlite_err(e: SqliteError) -> String {
    e.to_string()
}

pub fn format_id_list(ids: Option<&Vec<i64>>) -> Option<String> {
    ids.filter(|v| !v.is_empty())
        .map(|v| v.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(","))
}

pub fn parse_id_list(raw: Option<String>) -> Option<Vec<i64>> {
    let text = raw.filter(|s| !s.trim().is_empty())?;
    let ids: Vec<i64> = text
        .split([',', ';', '|'])
        .filter_map(|p| p.trim().parse::<i64>().ok())
        .collect();
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}

fn meloming_channel_id_for_song(
    tx: &rusqlite::Transaction<'_>,
    song: &SongMetadata,
) -> Option<i64> {
    if let Some(id) = song.meloming_channel_id {
        return Some(id);
    }
    // Must read via `tx` — callers hold DB.lock(); re-locking would deadlock.
    tx.query_row(
        "SELECT value FROM Settings WHERE key = 'meloming_channel_id'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.trim().parse().ok())
}

fn sync_meloming_category_maps(
    tx: &rusqlite::Transaction<'_>,
    song: &SongMetadata,
) -> Result<(), SqliteError> {
    let channel_id = match meloming_channel_id_for_song(tx, song) {
        Some(id) => id,
        None => return Ok(()),
    };
    let ids = match &song.meloming_category_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => return Ok(()),
    };
    let names: Vec<String> = song
        .categories
        .as_ref()
        .map(|cats| cats.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    let pairs: Vec<(&str, i64)> = if names.len() == ids.len() {
        names.iter().map(|s| s.as_str()).zip(ids.iter().copied()).collect()
    } else if names.len() == 1 {
        ids.iter().map(|id| (names[0].as_str(), *id)).collect()
    } else if names.is_empty() {
        return Ok(());
    } else {
        names
            .iter()
            .zip(ids.iter())
            .map(|(name, id)| (name.as_str(), *id))
            .collect()
    };

    for (name, meloming_id) in pairs {
        tx.execute(
            "INSERT OR REPLACE INTO Meloming_Category_Map (local_name, meloming_category_id, channel_id) VALUES (?, ?, ?)",
            params![name, meloming_id, channel_id],
        )?;
    }
    Ok(())
}

pub fn probe_audio_duration(path: &str) -> Option<String> {
    let mss = MediaSourceStream::new(Box::new(File::open(path).ok()?), Default::default());
    let mut hint = Hint::new();
    if path.to_lowercase().ends_with(".mp3") { hint.with_extension("mp3"); }
    let probed = symphonia::default::get_probe().format(&hint, mss, &Default::default(), &Default::default()).ok()?;
    let track = probed.format.default_track().or_else(|| probed.format.tracks().first())?;
    if let (Some(frames), Some(rate)) = (track.codec_params.n_frames, track.codec_params.sample_rate) {
        let s = frames / (rate as u64);
        return Some(format!("{}:{:02}", s / 60, s % 60));
    }
    if let Ok(d) = rodio::Decoder::new(BufReader::new(File::open(path).ok()?)) {
        if let Some(dur) = d.total_duration() {
            let s = dur.as_secs();
            return Some(format!("{}:{:02}", s / 60, s % 60));
        }
    }
    None
}

#[tauri::command]
#[specta::specta]
pub async fn update_song_metadata(song: SongMetadata) -> Result<(), ApiError> {
    save_library_internal(vec![song]).await
        .map_err(|error| library_error("library.song.update_failed", error))
}

#[tauri::command]
pub async fn get_audio_metadata(path: String) -> Result<SongMetadata, String> {
    // 1. Fetch metadata (YouTube or Local)
    let mut metadata = if path.starts_with("http") {
        crate::model_commands::youtube_metadata_fetcher(path.clone()).await?
    } else {
        let file_path = std::path::Path::new(&path);
        let file_name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let duration_str = probe_audio_duration(&path).unwrap_or_else(|| "0:00".into());

        let mut genre = "Unknown".to_string();
        let (mut artist_id3, mut title_id3) = (None, None);
        if let Ok(tag) = Tag::read_from_path(&path) {
            if let Some(g) = tag.genre() { genre = g.to_string(); }
            artist_id3 = tag.artist().map(|s| s.to_string());
            title_id3 = tag.title().map(|s| s.to_string());
        }

        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let final_title = title_id3.unwrap_or(file_name);

        SongMetadata {
            id: None, title: final_title, thumbnail: "".into(), duration: duration_str,
            source: "local".into(), path: path.clone(), pitch: Some(0.0), tempo: Some(1.0), volume: Some(100.0),
            artist: artist_id3, tags: None, genre: Some(genre), categories: None, play_count: Some(0),
            date_added: Some(now), is_mr: Some(false), is_separated: Some(false),
            has_lyrics: Some(false),
            lyric_sync_status: None,
            original_title: None, translated_title: None, curation_category: None,
            ..Default::default()
        }
    };

    // 2. Save to DB (Persist fetched metadata)
    save_library_internal(vec![metadata.clone()]).await?;
    
    // 3. Retrieve ID
    let db = DB.lock();
    if let Ok(id) = db.query_row("SELECT id FROM Tracks WHERE path = ?", params![path], |row| row.get(0)) {
        metadata.id = Some(id);
    }

    Ok(metadata)
}

pub async fn get_songs_internal(paths: crate::state::AppPaths) -> Result<Vec<SongMetadata>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare(
        "SELECT t.id, t.path, t.title, t.thumbnail, t.duration, t.source, t.pitch, t.tempo, t.volume, t.artist, t.play_count, t.date_added, t.is_mr, g.name as genre,
         (SELECT GROUP_CONCAT(name) FROM Tags JOIN Track_Tag_Map ON Tags.id = Track_Tag_Map.tag_id WHERE Track_Tag_Map.track_id = t.id) as tags,
         (SELECT GROUP_CONCAT(name) FROM Categories JOIN Track_Category_Map ON Categories.id = Track_Category_Map.category_id WHERE Track_Category_Map.track_id = t.id) as categories,
         t.original_title, t.translated_title, t.curation_category,
         t.song_key, t.bpm, t.difficulty, t.proficiency,
         t.karaoke_url, t.cover_url, t.original_url, t.lyrics_link,
         t.meloming_song_id, t.meloming_channel_id, t.meloming_artist_id,
         t.meloming_category_ids, t.sync_status
         FROM Tracks t LEFT JOIN Genres g ON t.genre_id = g.id"
    ).map_err(to_sqlite_err)?;
    
    let song_iter = stmt.query_map([], |row| {
        let raw_genre = row.get::<_, Option<String>>(13).ok().flatten();
        let raw_tags: Option<Vec<String>> = row.get::<_, Option<String>>(14).ok().flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());
        
        let (genre, tags, auto_category) = crate::metadata_fetcher::translate_metadata(raw_genre, raw_tags);
        
        let mut categories: Option<Vec<String>> = row.get::<_, Option<String>>(15).ok().flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());
        
        if categories.is_none() || categories.as_ref().unwrap().is_empty() {
            if let Some(ac) = auto_category {
                categories = Some(vec![ac]);
            }
        }
        
        let track_path = row.get::<_, String>(1).unwrap_or_default();
        let is_separated = crate::model_commands::mr_separated_files_exist(&paths, &track_path);

        // 가사 싱크 상태: LRC 내용을 읽어 타임스탬프 유무로 분류(로컬/URL 곡 모두
        // alignment::read_lrc_content가 올바른 경로를 해석 — 기존 with_extension
        // 방식은 URL 곡에서 오작동했음). has_lyrics는 하위호환으로 유지.
        let lyric_sync_status = match crate::alignment::read_lrc_content(&paths, &track_path) {
            Some(content) if !content.trim().is_empty() => crate::alignment::lrc_sync_status(&content),
            _ => "none",
        };
        let has_lyrics = lyric_sync_status != "none";

        Ok(SongMetadata {
            id: row.get(0).ok(), path: row.get(1)?, title: row.get(2)?, thumbnail: row.get::<_, String>(3).unwrap_or_default(),
            duration: row.get::<_, String>(4).unwrap_or_default(), source: row.get::<_, String>(5).unwrap_or_default(),
            pitch: row.get(6).ok(), tempo: row.get(7).ok(), volume: row.get(8).ok(), artist: row.get(9).ok(),
            play_count: row.get::<_, u32>(10).ok(), date_added: row.get::<_, u64>(11).ok(),
            is_mr: Some(row.get::<_, i64>(12).unwrap_or(0) != 0), genre, tags, categories,
            is_separated: Some(is_separated),
            has_lyrics: Some(has_lyrics),
            lyric_sync_status: Some(lyric_sync_status.to_string()),
            original_title: row.get(16).ok(),
            translated_title: row.get(17).ok(),
            curation_category: row.get(18).ok(),
            song_key: row.get(19).ok(),
            bpm: row.get(20).ok(),
            difficulty: row.get::<_, Option<i32>>(21).ok().flatten().and_then(|v| (1..=5).contains(&v).then_some(v as u8)),
            proficiency: row.get::<_, Option<i32>>(22).ok().flatten().and_then(|v| (1..=5).contains(&v).then_some(v as u8)),
            karaoke_url: row.get(23).ok(),
            cover_url: row.get(24).ok(),
            original_url: row.get(25).ok(),
            lyrics_link: row.get(26).ok(),
            meloming_song_id: row.get(27).ok(),
            meloming_channel_id: row.get(28).ok(),
            meloming_artist_id: row.get(29).ok(),
            meloming_category_ids: parse_id_list(row.get(30).ok()),
            sync_status: row.get(31).ok(),
        })
    }).map_err(to_sqlite_err)?;

    let mut songs = Vec::new();
    for song in song_iter { songs.push(song.map_err(to_sqlite_err)?); }
    Ok(songs)
}

/// DB-only load for merge operations (no filesystem / translation side effects).
pub fn load_all_songs_from_db() -> Result<Vec<SongMetadata>, String> {
    let db = DB.lock();
    let mut stmt = db
        .prepare(
            "SELECT t.id, t.path, t.title, t.thumbnail, t.duration, t.source, t.pitch, t.tempo, t.volume, t.artist, t.play_count, t.date_added, t.is_mr, g.name as genre,
         (SELECT GROUP_CONCAT(name) FROM Tags JOIN Track_Tag_Map ON Tags.id = Track_Tag_Map.tag_id WHERE Track_Tag_Map.track_id = t.id) as tags,
         (SELECT GROUP_CONCAT(name) FROM Categories JOIN Track_Category_Map ON Categories.id = Track_Category_Map.category_id WHERE Track_Category_Map.track_id = t.id) as categories,
         t.original_title, t.translated_title, t.curation_category,
         t.song_key, t.bpm, t.difficulty, t.proficiency,
         t.karaoke_url, t.cover_url, t.original_url, t.lyrics_link,
         t.meloming_song_id, t.meloming_channel_id, t.meloming_artist_id,
         t.meloming_category_ids, t.sync_status
         FROM Tracks t LEFT JOIN Genres g ON t.genre_id = g.id",
        )
        .map_err(to_sqlite_err)?;

    let song_iter = stmt.query_map([], |row| {
        let raw_tags: Option<Vec<String>> = row
            .get::<_, Option<String>>(14)
            .ok()
            .flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());
        let categories: Option<Vec<String>> = row
            .get::<_, Option<String>>(15)
            .ok()
            .flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());

        Ok(SongMetadata {
            id: row.get(0).ok(),
            path: row.get(1)?,
            title: row.get(2)?,
            thumbnail: row.get::<_, String>(3).unwrap_or_default(),
            duration: row.get::<_, String>(4).unwrap_or_default(),
            source: row.get::<_, String>(5).unwrap_or_default(),
            pitch: row.get(6).ok(),
            tempo: row.get(7).ok(),
            volume: row.get(8).ok(),
            artist: row.get(9).ok(),
            play_count: row.get::<_, u32>(10).ok(),
            date_added: row.get::<_, u64>(11).ok(),
            is_mr: Some(row.get::<_, i64>(12).unwrap_or(0) != 0),
            genre: row.get(13).ok(),
            tags: raw_tags,
            categories,
            is_separated: None,
            has_lyrics: None,
            lyric_sync_status: None,
            original_title: row.get(16).ok(),
            translated_title: row.get(17).ok(),
            curation_category: row.get(18).ok(),
            song_key: row.get(19).ok(),
            bpm: row.get(20).ok(),
            difficulty: row
                .get::<_, Option<i32>>(21)
                .ok()
                .flatten()
                .and_then(|v| (1..=5).contains(&v).then_some(v as u8)),
            proficiency: row
                .get::<_, Option<i32>>(22)
                .ok()
                .flatten()
                .and_then(|v| (1..=5).contains(&v).then_some(v as u8)),
            karaoke_url: row.get(23).ok(),
            cover_url: row.get(24).ok(),
            original_url: row.get(25).ok(),
            lyrics_link: row.get(26).ok(),
            meloming_song_id: row.get(27).ok(),
            meloming_channel_id: row.get(28).ok(),
            meloming_artist_id: row.get(29).ok(),
            meloming_category_ids: parse_id_list(row.get(30).ok()),
            sync_status: row.get(31).ok(),
        })
    }).map_err(to_sqlite_err)?;

    let mut songs = Vec::new();
    for song in song_iter {
        songs.push(song.map_err(to_sqlite_err)?);
    }
    Ok(songs)
}

#[tauri::command]
pub async fn get_songs(paths: tauri::State<'_, crate::state::AppPaths>) -> Result<Vec<SongMetadata>, String> {
    get_songs_internal(paths.inner().clone()).await
}

#[tauri::command]
#[specta::specta]
pub async fn load_library(paths: tauri::State<'_, crate::state::AppPaths>) -> Result<Vec<SongMetadata>, ApiError> {
    match get_songs_internal(paths.inner().clone()).await {
        Ok(songs) => Ok(songs),
        Err(e) => {
            let _ = crate::audio_player::sys_log(&format!("[Command] [Error] load_library failed: {}", e));
            Err(library_error("library.load_failed", e))
        }
    }
}

async fn get_categories_internal() -> Result<Vec<crate::types::Category>, String> {
    let db = DB.lock();
    // Only categories that appear on at least one track (same idea as get_genres).
    let mut stmt = db.prepare(
        "SELECT COALESCE(c.id, 0) AS id, u.name
         FROM (
            SELECT DISTINCT TRIM(c.name) AS name
            FROM Categories c
            INNER JOIN Track_Category_Map m ON c.id = m.category_id
            UNION
            SELECT DISTINCT TRIM(t.curation_category) AS name
            FROM Tracks t
            WHERE t.curation_category IS NOT NULL AND TRIM(t.curation_category) != ''
         ) u
         LEFT JOIN Categories c ON c.name = u.name
         WHERE u.name IS NOT NULL AND TRIM(u.name) != ''
         ORDER BY u.name COLLATE NOCASE",
    )
    .map_err(to_sqlite_err)?;
    let iter = stmt
        .query_map([], |row| {
            Ok(crate::types::Category {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(to_sqlite_err)?;
    let mut res = Vec::new();
    for i in iter {
        res.push(i.map_err(to_sqlite_err)?);
    }
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub async fn get_categories() -> Result<Vec<crate::types::Category>, ApiError> {
    get_categories_internal().await
        .map_err(|error| library_error("library.categories.load_failed", error))
}

async fn get_genres_internal() -> Result<Vec<crate::types::Genre>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare(
        "SELECT g.id, g.name
         FROM Genres g
         INNER JOIN Tracks t ON t.genre_id = g.id
         GROUP BY g.id, g.name
         ORDER BY g.name COLLATE NOCASE"
    ).map_err(to_sqlite_err)?;
    let iter = stmt.query_map([], |row| Ok(crate::types::Genre { id: row.get(0)?, name: row.get(1)? })).map_err(to_sqlite_err)?;
    let mut res = Vec::new();
    for i in iter { res.push(i.map_err(to_sqlite_err)?); }
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub async fn get_genres() -> Result<Vec<crate::types::Genre>, ApiError> {
    get_genres_internal().await
        .map_err(|error| library_error("library.genres.load_failed", error))
}

/// 어느 트랙도 쓰지 않는 장르·카테고리 행을 지운다.
///
/// 옛 스키마의 영문 슬러그(jpop, rock, ballad …)와 표준화 과정에서 중복이 된
/// 한글 값(록, 인디 록, 포크)이 0곡짜리로 남아 있었다. get_genres/get_categories가
/// 트랙이 붙은 것만 돌려주므로 화면에는 안 보이지만, 이름이 겹치는 새 값을
/// 넣을 때 걸리적거리고 DB를 읽을 때 헷갈린다.
///
/// 이름이 비어 있는 행도 함께 정리한다(빈 장르 ''가 실제로 있었다).
/// 트랙이 하나라도 붙어 있으면 지우지 않는다.
async fn prune_unused_taxonomy_internal() -> Result<(u32, u32), String> {
    let db = DB.lock();

    // 빈 이름 장르를 참조하는 트랙은 먼저 '장르 없음'으로 풀어 준다.
    db.execute(
        "UPDATE Tracks SET genre_id = NULL
         WHERE genre_id IN (SELECT id FROM Genres WHERE TRIM(COALESCE(name, '')) = '')",
        [],
    )
    .map_err(to_sqlite_err)?;

    let genres = db
        .execute(
            "DELETE FROM Genres
             WHERE id NOT IN (SELECT genre_id FROM Tracks WHERE genre_id IS NOT NULL)",
            [],
        )
        .map_err(to_sqlite_err)? as u32;

    // 카테고리는 매핑 테이블과 Tracks.curation_category 두 곳에서 쓰인다.
    let categories = db
        .execute(
            "DELETE FROM Categories
             WHERE id NOT IN (SELECT category_id FROM Track_Category_Map)
               AND TRIM(COALESCE(name, '')) NOT IN (
                   SELECT TRIM(COALESCE(curation_category, '')) FROM Tracks
                   WHERE curation_category IS NOT NULL
               )",
            [],
        )
        .map_err(to_sqlite_err)? as u32;

    println!("[Taxonomy] 미사용 정리: 장르 {genres}개, 카테고리 {categories}개");
    Ok((genres, categories))
}

#[tauri::command]
#[specta::specta]
pub async fn prune_unused_taxonomy() -> Result<(u32, u32), ApiError> {
    prune_unused_taxonomy_internal().await
        .map_err(|error| library_error("library.taxonomy.prune_failed", error))
}

#[tauri::command]
pub async fn add_category(name: String) -> Result<i64, String> {
    let db = DB.lock();
    db.execute("INSERT INTO Categories (name) VALUES (?)", params![name]).map_err(to_sqlite_err)?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
pub async fn delete_category(id: i64) -> Result<(), String> {
    let db = DB.lock();
    db.execute("DELETE FROM Track_Category_Map WHERE category_id = ?", params![id]).ok();
    db.execute("DELETE FROM Categories WHERE id = ?", params![id]).map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
pub async fn map_track_to_categories(track_id: i64, category_ids: Vec<i64>) -> Result<(), String> {
    let mut db = DB.lock();
    let tx = db.transaction().map_err(to_sqlite_err)?;
    tx.execute("DELETE FROM Track_Category_Map WHERE track_id = ?", params![track_id]).ok();
    for cat_id in category_ids {
        tx.execute("INSERT INTO Track_Category_Map (track_id, category_id) VALUES (?, ?)", params![track_id, cat_id]).ok();
    }
    tx.commit().map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_song(path: String) -> Result<(), ApiError> {
    let db = DB.lock();
    db.execute("DELETE FROM Tracks WHERE path = ?", params![path]).map_err(|e| {
        let _ = crate::audio_player::sys_log(&format!("[Command] [Error] delete_song failed: {}", e));
        library_error("library.song.delete_failed", to_sqlite_err(e))
    })?;
    Ok(())
}

pub async fn save_library_internal(songs: Vec<SongMetadata>) -> Result<(), String> {
    let mut db = DB.lock();
    let tx = db.transaction().map_err(to_sqlite_err)?;
    
    for song in songs {
        let genre_id: Option<i64> = if let Some(g) = &song.genre {
            tx.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![g]).ok();
            tx.query_row("SELECT id FROM Genres WHERE name = ?", params![g], |row| row.get(0)).ok()
        } else { None };

        // When categories are sent from the UI, they are the source of truth (clears stale curation_category).
        let curation_category = match &song.categories {
            Some(cats) => cats
                .first()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            None => song.curation_category.clone(),
        };

        tx.execute(
            "INSERT OR REPLACE INTO Tracks (
                path, title, thumbnail, duration, source, pitch, tempo, volume, artist, play_count, date_added, is_mr, genre_id,
                original_title, translated_title, curation_category,
                song_key, bpm, difficulty, proficiency,
                karaoke_url, cover_url, original_url, lyrics_link,
                meloming_song_id, meloming_channel_id, meloming_artist_id, meloming_category_ids, sync_status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                song.path, song.title, song.thumbnail, song.duration, song.source,
                song.pitch.unwrap_or(0.0), song.tempo.unwrap_or(1.0), song.volume.unwrap_or(100.0),
                song.artist, song.play_count.unwrap_or(0), song.date_added,
                if song.is_mr.unwrap_or(false) { 1 } else { 0 },
                genre_id, song.original_title, song.translated_title, curation_category,
                song.song_key, song.bpm, song.difficulty, song.proficiency,
                song.karaoke_url, song.cover_url, song.original_url, song.lyrics_link,
                song.meloming_song_id, song.meloming_channel_id, song.meloming_artist_id,
                format_id_list(song.meloming_category_ids.as_ref()),
                song.sync_status.as_deref().unwrap_or("none")
            ]
        )
        .map_err(|e| format!("Tracks 저장 실패 ({}): {}", song.path, e))?;

        sync_meloming_category_maps(&tx, &song).map_err(|e| {
            format!("Meloming 카테고리 매핑 실패 ({}): {}", song.path, e)
        })?;

        let track_id: Option<i64> = tx.query_row("SELECT id FROM Tracks WHERE path = ?", params![song.path], |row| row.get(0)).ok();
        if let Some(tid) = track_id {
            if let Some(tags) = &song.tags {
                tx.execute("DELETE FROM Track_Tag_Map WHERE track_id = ?", params![tid]).ok();
                for t in tags {
                    tx.execute("INSERT OR IGNORE INTO Tags (name) VALUES (?)", params![t]).ok();
                    if let Ok(tgid) = tx.query_row("SELECT id FROM Tags WHERE name = ?", params![t], |row| row.get::<_, i64>(0)) {
                        tx.execute("INSERT OR IGNORE INTO Track_Tag_Map (track_id, tag_id) VALUES (?, ?)", params![tid, tgid]).ok();
                    }
                }
            }
            if let Some(cats) = &song.categories {
                tx.execute("DELETE FROM Track_Category_Map WHERE track_id = ?", params![tid]).ok();
                for c in cats {
                    tx.execute("INSERT OR IGNORE INTO Categories (name) VALUES (?)", params![c]).ok();
                    if let Ok(cid) = tx.query_row("SELECT id FROM Categories WHERE name = ?", params![c], |row| row.get::<_, i64>(0)) {
                        tx.execute("INSERT OR IGNORE INTO Track_Category_Map (track_id, category_id) VALUES (?, ?)", params![tid, cid]).ok();
                    }
                }
            }
        }
    }
    tx.commit().map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn save_library(_app: AppHandle, songs: Vec<SongMetadata>) -> Result<(), ApiError> {
    match save_library_internal(songs).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = crate::audio_player::sys_log(&format!("[Command] [Error] save_library failed: {}", e));
            Err(library_error("library.save_failed", e))
        }
    }
}

#[tauri::command]
pub async fn get_track_count() -> Result<i64, String> {
    let db = DB.lock();
    db.query_row("SELECT count(*) FROM Tracks", [], |row| row.get(0)).map_err(to_sqlite_err)
}

pub fn update_track_duration(path: &str, duration: &str) -> Result<(), String> {
    let db = DB.lock();
    db.execute("UPDATE Tracks SET duration = ? WHERE path = ?", params![duration, path]).map_err(to_sqlite_err)?;
    Ok(())
}

