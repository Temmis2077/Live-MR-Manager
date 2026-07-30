//! Meloming OpenAPI HTTP client.

use serde::{Deserialize, Serialize};

use super::settings::{get_setting, KEY_API_KEY};

pub const BASE_URL: &str = "https://openapi.meloming.com";
pub const API_VERSION: &str = "2026-01-11";

#[derive(Debug, thiserror::Error)]
pub enum MelomingError {
    #[error("HTTP {0}: {1}")]
    Http(u16, String),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongResponse {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub artist_id: Option<i64>,
    #[serde(default)]
    pub artist_name: Option<String>,
    #[serde(default)]
    pub album_art: Option<String>,
    #[serde(default)]
    pub karaoke_url: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub original_url: Option<String>,
    #[serde(default)]
    pub difficulty: Option<i32>,
    #[serde(default)]
    pub proficiency: Option<i32>,
    #[serde(default)]
    pub song_key: Option<String>,
    #[serde(default)]
    pub bpm: Option<i32>,
    #[serde(default)]
    pub lyrics_link: Option<String>,
    #[serde(default)]
    pub lyrics_text: Option<String>,
    #[serde(default)]
    pub category_ids: Option<Vec<i64>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongsListResponse {
    songs: Vec<SongResponse>,
    #[serde(default)]
    total: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistResponse {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryResponse {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub profile_image_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelProfile {
    #[serde(default)]
    pub nickname: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateArtistBody {
    name: String,
}

#[derive(Debug, Serialize)]
struct CreateCategoryBody {
    name: String,
    color: String,
}

pub struct MelomingClient;

impl MelomingClient {
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .user_agent("OSW")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    pub(crate) async fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, MelomingError> {
        let res = Self::client()
            .get(url)
            .header("Meloming-Version", API_VERSION)
            .send()
            .await
            .map_err(|e| MelomingError::Message(e.to_string()))?;
        let status = res.status();
        let body = res
            .text()
            .await
            .map_err(|e| MelomingError::Message(e.to_string()))?;
        if !status.is_success() {
            return Err(MelomingError::Http(status.as_u16(), body));
        }
        serde_json::from_str(&body).map_err(|e| MelomingError::Message(format!("JSON: {e}; body: {body}")))
    }

    pub async fn get_channel_info(channel_id: i64) -> Result<ChannelInfo, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}");
        Self::get_json(&url).await
    }

    pub async fn get_channel_profile(channel_id: i64) -> Result<ChannelProfile, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/profile");
        Self::get_json(&url).await
    }

    pub async fn test_channel(channel_id: i64) -> Result<(i64, String), MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/songs?limit=1");
        let page: SongsListResponse = Self::get_json(&url).await?;
        let sample = page
            .songs
            .first()
            .map(|s| s.title.clone())
            .unwrap_or_else(|| "(노래 없음)".into());
        Ok((page.total.max(page.songs.len() as i64), sample))
    }

    pub async fn list_songs(channel_id: i64) -> Result<Vec<SongResponse>, MelomingError> {
        let mut all = Vec::new();
        let mut page = 1i64;
        loop {
            let url = format!(
                "{BASE_URL}/v1/channels/{channel_id}/songs?limit=100&page={page}&sortBy=newest"
            );
            let res: SongsListResponse = Self::get_json(&url).await?;
            let count = res.songs.len();
            all.extend(res.songs);
            if count < 100 {
                break;
            }
            page += 1;
            if page > 200 {
                break;
            }
        }
        Ok(all)
    }

    pub async fn list_artists(channel_id: i64) -> Result<Vec<ArtistResponse>, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/artists");
        Self::get_json(&url).await
    }

    pub async fn list_categories(channel_id: i64) -> Result<Vec<CategoryResponse>, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/categories");
        Self::get_json(&url).await
    }

    pub async fn create_artist(
        channel_id: i64,
        name: &str,
        token: &str,
    ) -> Result<ArtistResponse, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/artists");
        let body = CreateArtistBody {
            name: name.trim().to_string(),
        };
        let req = Self::authed_request(reqwest::Method::POST, &url, token, Some(&body));
        Self::send_json(req).await
    }

    pub async fn create_category(
        channel_id: i64,
        name: &str,
        color: &str,
        token: &str,
    ) -> Result<CategoryResponse, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/categories");
        let body = CreateCategoryBody {
            name: name.trim().to_string(),
            color: color.to_string(),
        };
        let req = Self::authed_request(reqwest::Method::POST, &url, token, Some(&body));
        Self::send_json(req).await
    }

    fn authed_request(
        method: reqwest::Method,
        url: &str,
        token: &str,
        body: Option<&impl Serialize>,
    ) -> reqwest::RequestBuilder {
        let mut req = Self::client()
            .request(method, url)
            .header("Meloming-Version", API_VERSION)
            .header("Authorization", format!("Bearer {token}"));
        if let Some(key) = get_setting(KEY_API_KEY)
            .or_else(|| std::env::var("MELOMING_API_KEY").ok())
            .filter(|s| !s.trim().is_empty())
        {
            req = req.header("X-API-Key", key);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        req
    }

    async fn send_json<T: for<'de> Deserialize<'de>>(
        req: reqwest::RequestBuilder,
    ) -> Result<T, MelomingError> {
        let res = req
            .send()
            .await
            .map_err(|e| MelomingError::Message(e.to_string()))?;
        let status = res.status();
        let body = res
            .text()
            .await
            .map_err(|e| MelomingError::Message(e.to_string()))?;
        if !status.is_success() {
            return Err(MelomingError::Http(status.as_u16(), body));
        }
        serde_json::from_str(&body).map_err(|e| MelomingError::Message(format!("JSON: {e}; body: {body}")))
    }

    pub async fn create_song(
        channel_id: i64,
        body: &impl Serialize,
        token: &str,
    ) -> Result<SongResponse, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/songs");
        let req = Self::authed_request(reqwest::Method::POST, &url, token, Some(body));
        Self::send_json(req).await
    }

    pub async fn patch_song(
        channel_id: i64,
        song_id: i64,
        body: &impl Serialize,
        token: &str,
    ) -> Result<SongResponse, MelomingError> {
        let url = format!("{BASE_URL}/v1/channels/{channel_id}/songs/{song_id}");
        let req = Self::authed_request(reqwest::Method::PATCH, &url, token, Some(body));
        Self::send_json(req).await
    }
}
