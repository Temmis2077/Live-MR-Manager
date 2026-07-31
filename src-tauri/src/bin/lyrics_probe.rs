//! 가사 검색 결과를 눈으로 확인하는 개발용 도구.
//! `cargo run --bin lyrics_probe -- "아이유 밤편지"`
//!
//! 가사 원문은 다루지 않는다 — 검색으로 나온 페이지 링크와 도메인만 찍는다.

#[tokio::main]
async fn main() {
    let query: String = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    if query.trim().is_empty() {
        eprintln!("사용법: lyrics_probe \"곡명 가수\"");
        std::process::exit(2);
    }

    let lang = tauri_app_lib::search::detect_lyrics_lang(&query);
    println!("질의: {}  →  판별: {:?}", query, lang);

    match tauri_app_lib::search::search_lyrics_sites(query).await {
        Ok(rows) => {
            for (i, r) in rows.iter().enumerate() {
                println!(
                    "{}. [{}] {:<26} {}",
                    i + 1,
                    if r.preferred { "우선" } else { "    " },
                    r.domain,
                    r.title.chars().take(50).collect::<String>()
                );
            }
            if rows.is_empty() {
                println!("(결과 없음)");
            }
        }
        Err(e) => println!("실패: {}", e),
    }
}
