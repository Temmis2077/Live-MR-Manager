use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{WebviewWindow, Manager};
use rusqlite::{params, Connection, Row as SqliteRow};
use std::path::PathBuf;
use std::fs;

use crate::vocal_remover::WaveformRemover;
// Commercially usable built-in model. The file is downloaded on first use so
// the installer does not grow by ~953 MB.

use crate::audio_player::sys_log;
use crate::types::SongMetadata;

pub const DEFAULT_MODEL_ID: &str = "melband_roformer_vocals_mit";
pub const MODELS: &[(&str, &str, &str)] = &[
    (
        DEFAULT_MODEL_ID,
        "melband_roformer_vocals.onnx",
        "https://huggingface.co/smank/mel-band-roformer-vocals-onnx/resolve/60cb6b4b97e41b42f7ff16c2e386f47a8cc7e50a/melband_roformer_vocals.onnx",
    ),
];

// --- App Paths Management ---
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppPaths {
    pub root: PathBuf,
    pub models: PathBuf,
    pub cache: PathBuf,
    pub separated: PathBuf,
    pub temp: PathBuf,
    pub db: PathBuf,
}

/// MR 분리 캐시(separated) 저장 위치 오버라이드.
///
/// Settings DB가 아니라 앱 루트의 작은 텍스트 파일로 관리한다 — `from_handle`은
/// DB 락을 잡은 채 호출되는 경로가 있을 수 있어 DB를 읽으면 락 순서 문제가
/// 생길 수 있고, 경로 설정은 DB보다 먼저 필요해질 수도 있기 때문.
/// 프로세스 시작 시 1회만 읽어 세션 내내 고정(OnceCell) — 실행 중에 저장
/// 위치가 바뀌면 이미 열린 캐시 경로와 어긋나므로, 변경은 재시작 후 적용된다.
static SEPARATED_DIR_OVERRIDE: once_cell::sync::OnceCell<Option<PathBuf>> = once_cell::sync::OnceCell::new();

pub fn separated_override_config_path(root: &std::path::Path) -> PathBuf {
    root.join("separated_dir_override.txt")
}

fn read_separated_override(root: &std::path::Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(separated_override_config_path(root)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_absolute() {
        println!("WARN: [AppPaths] separated dir override is not absolute, ignoring: {}", trimmed);
        return None;
    }
    if let Err(e) = fs::create_dir_all(&dir) {
        println!("WARN: [AppPaths] separated dir override unusable ({}), falling back to default: {}", e, trimmed);
        return None;
    }
    Some(dir)
}

impl AppPaths {
    pub fn from_handle(handle: &tauri::AppHandle) -> Self {
        let root = handle.path().app_local_data_dir().expect("Failed to get app data dir");
        let models = root.join("models");
        let cache = root.join("cache");
        let separated = SEPARATED_DIR_OVERRIDE
            .get_or_init(|| read_separated_override(&root))
            .clone()
            .unwrap_or_else(|| cache.join("separated"));
        let temp = root.join("temp");
        let db = root.join("library.db");

        // Ensure directories exist
        let _ = fs::create_dir_all(&models);
        let _ = fs::create_dir_all(&separated);
        let _ = fs::create_dir_all(&temp);

        Self { root, models, cache, separated, temp, db }
    }
}

pub static APP_PATHS: Lazy<Mutex<Option<AppPaths>>> = Lazy::new(|| Mutex::new(None));

// --- Global State ---

pub static MAIN_WINDOW: Lazy<Mutex<Option<WebviewWindow>>> = Lazy::new(|| Mutex::new(None));
pub static ROFORMER_ENGINE: Lazy<Arc<Mutex<Option<WaveformRemover>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
pub static DB: Lazy<Arc<Mutex<Connection>>> = Lazy::new(|| {
    // Determine app data directory using AppPaths if available, otherwise fallback
    let app_dir = {
        let paths_guard = APP_PATHS.lock();
        if let Some(paths) = paths_guard.as_ref() {
            paths.root.clone()
        } else {
            drop(paths_guard);
            if let Some(window) = MAIN_WINDOW.lock().as_ref() {
                window.app_handle().path().app_local_data_dir().expect("Failed to get app data dir")
            } else {
                let mut path = std::env::var("LOCALAPPDATA") // Use Local instead of Roaming
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| {
                        std::env::var("APPDATA")
                            .map(PathBuf::from)
                            .unwrap_or_else(|_| PathBuf::from("data"))
                    });
                path.push("com.osw.desktop");
                path
            }
        }
    };
    
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    }
    
    let db_path = app_dir.join("library.db");
    sys_log(&format!("[DB] Connecting to: {:?}", db_path));
    
    let mut conn = Connection::open(db_path).expect("Failed to open database");
    // Enable foreign keys and improve data durability
    conn.execute("PRAGMA foreign_keys = ON", []).ok();
    // Use WAL mode for better concurrent access and durability
    conn.execute("PRAGMA journal_mode = WAL", []).ok();
    // Ensure data is written to disk before returning from write operations
    conn.execute("PRAGMA synchronous = FULL", []).ok();
    init_db(&mut conn, &app_dir);
    
    Arc::new(Mutex::new(conn))
});

fn init_db(conn: &mut Connection, app_dir: &PathBuf) {
    // 1. Rename existing Category table to Genres if it exists
    let table_exists: bool = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='Category'",
        [],
        |row: &SqliteRow| row.get::<usize, i64>(0),
    ).unwrap_or(0) > 0;

    if table_exists {
        sys_log("[DB] Migrating old Category table to Genres...");
        conn.execute("ALTER TABLE Category RENAME TO Genres_Old", []).ok();
        conn.execute("CREATE TABLE IF NOT EXISTS Genres (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)", []).ok();
        conn.execute("INSERT OR IGNORE INTO Genres (name) SELECT name FROM Genres_Old", []).ok();
        conn.execute("DROP TABLE Genres_Old", []).ok();
    }

    // 2. Create tables
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS Genres (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
         );
         CREATE TABLE IF NOT EXISTS Categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
         );
         CREATE TABLE IF NOT EXISTS Tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            thumbnail TEXT,
            duration TEXT,
            source TEXT,
            pitch REAL,
            tempo REAL,
            volume REAL,
            artist TEXT,
            play_count INTEGER DEFAULT 0,
            date_added INTEGER,
            is_mr INTEGER DEFAULT 0,
            genre_id INTEGER,
            original_title TEXT,
            translated_title TEXT,
            curation_category TEXT,
            FOREIGN KEY(genre_id) REFERENCES Genres(id)
         );
         CREATE TABLE IF NOT EXISTS Track_Category_Map (
            track_id INTEGER,
            category_id INTEGER,
            PRIMARY KEY(track_id, category_id),
            FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
            FOREIGN KEY(category_id) REFERENCES Categories(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS Tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
         );
         CREATE TABLE IF NOT EXISTS Track_Tag_Map (
            track_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY(track_id, tag_id),
            FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES Tags(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS Settings (
            key TEXT PRIMARY KEY,
            value TEXT
         );
         INSERT OR IGNORE INTO Settings (key, value) VALUES ('active_model_id', 'melband_roformer_vocals_mit');
         UPDATE Settings SET value = 'melband_roformer_vocals_mit'
           WHERE key = 'active_model_id'
             AND value IN ('kim', 'inst_hq_3', 'roformer', 'melband-roformer-deux');
         COMMIT;"
    ).expect("Failed to create tables");

    // 2.1. Check if Tracks has old 'category' column and needs migration to 'genre_id'
    let columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(Tracks)").unwrap();
        let col_iter = stmt.query_map([], |row| row.get::<usize, String>(1)).unwrap();
        col_iter.map(|r| r.unwrap()).collect()
    };

    if columns.contains(&"category".to_string()) && !columns.contains(&"genre_id".to_string()) {
        sys_log("[DB] Found old 'category' column in Tracks. Migrating to 'genre_id'...");
        
        // 1. Ensure all categories exist in Genres table
        let _ = conn.execute("INSERT OR IGNORE INTO Genres (name) SELECT DISTINCT category FROM Tracks WHERE category IS NOT NULL", []);
        
        // 2. Temporarily rename Tracks
        let _ = conn.execute("ALTER TABLE Tracks RENAME TO Tracks_Old", []);
        
        // 3. Recreate Tracks with NEW schema
        conn.execute(
            "CREATE TABLE Tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                thumbnail TEXT,
                duration TEXT,
                source TEXT,
                pitch REAL,
                tempo REAL,
                volume REAL,
                artist TEXT,
                play_count INTEGER DEFAULT 0,
                date_added INTEGER,
                is_mr INTEGER DEFAULT 0,
                genre_id INTEGER,
                original_title TEXT,
                translated_title TEXT,
                curation_category TEXT,
                FOREIGN KEY(genre_id) REFERENCES Genres(id)
            )",
            []
        ).unwrap();
        
        // 4. Fill with old data, joining with Genres to get ID
        conn.execute(
            "INSERT INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, play_count, date_added, is_mr, genre_id)
             SELECT t.path, t.title, t.thumbnail, t.duration, t.source, t.pitch, t.tempo, t.volume, t.artist, t.play_count, t.date_added, t.is_mr, g.id
             FROM Tracks_Old t
             LEFT JOIN Genres g ON t.category = g.name",
            []
        ).unwrap();
        
        // 5. Drop old table
        let _ = conn.execute("DROP TABLE Tracks_Old", []);
        sys_log("[DB] Tracks table migration completed.");
    } else {
        // Check for missing curation columns individually
        if !columns.contains(&"original_title".to_string()) {
            let _ = conn.execute("ALTER TABLE Tracks ADD COLUMN original_title TEXT", []);
            sys_log("[DB] Added original_title column to Tracks.");
        }
        if !columns.contains(&"translated_title".to_string()) {
            let _ = conn.execute("ALTER TABLE Tracks ADD COLUMN translated_title TEXT", []);
            sys_log("[DB] Added translated_title column to Tracks.");
        }
        if !columns.contains(&"curation_category".to_string()) {
            let _ = conn.execute("ALTER TABLE Tracks ADD COLUMN curation_category TEXT", []);
            sys_log("[DB] Added curation_category column to Tracks.");
        }
        let meloming_columns: &[(&str, &str)] = &[
            ("song_key", "ALTER TABLE Tracks ADD COLUMN song_key TEXT"),
            ("bpm", "ALTER TABLE Tracks ADD COLUMN bpm INTEGER"),
            ("difficulty", "ALTER TABLE Tracks ADD COLUMN difficulty INTEGER"),
            ("proficiency", "ALTER TABLE Tracks ADD COLUMN proficiency INTEGER"),
            ("karaoke_url", "ALTER TABLE Tracks ADD COLUMN karaoke_url TEXT"),
            ("cover_url", "ALTER TABLE Tracks ADD COLUMN cover_url TEXT"),
            ("original_url", "ALTER TABLE Tracks ADD COLUMN original_url TEXT"),
            ("lyrics_link", "ALTER TABLE Tracks ADD COLUMN lyrics_link TEXT"),
            ("meloming_song_id", "ALTER TABLE Tracks ADD COLUMN meloming_song_id INTEGER"),
            ("meloming_channel_id", "ALTER TABLE Tracks ADD COLUMN meloming_channel_id INTEGER"),
            ("meloming_artist_id", "ALTER TABLE Tracks ADD COLUMN meloming_artist_id INTEGER"),
            ("meloming_category_ids", "ALTER TABLE Tracks ADD COLUMN meloming_category_ids TEXT"),
            ("sync_status", "ALTER TABLE Tracks ADD COLUMN sync_status TEXT DEFAULT 'none'"),
            ("local_updated_at", "ALTER TABLE Tracks ADD COLUMN local_updated_at INTEGER"),
            ("remote_updated_at", "ALTER TABLE Tracks ADD COLUMN remote_updated_at INTEGER"),
            ("content_hash", "ALTER TABLE Tracks ADD COLUMN content_hash TEXT"),
        ];
        for (name, ddl) in meloming_columns {
            if !columns.contains(&name.to_string()) {
                let _ = conn.execute(ddl, []);
                sys_log(&format!("[DB] Added {} column to Tracks.", name));
            }
        }
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS Meloming_Artist_Map (
            local_name TEXT NOT NULL,
            meloming_artist_id INTEGER NOT NULL,
            channel_id INTEGER NOT NULL,
            PRIMARY KEY (local_name, channel_id)
         );
         CREATE TABLE IF NOT EXISTS Meloming_Category_Map (
            local_name TEXT NOT NULL,
            meloming_category_id INTEGER NOT NULL,
            channel_id INTEGER NOT NULL,
            PRIMARY KEY (local_name, channel_id)
         );",
    )
    .ok();

    crate::custom_models::ensure_table(conn);

    // 3. One-time migration from library.json if exists
    let json_path = app_dir.join("library.json");
    if json_path.exists() {
        let track_count: i64 = conn.query_row("SELECT count(*) FROM Tracks", [], |row: &SqliteRow| row.get::<usize, i64>(0)).unwrap_or(0);
        if track_count == 0 {
            sys_log("[DB] Starting one-time migration from library.json...");
            if let Ok(json_data) = fs::read_to_string(&json_path) {
                if let Ok(songs) = serde_json::from_str::<Vec<SongMetadata>>(&json_data) {
                    let tx = conn.transaction().expect("Failed to start transaction");
                    for song in songs {
                        let genre_id: Option<i64> = if let Some(cat_name) = &song.genre {
                            tx.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![cat_name]).ok();
                            tx.query_row("SELECT id FROM Genres WHERE name = ?", params![cat_name], |row: &SqliteRow| row.get::<usize, i64>(0)).ok()
                        } else {
                            None
                        };
                        tx.execute(
                            "INSERT OR REPLACE INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, play_count, date_added, is_mr, genre_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            params![
                                song.path,
                                song.title,
                                song.thumbnail,
                                song.duration,
                                song.source,
                                song.pitch.unwrap_or(0.0),
                                song.tempo.unwrap_or(1.0),
                                song.volume.unwrap_or(80.0),
                                song.artist,
                                song.play_count.unwrap_or(0),
                                song.date_added,
                                if song.is_mr.unwrap_or(false) { 1 } else { 0 },
                                genre_id
                            ]
                        ).ok();

                        // Migrate Tags
                        if let Some(tags) = &song.tags {
                            let track_id: Option<i64> = tx.query_row("SELECT id FROM Tracks WHERE path = ?", params![song.path], |row| row.get(0)).ok();
                            if let Some(tid) = track_id {
                                for tag in tags {
                                    tx.execute("INSERT OR IGNORE INTO Tags (name) VALUES (?)", params![tag]).ok();
                                    let tag_id: Option<i64> = tx.query_row("SELECT id FROM Tags WHERE name = ?", params![tag], |row| row.get(0)).ok();
                                    if let Some(tgid) = tag_id {
                                        tx.execute("INSERT OR IGNORE INTO Track_Tag_Map (track_id, tag_id) VALUES (?, ?)", params![tid, tgid]).ok();
                                    }
                                }
                            }
                        }
                    }
                    tx.commit().expect("Failed to commit migration");
                    sys_log("[DB] Migration from library.json completed.");
                }
            }
        }
    }
}
// AUDIO_HANDLER initialized in audio_player.rs


// --- Data structures moved to types.rs ---
