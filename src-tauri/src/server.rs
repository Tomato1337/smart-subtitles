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
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, BufReader}, process::Command};

const PLUGIN_JS: &str = include_str!("../../lampa-plugin/smartsubs.js");

pub fn router(st: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/session", post(post_session))
        .route("/lampa/smartsubs.js", get(plugin))
        .route("/media/{sid}/stream", get(stream))
        .route("/media/{sid}/flow", post(flow))
        .route("/media/poster/{key}", get(poster_route))
        .layer(middleware::from_fn_with_state(st.clone(), cors))
        .with_state(st)
}

pub async fn serve(st: Arc<AppState>) -> anyhow::Result<()> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], st.cfg.server.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(st)).await?;
    Ok(())
}

fn origin_of(h: &HeaderMap) -> Option<String> {
    h.get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_string)
}

async fn cors(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let allowed = origin_of(req.headers()).filter(|o| st.cfg.lampa.origins.contains(o));
    let media = req.uri().path().starts_with("/media/");
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
        resp.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    }
    resp
}

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

async fn plugin() -> Response {
    ([(header::CONTENT_TYPE, "application/javascript; charset=utf-8")], PLUGIN_JS).into_response()
}

async fn post_session(State(st): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(o) = origin_of(&headers) {
        if !st.cfg.lampa.origins.contains(&o) {
            return err(StatusCode::FORBIDDEN, "origin не разрешён");
        }
    }
    let req: SessionRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };
    match session::open(&st, req, None).await {
        Ok(id) => Json(json!({ "ok": true, "sessionId": id })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct StreamQuery { start: f64, audio: u32, gen: Option<u64> }

#[derive(Deserialize)]
struct FlowQuery { gen: Option<u64> }

async fn stream(State(st): State<Arc<AppState>>, Path(sid): Path<String>, Query(q): Query<StreamQuery>, headers: HeaderMap) -> Response {
    let Some(s) = st.sessions.get(&sid) else { return err(StatusCode::NOT_FOUND, "нет такой сессии") };
    let Some(probe) = s.probe.get() else { return err(StatusCode::NOT_FOUND, "ffprobe ещё не завершён") };

    // The stream is a live fMP4 pipe: it cannot serve byte ranges other than from 0.
    if let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let n = r.strip_prefix("bytes=").and_then(|x| x.split('-').next()).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
        if n > 0 {
            return err(StatusCode::RANGE_NOT_SATISFIABLE, "range не поддерживается");
        }
    }

    let mode = s.mode(st.vaapi_ok.load(Ordering::Relaxed)).unwrap();
    let args = stream_args(&s.src, q.start, q.audio, probe, mode, &st.cfg.ffmpeg.vaapi_device);
    logs::log("ffmpeg", &format!("[{sid}] ffmpeg {}", args.join(" ")));

    let mut slot = s.ffmpeg.lock().await;
    if let Some(mut old) = slot.take() {
        let _ = old.start_kill();
        let _ = old.wait().await;
    }
    let mut child = match Command::new("ffmpeg").args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn() {
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
    *slot = Some(child);
    drop(slot);
    let gate = Arc::new(AtomicBool::new(false));
    *s.flow.lock().unwrap() = Some((q.gen.unwrap_or(0), gate.clone()));

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
            s.kill_ffmpeg().await;
            let _ = st.app.emit("player:error", json!({ "message": msg }));
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
async fn poster_route(State(st): State<Arc<AppState>>, Path(key): Path<String>) -> Response {
    match crate::poster::bytes(&st, &key).await {
        Some(b) => (
            [(header::CONTENT_TYPE, crate::poster::image_mime(&b)), (header::CACHE_CONTROL, "max-age=86400")],
            b,
        ).into_response(),
        None => err(StatusCode::NOT_FOUND, "нет постера"),
    }
}

/// Pauses or resumes the stream `gen` of the session: the client sends this when its buffer window is full.
async fn flow(State(st): State<Arc<AppState>>, Path(sid): Path<String>, Query(q): Query<FlowQuery>, body: String) -> Response {
    let Some(s) = st.sessions.get(&sid) else { return err(StatusCode::NOT_FOUND, "нет такой сессии") };
    let gen = q.gen.unwrap_or(0);
    let guard = s.flow.lock().unwrap();
    if let Some((g, gate)) = guard.as_ref() {
        if *g == gen { gate.store(body.trim() == "pause", Ordering::Relaxed); }
    }
    StatusCode::NO_CONTENT.into_response()
}
