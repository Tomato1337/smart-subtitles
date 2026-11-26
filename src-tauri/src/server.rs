use crate::{logs, media::stream::stream_args, session, state::AppState, types::SessionRequest};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::{process::Stdio, sync::{atomic::{AtomicBool, Ordering}, Arc}, time::Duration};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

const PLUGIN_JS: &str = include_str!("../../lampa-plugin/smartsubs.js");

const TAURI_ORIGINS: [&str; 5] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
];

/// Per-process random capability token appended to `/media/*` URLs so local apps/browsers
/// without the token cannot probe poster history or read active streams.
pub fn media_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

pub fn router(st: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/session", post(post_session))
        .route("/lampa/smartsubs.js", get(plugin))
        .route("/media/{sid}/stream", get(stream))
        .route("/media/{sid}/flow", post(flow))
        .route("/media/poster/{key}", get(poster_route))
        .merge(crate::setup::routes(st.clone()))
        .layer(middleware::from_fn_with_state(st.clone(), cors))
        .layer(middleware::from_fn_with_state(st.clone(), host_check))
        .layer(middleware::from_fn(access_log))
        .with_state(st)
}

pub async fn serve(st: Arc<AppState>) -> anyhow::Result<()> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], st.listen_port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(st)).await?;
    Ok(())
}

fn origin_of(h: &HeaderMap) -> Option<String> {
    let mut all = h.get_all(header::ORIGIN).iter();
    let first = all.next()?;
    if all.next().is_some() {
        return None;
    }
    first.to_str().ok().map(str::to_string)
}

async fn host_check(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if !crate::setup::valid_loopback_host(req.headers(), st.listen_port) {
        return err(StatusCode::FORBIDDEN, "Host должен быть 127.0.0.1");
    }
    next.run(req).await
}

/// Interaction log for HTTP: method, path (never the query) status and duration. `/media/` is the
/// stream/flow pipe — high-frequency — so it is logged only when the request fails.
async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let started = std::time::Instant::now();
    let resp = next.run(req).await;
    let status = resp.status();
    if !(path.starts_with("/media/") && status.is_success()) {
        logs::log("events", &format!("http {method} {path} {} {}ms", status.as_u16(), started.elapsed().as_millis()));
    }
    resp
}

fn is_media_origin_allowed_in(lampa_origins: &[String], origin: &str) -> bool {
    TAURI_ORIGINS.contains(&origin) || lampa_origins.iter().any(|o| o == origin)
}

fn allowed_cors_origin(lampa_origins: &[String], media: bool, headers: &HeaderMap) -> Option<String> {
    origin_of(headers).filter(|o| {
        if media {
            is_media_origin_allowed_in(lampa_origins, o)
        } else {
            lampa_origins.contains(o)
        }
    })
}

async fn cors(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let media = req.uri().path().starts_with("/media/");
    let allowed = allowed_cors_origin(&st.cfg().lampa.origins, media, req.headers());
    let mut resp = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    if let Some(o) = allowed {
        let h = resp.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&o) { h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v); }
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET,POST,OPTIONS"));
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
        h.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
        h.append(header::VARY, HeaderValue::from_static("Origin"));
    } else if media {
        resp.headers_mut().append(header::VARY, HeaderValue::from_static("Origin"));
    }
    resp
}

pub(crate) fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

pub(crate) fn health_allowed_with(lampa_origins: &[String], port: u16, headers: &HeaderMap) -> Result<(), &'static str> {
    if headers.contains_key(header::ORIGIN) {
        let Some(o) = origin_of(headers) else {
            return Err("origin не разрешён");
        };
        if !lampa_origins.contains(&o) {
            return Err("origin не разрешён");
        }
        return Ok(());
    }
    crate::setup::agent_public_allowed(headers, port)
}

async fn health(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(msg) = health_allowed_with(&st.cfg().lampa.origins, st.listen_port, &headers) {
        return err(StatusCode::FORBIDDEN, msg);
    }
    Json(json!({ "ok": true })).into_response()
}

pub(crate) fn plugin_js_for_port(port: u16) -> String {
    PLUGIN_JS.replace("http://127.0.0.1:47800", &format!("http://127.0.0.1:{port}"))
}

async fn plugin(State(st): State<Arc<AppState>>) -> Response {
    ([(header::CONTENT_TYPE, "application/javascript; charset=utf-8")], plugin_js_for_port(st.listen_port)).into_response()
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(str::trim)
        .is_some_and(|m| m.eq_ignore_ascii_case("application/json"))
}

pub(crate) fn validate_http_session_request(req: &SessionRequest) -> Result<(), &'static str> {
    if !crate::setup::valid_http_url(&req.url) {
        return Err("url должен быть http:// или https://");
    }
    if req.subtitles.iter().any(|s| !crate::setup::valid_http_url(&s.url)) {
        return Err("subtitles[].url должен быть http:// или https://");
    }
    for item in &req.playlist {
        if !crate::setup::valid_http_url(&item.url) {
            return Err("playlist[].url должен быть http:// или https://");
        }
        if item.subtitles.iter().any(|s| !crate::setup::valid_http_url(&s.url)) {
            return Err("playlist[].subtitles[].url должен быть http:// или https://");
        }
    }
    if let Some(poster) = req.card.as_ref().and_then(|c| c.poster.as_deref()) {
        if !poster.is_empty() && !crate::setup::valid_http_url(poster) {
            return Err("card.poster должен быть http:// или https://");
        }
    }
    Ok(())
}

pub(crate) fn authorize_session_post_with(lampa_origins: &[String], agent_token: &str, headers: &HeaderMap) -> Result<Option<String>, (StatusCode, &'static str)> {
    if headers.contains_key(header::ORIGIN) {
        let Some(o) = origin_of(headers) else {
            return Err((StatusCode::FORBIDDEN, "origin не разрешён"));
        };
        if !lampa_origins.contains(&o) {
            return Err((StatusCode::FORBIDDEN, "origin не разрешён"));
        }
        return Ok(Some(o));
    }
    if !crate::setup::sec_fetch_safe(headers) {
        return Err((StatusCode::FORBIDDEN, "доступ из браузера без разрешённого origin закрыт"));
    }
    if !crate::setup::valid_bearer(headers, agent_token) {
        return Err((StatusCode::UNAUTHORIZED, "требуется origin из lampa.origins или Bearer-токен"));
    }
    Ok(None)
}

pub(crate) fn authorize_session_post(st: &AppState, headers: &HeaderMap) -> Result<Option<String>, (StatusCode, &'static str)> {
    authorize_session_post_with(&st.cfg().lampa.origins, &st.agent_token, headers)
}

async fn post_session(State(st): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    let allowed_origin = match authorize_session_post(&st, &headers) {
        Ok(o) => o,
        Err((code, msg)) => return err(code, msg),
    };
    if !is_json_content_type(&headers) {
        return err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "требуется Content-Type: application/json");
    }
    let req: SessionRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };
    if let Err(msg) = validate_http_session_request(&req) {
        return err(StatusCode::BAD_REQUEST, msg);
    }
    if let Some(o) = allowed_origin {
        st.lampa_last_seen.lock().unwrap().insert(o, crate::db::now());
    }
    match session::open(&st, req, None).await {
        Ok(id) => Json(json!({ "ok": true, "sessionId": id })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct StreamQuery { start: f64, audio: u32, gen: Option<u64>, t: Option<String> }

#[derive(Deserialize)]
struct FlowQuery { gen: Option<u64>, t: Option<String> }

#[derive(Deserialize)]
struct PosterQuery { t: Option<String> }

pub(crate) fn media_allowed_with(lampa_origins: &[String], headers: &HeaderMap, token: Option<&str>) -> Result<(), (StatusCode, &'static str)> {
    if headers.contains_key(header::ORIGIN) {
        let Some(o) = origin_of(headers) else {
            return Err((StatusCode::FORBIDDEN, "origin не разрешён"));
        };
        if !is_media_origin_allowed_in(lampa_origins, &o) {
            return Err((StatusCode::FORBIDDEN, "origin не разрешён"));
        }
    }
    let Some(t) = token else {
        return Err((StatusCode::FORBIDDEN, "требуется media-токен"));
    };
    if !crate::setup::constant_time_eq(t, media_token()) {
        return Err((StatusCode::FORBIDDEN, "неверный media-токен"));
    }
    Ok(())
}

pub(crate) fn media_allowed(st: &AppState, headers: &HeaderMap, token: Option<&str>) -> Result<(), (StatusCode, &'static str)> {
    media_allowed_with(&st.cfg().lampa.origins, headers, token)
}

async fn stream(State(st): State<Arc<AppState>>, Path(sid): Path<String>, Query(q): Query<StreamQuery>, headers: HeaderMap) -> Response {
    if let Err((code, msg)) = media_allowed(&st, &headers, q.t.as_deref()) {
        return err(code, msg);
    }
    if !q.start.is_finite() || q.start < 0.0 {
        return err(StatusCode::BAD_REQUEST, "некорректная позиция start");
    }
    let Some(s) = st.sessions.get(&sid) else { return err(StatusCode::NOT_FOUND, "нет такой сессии") };
    let Some(probe) = s.probe.get() else { return err(StatusCode::NOT_FOUND, "ffprobe ещё не завершён") };

    // The stream is a live fMP4 pipe: it cannot serve byte ranges other than from 0.
    if let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let n = r.strip_prefix("bytes=").and_then(|x| x.split('-').next()).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
        if n > 0 {
            return err(StatusCode::RANGE_NOT_SATISFIABLE, "range не поддерживается");
        }
    }

    let gen = q.gen.unwrap_or_else(|| s.gen.fetch_add(1, Ordering::Relaxed) + 1);
    let mode = s.mode(st.vaapi_ok.load(Ordering::Relaxed)).unwrap();
    let args = stream_args(&s.src, q.start, q.audio, probe, mode, &st.cfg().ffmpeg.vaapi_device);
    logs::log("ffmpeg", &format!("[{sid}] ffmpeg {}", args.join(" ")));

    let mut slot = s.ffmpeg.lock().await;
    if s.cancel.is_cancelled() {
        return err(StatusCode::CONFLICT, "сессия закрыта");
    }
    if slot.as_ref().is_some_and(|(cur, _)| gen < *cur) {
        return err(StatusCode::CONFLICT, "поток устарел");
    }
    if let Some((_, mut old)) = slot.take() {
        let _ = old.start_kill();
        let _ = old.wait().await;
    }
    let mut child = match crate::proc::command("ffmpeg").args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn() {
        Ok(c) => c,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("ffmpeg: {e}")),
    };
    let mut stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let tail = Arc::new(std::sync::Mutex::new(String::new()));
    let tail2 = tail.clone();
    let sid2 = sid.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            logs::log("ffmpeg", &format!("[{sid2}] {l}"));
            let mut t = tail2.lock().unwrap();
            t.push_str(&l);
            t.push('\n');
            if t.len() > 2048 {
                let cut = t.len() - 2048;
                let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                t.drain(..cut);
            }
        }
    });
    *slot = Some((gen, child));
    drop(slot);
    let gate = Arc::new(AtomicBool::new(false));
    *s.flow.lock().unwrap() = Some((gen, gate.clone()));

    let mut buf = vec![0u8; 64 * 1024];
    let first = tokio::time::timeout(Duration::from_secs(120), stdout.read(&mut buf)).await;
    let n = match first {
        Ok(Ok(n)) if n > 0 => n,
        other => {
            let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
            let msg = match other {
                Err(_) => "ffmpeg: нет данных за 120 с".to_string(),
                _ => tail.lock().unwrap().clone(),
            };
            let killed_current = s.kill_ffmpeg_if_gen(gen).await;
            if killed_current && !s.cancel.is_cancelled() {
                let _ = st.app.emit("player:error", json!({ "message": msg }));
            }
            return err(StatusCode::BAD_GATEWAY, msg);
        }
    };
    buf.truncate(n);
    let body = futures_util::stream::once(async move { Ok::<_, std::io::Error>(Bytes::from(buf)) }).chain(gated(stdout, gate));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(body))
        .unwrap()
}

/// Reads ffmpeg's stdout only while the client's gate is open. A full buffer window on the client therefore pauses
/// ffmpeg itself instead of piling the endless stream up in the browser (WebKit buffers a fetch body without bound).
fn gated(stdout: tokio::process::ChildStdout, gate: Arc<AtomicBool>) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold(stdout, move |mut out| {
        let gate = gate.clone();
        async move {
            while gate.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(50)).await; }
            let mut buf = vec![0u8; 64 * 1024];
            match out.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => { buf.truncate(n); Some((Ok(Bytes::from(buf)), out)) }
                Err(e) => Some((Err(e), out)),
            }
        }
    })
}

/// Serves the cached (or freshly downloaded) poster of the current session.
async fn poster_route(State(st): State<Arc<AppState>>, Path(key): Path<String>, Query(q): Query<PosterQuery>, headers: HeaderMap) -> Response {
    if let Err((code, msg)) = media_allowed(&st, &headers, q.t.as_deref()) {
        return err(code, msg);
    }
    match crate::poster::bytes(&st, &key).await {
        Some(b) => (
            [(header::CONTENT_TYPE, crate::poster::image_mime(&b)), (header::CACHE_CONTROL, "max-age=86400")],
            b,
        ).into_response(),
        None => err(StatusCode::NOT_FOUND, "нет постера"),
    }
}

/// Pauses or resumes the stream `gen` of the session: the client sends this when its buffer window is full.
async fn flow(State(st): State<Arc<AppState>>, Path(sid): Path<String>, Query(q): Query<FlowQuery>, headers: HeaderMap, body: String) -> Response {
    if let Err((code, msg)) = media_allowed(&st, &headers, q.t.as_deref()) {
        return err(code, msg);
    }
    let Some(s) = st.sessions.get(&sid) else { return err(StatusCode::NOT_FOUND, "нет такой сессии") };
    let gen = q.gen.unwrap_or(0);
    let guard = s.flow.lock().unwrap();
    if let Some((g, gate)) = guard.as_ref() {
        if *g == gen { gate.store(body.trim() == "pause", Ordering::Relaxed); }
    }
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_http_only_session_urls() {
        let valid = SessionRequest {
            url: "https://ts.example/stream?link=abc&index=0".into(),
            title: "Film".into(),
            path: None,
            subtitles: vec![crate::types::SubRef { label: "en".into(), url: "https://ts.example/sub.srt".into() }],
            resume_at: None,
            card: None,
            season: None,
            episode: None,
            episodes: vec![],
            playlist: vec![crate::types::PlaylistItem {
                title: "Ep 2".into(),
                url: "http://127.0.0.1:8095/stream?link=abc&index=1".into(),
                path: None,
                subtitles: vec![],
            }],
        };
        assert!(validate_http_session_request(&valid).is_ok());

        let mut bad_main = valid.clone();
        bad_main.url = "file:///etc/passwd".into();
        assert!(validate_http_session_request(&bad_main).is_err());

        let mut bad_sub = valid.clone();
        bad_sub.subtitles[0].url = "file:///etc/shadow".into();
        assert!(validate_http_session_request(&bad_sub).is_err());

        let mut bad_pl = valid.clone();
        bad_pl.playlist[0].url = "file:///home/u/movie.mkv".into();
        assert!(validate_http_session_request(&bad_pl).is_err());
    }

    #[test]
    fn json_content_type_accepts_parameters_and_rejects_text_plain() {
        let mut h = HeaderMap::new();
        assert!(!is_json_content_type(&h));
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert!(!is_json_content_type(&h));
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
        assert!(is_json_content_type(&h));
    }

    #[test]
    fn session_auth_cors_media_token_health_and_plugin_port() {
        use axum::http::{HeaderName, HeaderValue};
        let make_headers = |pairs: &[(&str, &str)]| {
            let mut h = HeaderMap::new();
            for (k, v) in pairs {
                h.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
            }
            h
        };
        let lampa = vec!["https://lampa.example.com".to_string()];
        let tok = "agent-secret-token";

        // /api/session requires allowed Origin OR (no Origin + valid Bearer token).
        assert!(authorize_session_post_with(&lampa, tok, &make_headers(&[])).is_err());
        assert!(authorize_session_post_with(&lampa, tok, &make_headers(&[("Origin", "https://evil.example")])).is_err());
        assert_eq!(
            authorize_session_post_with(&lampa, tok, &make_headers(&[("Origin", "https://lampa.example.com")])).unwrap(),
            Some("https://lampa.example.com".into())
        );
        assert_eq!(
            authorize_session_post_with(&lampa, tok, &make_headers(&[("Authorization", "Bearer agent-secret-token")])).unwrap(),
            None
        );

        // /media/* requires valid media_token() and only allows Tauri/Lampa origins.
        assert!(media_allowed_with(&lampa, &make_headers(&[]), None).is_err());
        assert!(media_allowed_with(&lampa, &make_headers(&[]), Some("wrong")).is_err());
        assert!(media_allowed_with(&lampa, &make_headers(&[("Origin", "https://evil.example")]), Some(media_token())).is_err());
        assert!(media_allowed_with(&lampa, &make_headers(&[("Origin", "tauri://localhost")]), Some(media_token())).is_ok());
        assert!(media_allowed_with(&lampa, &make_headers(&[("Origin", "https://tauri.localhost")]), Some(media_token())).is_ok());
        assert_eq!(allowed_cors_origin(&lampa, true, &make_headers(&[("Origin", "https://evil.example")])), None);
        assert_eq!(
            allowed_cors_origin(&lampa, true, &make_headers(&[("Origin", "tauri://localhost")])),
            Some("tauri://localhost".into())
        );

        // /api/health allows loopback curl, rejects cross-site Sec-Fetch and unallowed Origins.
        assert!(health_allowed_with(&lampa, 47800, &make_headers(&[("Host", "127.0.0.1:47800")])).is_ok());
        assert!(health_allowed_with(&lampa, 47800, &make_headers(&[("Host", "127.0.0.1:47800"), ("Sec-Fetch-Site", "cross-site")])).is_err());
        assert!(health_allowed_with(&lampa, 47800, &make_headers(&[("Host", "127.0.0.1:47800"), ("Origin", "https://evil.example")])).is_err());
        assert!(health_allowed_with(&lampa, 47800, &make_headers(&[("Host", "127.0.0.1:47800"), ("Origin", "https://lampa.example.com")])).is_ok());

        // Dynamic port replacement in /lampa/smartsubs.js.
        let js = plugin_js_for_port(49123);
        assert!(js.contains("http://127.0.0.1:49123"));
        assert!(!js.contains("http://127.0.0.1:47800"));
    }
}
