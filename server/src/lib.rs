use axum::{
    extract::{
        ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Query, Request,
    },
    http::{header, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{any, get, post},
    serve::ListenerExt,
    Json, Router,
};
use bytes::{BufMut, BytesMut};
use chrono::Local;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    convert::Infallible,
    fs::OpenOptions,
    hash::{Hash, Hasher},
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use tokio::sync::{broadcast, mpsc};

use tower_http::cors::CorsLayer;

mod herdr;
mod tmux_discovery;

use tmux_discovery::{DiscoverySnapshot, GitRootCache};

// ─── CLI ───────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "rust-terminal", version, about = "Mobile web terminal server")]
struct Cli {
    /// Listen port
    #[arg(short, long, default_value = "7681", env = "PORT")]
    port: u16,

    /// Shell to spawn
    #[arg(short, long, default_value = "zsh", env = "SHELL_CMD")]
    shell: String,

    /// Frontend static files directory
    #[arg(long, default_value = "../frontend/dist", env = "STATIC_DIR")]
    static_dir: PathBuf,
}

// ─── Shared State ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    shell: String,
    static_dir: PathBuf,
    client_tty: Arc<Mutex<Option<String>>>,
    git_contexts: Arc<Mutex<HashMap<String, String>>>,
    tmux_snapshot: Arc<Mutex<DiscoverySnapshot>>,
    tmux_scan_trigger: Arc<tokio::sync::Notify>,
    herdr_controllers: Arc<Mutex<HashMap<String, mpsc::Sender<HerdrInput>>>>,
    herdr_snapshot: Arc<Mutex<serde_json::Value>>,
    herdr_event_tx: broadcast::Sender<serde_json::Value>,
}

impl AppState {
    pub fn new(shell: impl Into<String>, static_dir: PathBuf) -> Self {
        let (herdr_event_tx, _) = broadcast::channel(256);
        Self {
            shell: shell.into(),
            static_dir,
            client_tty: Arc::new(Mutex::new(None)),
            git_contexts: Arc::new(Mutex::new(HashMap::new())),
            tmux_snapshot: Arc::new(Mutex::new(DiscoverySnapshot::default())),
            tmux_scan_trigger: Arc::new(tokio::sync::Notify::new()),
            herdr_controllers: Arc::new(Mutex::new(HashMap::new())),
            herdr_snapshot: Arc::new(Mutex::new(serde_json::json!({
                "mux": "herdr",
                "protocol": herdr::SUPPORTED_PROTOCOL,
                "panes": [],
                "workspaces": [],
                "agents": [],
            }))),
            herdr_event_tx,
        }
    }
}

type ApiError = (StatusCode, String, String);

fn cwd_file_path() -> String {
    std::env::var("RUST_TERMINAL_CWD_FILE").unwrap_or_else(|_| "/tmp/ttyd_cwd".to_string())
}

fn tty_file_path() -> String {
    std::env::var("RUST_TERMINAL_TTY_FILE").unwrap_or_else(|_| "/tmp/ttyd_client_tty".to_string())
}

// ─── Entry point ───────────────────────────────────────────────────────────

pub async fn run() {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    // Strip TMUX env vars (like Python version)
    std::env::remove_var("TMUX");
    std::env::remove_var("TMUX_PANE");

    let state = AppState::new(cli.shell.clone(), cli.static_dir.clone());

    start_tmux_discovery(state.clone());
    start_herdr_events(state.clone());

    // Build router
    let app = build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], cli.port));
    tracing::info!("Listening on http://0.0.0.0:{}", cli.port);

    // Print access URLs
    print_access_urls(cli.port);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(
        listener.tap_io(|stream| {
            if let Err(e) = stream.set_nodelay(true) {
                tracing::warn!("Failed to set TCP_NODELAY: {}", e);
            }
        }),
        app,
    )
    .await
    .unwrap();
}

fn print_access_urls(port: u16) {
    eprintln!();
    eprintln!("==========================================");
    eprintln!("  Rust Terminal Started!");
    eprintln!("==========================================");
    eprintln!();

    // Try to get local IPs (works on both macOS and Linux)
    if let Ok(output) = StdCommand::new("ifconfig").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("inet ") {
                if let Some(ip) = rest.split_whitespace().next() {
                    if ip != "127.0.0.1" {
                        eprintln!("  http://{}:{}", ip, port);
                    }
                }
            }
        }
    }
    eprintln!();
    eprintln!("  Stop: kill this process (Ctrl+C)");
    eprintln!("==========================================");
    eprintln!();
}

pub fn build_router(state: AppState) -> Router {
    let static_dir = state.static_dir.clone();

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    Router::new()
        // WebSocket terminal
        .route("/ws", any(ws_handler))
        // API endpoints
        .route("/api/health", get(api_health))
        .route("/api/client-tty", get(api_client_tty))
        .route("/api/cwd", get(api_cwd))
        .route("/api/diff", get(api_diff))
        .route("/api/git/branches", get(api_git_branches))
        .route("/api/git/checkout", get(api_git_checkout))
        .route("/api/git/status", get(api_git_status))
        .route("/api/git/stage", post(api_git_stage))
        .route("/api/git/unstage", post(api_git_unstage))
        .route("/api/git/discard", post(api_git_discard))
        .route("/api/git/commit", post(api_git_commit))
        .route("/api/git/log", get(api_git_log))
        .route("/api/git/commit-diff", get(api_git_commit_diff))
        .route("/api/git/file-diff", get(api_git_file_diff))
        .route("/api/git/batch-file-diff", post(api_git_batch_file_diff))
        .route("/api/git/stage-hunk", post(api_git_stage_hunk))
        .route("/api/git/discard-hunk", post(api_git_discard_hunk))
        .route("/api/tmux/list", get(api_tmux_list))
        .route("/api/tmux/switch", get(api_tmux_switch))
        .route("/api/tmux/create", get(api_tmux_create))
        .route("/api/tmux/kill", get(api_tmux_kill))
        .route("/api/tmux/detach", get(api_tmux_detach))
        .route("/api/tmux/quick-shell", get(api_tmux_quick_shell))
        .route("/api/tmux/pane-mode", get(api_tmux_pane_mode))
        .route("/api/tmux/capture-pane", get(api_tmux_capture_pane))
        .route("/api/tmux/page-up", get(api_tmux_page_up))
        .route("/api/herdr/list", get(api_herdr_list))
        .route("/api/herdr/focus", get(api_herdr_focus))
        .route("/api/herdr/create", get(api_herdr_create))
        .route("/api/herdr/close", get(api_herdr_close))
        .route("/api/herdr/release", get(api_herdr_release))
        .route("/api/herdr/quick-shell", get(api_herdr_quick_shell))
        .route("/api/herdr/pane-mode", get(api_herdr_pane_mode))
        .route("/api/herdr/capture-pane", get(api_herdr_capture_pane))
        .route("/api/herdr/page-up", get(api_herdr_page_up))
        .route("/api/herdr/paste", post(api_herdr_paste))
        .route("/api/events", get(api_events))
        .route("/api/dump-file", post(api_dump_file))
        .route(
            "/api/goal-workspace",
            get(api_get_goal_workspace).post(api_set_goal_workspace),
        )
        .route("/api/goal-dump", post(api_goal_dump))
        .route("/api/upload", post(api_upload_file))
        .route("/api/upload-image", post(api_upload_file))
        .route(
            "/api/user-config",
            get(api_get_user_config).post(api_set_user_config),
        )
        // Static file serving — catch-all for frontend
        .fallback(move |req: Request| serve_static(req, static_dir.clone()))
        .layer(cors)
        .with_state(state)
}

fn start_tmux_discovery(state: AppState) {
    start_tmux_discovery_with(state, Arc::new(tmux_discovery::scan));
}

type TmuxScanner = dyn Fn(&mut GitRootCache) -> Result<DiscoverySnapshot, String> + Send + Sync;

fn start_tmux_discovery_with(state: AppState, scanner: Arc<TmuxScanner>) {
    tokio::spawn(async move {
        let mut cache = GitRootCache::default();
        loop {
            let scan_result = tokio::task::spawn_blocking({
                let mut cache = std::mem::take(&mut cache);
                let scanner = scanner.clone();
                move || {
                    let result = scanner(&mut cache);
                    (cache, result)
                }
            })
            .await;

            match scan_result {
                Ok((returned_cache, Ok(snapshot))) => {
                    cache = returned_cache;
                    update_tmux_snapshot(&state, snapshot);
                }
                Ok((returned_cache, Err(error))) => {
                    cache = returned_cache;
                    tracing::warn!("tmux discovery scan failed: {}", error);
                    update_tmux_snapshot(&state, DiscoverySnapshot::default());
                }
                Err(error) => {
                    tracing::warn!("tmux discovery task failed: {}", error);
                    update_tmux_snapshot(&state, DiscoverySnapshot::default());
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                _ = state.tmux_scan_trigger.notified() => {}
            }
        }
    });
}

fn update_tmux_snapshot(state: &AppState, mut next: DiscoverySnapshot) -> bool {
    let Ok(mut current) = state.tmux_snapshot.lock() else {
        return false;
    };
    let scanned_at = next.scanned_at;
    next.scanned_at = current.scanned_at;
    if *current == next {
        current.scanned_at = scanned_at;
        return false;
    }
    next.scanned_at = scanned_at;
    *current = next;
    true
}

fn get_tmux_snapshot(state: &AppState) -> DiscoverySnapshot {
    state
        .tmux_snapshot
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default()
}

fn trigger_tmux_scan(state: &AppState) {
    state.tmux_scan_trigger.notify_one();
}

fn start_herdr_events(state: AppState) {
    tokio::spawn(async move {
        loop {
            match herdr::protocol_version().await {
                Ok(protocol) if protocol == herdr::SUPPORTED_PROTOCOL => break,
                Ok(protocol) => {
                    tracing::error!(
                        "Unsupported herdr protocol {}; expected {}",
                        protocol,
                        herdr::SUPPORTED_PROTOCOL
                    );
                }
                Err(error) => tracing::warn!("Herdr protocol check failed: {}", error),
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }

        loop {
            match run_herdr_event_session(&state).await {
                Ok(()) => continue,
                Err(error) => tracing::warn!("Herdr event subscription failed: {}", error),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

async fn run_herdr_event_session(state: &AppState) -> Result<(), String> {
    let snapshot = herdr::list().await?;
    let pane_ids = herdr_pane_ids(&snapshot);
    publish_herdr_snapshot(state, snapshot, None);

    let mut subscription = herdr::EventSubscription::connect(&pane_ids).await?;
    tracing::info!(
        "Herdr events subscribed for {} pane{}",
        pane_ids.len(),
        if pane_ids.len() == 1 { "" } else { "s" }
    );
    let mut maintenance = tokio::time::interval(Duration::from_secs(2));
    maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    maintenance.tick().await;
    let mut status_overrides = HashMap::<String, String>::new();

    loop {
        tokio::select! {
            event = subscription.next_event() => {
                let event = event?;
                if let Some((pane_id, status)) = herdr_status_event(&event) {
                    status_overrides.insert(pane_id, status);
                }
                let mut snapshot = herdr::list().await?;
                apply_herdr_status_overrides(&mut snapshot, &status_overrides);
                let next_pane_ids = herdr_pane_ids(&snapshot);
                publish_herdr_snapshot(state, snapshot, Some(event));
                if next_pane_ids != pane_ids {
                    return Ok(());
                }
            }
            _ = maintenance.tick() => {
                let mut snapshot = herdr::list().await?;
                status_overrides.retain(|pane_id, status| {
                    herdr_snapshot_status(&snapshot, pane_id).as_deref() != Some(status.as_str())
                });
                apply_herdr_status_overrides(&mut snapshot, &status_overrides);
                let next_pane_ids = herdr_pane_ids(&snapshot);
                publish_herdr_snapshot(state, snapshot, None);
                if next_pane_ids != pane_ids {
                    return Ok(());
                }
            }
        }
    }
}

fn herdr_status_event(event: &serde_json::Value) -> Option<(String, String)> {
    if event.get("event")?.as_str()? != "pane.agent_status_changed" {
        return None;
    }
    let data = event.get("data")?;
    Some((
        data.get("pane_id")?.as_str()?.to_string(),
        data.get("agent_status")?.as_str()?.to_string(),
    ))
}

fn apply_herdr_status_overrides(
    snapshot: &mut serde_json::Value,
    overrides: &HashMap<String, String>,
) {
    for collection in ["panes", "agents"] {
        let Some(items) = snapshot
            .get_mut(collection)
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        for item in items {
            let Some(pane_id) = item
                .get("pane_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if let Some(status) = overrides.get(&pane_id) {
                item["agent_status"] = serde_json::Value::String(status.clone());
            }
        }
    }
}

fn herdr_snapshot_status(snapshot: &serde_json::Value, pane_id: &str) -> Option<String> {
    for collection in ["agents", "panes"] {
        if let Some(status) = snapshot
            .get(collection)
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .find(|item| item.get("pane_id").and_then(serde_json::Value::as_str) == Some(pane_id))
            .and_then(|item| item.get("agent_status"))
            .and_then(serde_json::Value::as_str)
        {
            return Some(status.to_string());
        }
    }
    None
}

fn publish_herdr_snapshot(
    state: &AppState,
    snapshot: serde_json::Value,
    source_event: Option<serde_json::Value>,
) {
    let previous = get_herdr_snapshot(state);
    let changed = previous != snapshot;
    if changed {
        if let Ok(mut current) = state.herdr_snapshot.lock() {
            *current = snapshot.clone();
        }
    }
    if changed || source_event.is_some() {
        let _ = state.herdr_event_tx.send(serde_json::json!({
            "herdr": snapshot,
            "event": source_event,
        }));
    }
}

fn herdr_pane_ids(snapshot: &serde_json::Value) -> Vec<String> {
    let mut pane_ids = snapshot
        .get("panes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pane| pane.get("pane_id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    pane_ids.sort();
    pane_ids
}

fn get_herdr_snapshot(state: &AppState) -> serde_json::Value {
    state
        .herdr_snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_else(|_| serde_json::json!({}))
}

// ═══════════════════════════════════════════════════════════════════════════
// STATIC FILE SERVING
// ═══════════════════════════════════════════════════════════════════════════

async fn serve_static(req: Request, static_dir: PathBuf) -> Response {
    let path = req.uri().path().trim_start_matches('/');

    let file_path = static_dir.join(if path.is_empty() { "index.html" } else { path });

    let is_file = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false);

    if is_file {
        serve_file(&file_path).await
    } else {
        let index = static_dir.join("index.html");
        let index_exists = tokio::fs::metadata(&index)
            .await
            .map(|m| m.is_file())
            .unwrap_or(false);
        if index_exists {
            serve_file(&index).await
        } else {
            (
                StatusCode::NOT_FOUND,
                "Frontend not built. Run: cd frontend && npm run build",
            )
                .into_response()
        }
    }
}

async fn serve_file(path: &Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(contents) => {
            let mime = match path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "application/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("json") => "application/json",
                Some("png") => "image/png",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("svg") => "image/svg+xml",
                Some("woff2") => "font/woff2",
                Some("woff") => "font/woff",
                Some("ico") => "image/x-icon",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, mime)], contents).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET TERMINAL (ttyd protocol compatible)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct WebSocketQuery {
    mux: Option<String>,
    pane: Option<String>,
}

async fn ws_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<WebSocketQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    match query.mux.as_deref() {
        Some("herdr") => {
            let pane_id = match query.pane.filter(|pane| !pane.trim().is_empty()) {
                Some(pane_id) => pane_id,
                None => {
                    return json_error(
                        "missing_pane",
                        "pane is required when mux=herdr",
                        StatusCode::BAD_REQUEST,
                    )
                }
            };
            let herdr_state = state.clone();
            ws.protocols(["tty"])
                .on_upgrade(move |socket| handle_herdr_terminal(socket, herdr_state, pane_id))
        }
        Some(other) => json_error(
            "invalid_mux",
            &format!("Unsupported terminal multiplexer: {}", other),
            StatusCode::BAD_REQUEST,
        ),
        None => ws
            .protocols(["tty"])
            .on_upgrade(move |socket| handle_terminal(socket, state)),
    }
}

enum HerdrInput {
    Data(bytes::Bytes),
    Resize { cols: u16, rows: u16 },
    Scroll { direction: String, lines: u32 },
    Release,
}

async fn handle_herdr_terminal(socket: WebSocket, state: AppState, pane_id: String) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    let (init_cols, init_rows) = match ws_receiver.next().await {
        Some(Ok(message)) => parse_init_message(message),
        _ => {
            tracing::error!("No init message received for herdr pane {}", pane_id);
            return;
        }
    };
    tracing::info!(
        "Herdr terminal session {}: {}x{}",
        pane_id,
        init_cols,
        init_rows
    );

    let controller = match herdr::TerminalController::spawn(&pane_id, init_cols, init_rows).await {
        Ok(controller) => controller,
        Err(error) => {
            tracing::error!("{}", error);
            let mut frame = BytesMut::with_capacity(error.len() + 32);
            frame.put_u8(0x30);
            frame.extend_from_slice(format!("\r\n[Herdr] {}\r\n", error).as_bytes());
            let _ = ws_sender.send(Message::Binary(frame.freeze())).await;
            let _ = ws_sender
                .send(Message::Close(Some(CloseFrame {
                    code: close_code::ERROR,
                    reason: error.chars().take(120).collect::<String>().into(),
                })))
                .await;
            return;
        }
    };
    let (_process, mut terminal_reader, mut terminal_writer) = controller.split();

    let (output_tx, mut output_rx) = mpsc::channel::<herdr::TerminalEvent>(256);
    let reader_output_tx = output_tx.clone();
    let reader_task = tokio::spawn(async move {
        loop {
            match terminal_reader.next_event().await {
                Ok(event @ herdr::TerminalEvent::Frame(_)) => {
                    if reader_output_tx.send(event).await.is_err() {
                        break;
                    }
                }
                Ok(event @ herdr::TerminalEvent::Closed(_)) => {
                    let _ = reader_output_tx.send(event).await;
                    break;
                }
                Err(error) => {
                    let _ = reader_output_tx
                        .send(herdr::TerminalEvent::Closed(error))
                        .await;
                    break;
                }
            }
        }
    });

    let (input_tx, mut input_rx) = mpsc::channel::<HerdrInput>(256);
    let writer_output_tx = output_tx.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(command) = input_rx.recv().await {
            let result = match command {
                HerdrInput::Data(data) => terminal_writer.send_input(&data).await,
                HerdrInput::Resize { cols, rows } => terminal_writer.resize(cols, rows).await,
                HerdrInput::Scroll { direction, lines } => {
                    terminal_writer.scroll(&direction, lines).await
                }
                HerdrInput::Release => {
                    let result = terminal_writer.release().await;
                    if result.is_ok() {
                        break;
                    }
                    result
                }
            };
            if let Err(error) = result {
                let _ = writer_output_tx
                    .send(herdr::TerminalEvent::Closed(error))
                    .await;
                break;
            }
        }
    });
    drop(output_tx);

    if let Ok(mut controllers) = state.herdr_controllers.lock() {
        controllers.insert(pane_id.clone(), input_tx.clone());
    }

    let mut sender_task = tokio::spawn(async move {
        while let Some(event) = output_rx.recv().await {
            match event {
                herdr::TerminalEvent::Frame(data) => {
                    let mut frame = BytesMut::with_capacity(data.len() + 1);
                    frame.put_u8(0x30);
                    frame.extend_from_slice(&data);
                    if ws_sender
                        .send(Message::Binary(frame.freeze()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                herdr::TerminalEvent::Closed(reason) => {
                    let mut frame = BytesMut::with_capacity(reason.len() + 32);
                    frame.put_u8(0x30);
                    frame.extend_from_slice(
                        format!("\r\n[Herdr] Connection closed: {}\r\n", reason).as_bytes(),
                    );
                    let _ = ws_sender.send(Message::Binary(frame.freeze())).await;
                    let _ = ws_sender
                        .send(Message::Close(Some(CloseFrame {
                            code: close_code::NORMAL,
                            reason: reason.chars().take(120).collect::<String>().into(),
                        })))
                        .await;
                    break;
                }
            }
        }
    });

    let receiver_input_tx = input_tx.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(message)) = ws_receiver.next().await {
            match message {
                Message::Binary(data) => {
                    if data.is_empty() {
                        continue;
                    }
                    let command = match data[0] {
                        0x30 => Some(HerdrInput::Data(bytes::Bytes::copy_from_slice(&data[1..]))),
                        0x31 => std::str::from_utf8(&data[1..])
                            .ok()
                            .and_then(|text| serde_json::from_str::<ResizeMessage>(text).ok())
                            .map(|resize| HerdrInput::Resize {
                                cols: resize.columns,
                                rows: resize.rows,
                            }),
                        _ => None,
                    };
                    if let Some(command) = command {
                        if receiver_input_tx.send(command).await.is_err() {
                            break;
                        }
                    }
                }
                Message::Text(text) => {
                    let Ok(resize) = serde_json::from_str::<ResizeMessage>(text.as_str()) else {
                        continue;
                    };
                    if receiver_input_tx
                        .send(HerdrInput::Resize {
                            cols: resize.columns,
                            rows: resize.rows,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = receiver_input_tx.send(HerdrInput::Release).await;
    });

    tokio::select! {
        _ = &mut sender_task => {
            recv_task.abort();
            let _ = recv_task.await;
        }
        _ = &mut recv_task => {
            let _ = input_tx.send(HerdrInput::Release).await;
            sender_task.abort();
            let _ = sender_task.await;
        }
    }

    reader_task.abort();
    let _ = reader_task.await;
    if let Ok(mut controllers) = state.herdr_controllers.lock() {
        let should_remove = controllers
            .get(&pane_id)
            .map(|sender| sender.same_channel(&input_tx))
            .unwrap_or(false);
        if should_remove {
            controllers.remove(&pane_id);
        }
    }
    drop(input_tx);
    let _ = writer_task.await;
    tracing::info!("Herdr terminal session {} ended", pane_id);
}

async fn handle_terminal(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Step 1: Wait for the auth/init message from client
    // Client sends: JSON {"AuthToken":"","columns":80,"rows":24}
    let (init_cols, init_rows) = match ws_receiver.next().await {
        Some(Ok(msg)) => parse_init_message(msg),
        _ => {
            tracing::error!("No init message received");
            return;
        }
    };

    tracing::info!("Terminal session: {}x{}", init_cols, init_rows);

    let wrapper_path = "/tmp/rust_terminal_wrapper.sh";
    {
        let shell = state.shell.clone();
        let tty_file = tty_file_path();
        let cwd_file = cwd_file_path();
        let wp = wrapper_path.to_string();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            write_wrapper_script(&wp, &shell, &tty_file, &cwd_file);
        })
        .await
        {
            tracing::error!("Failed to write wrapper script: {}", e);
            return;
        }
    }

    // Step 3: Spawn PTY (blocking OS calls → spawn_blocking)
    struct PtyHandles {
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        master: Box<dyn portable_pty::MasterPty + Send>,
        wrapper_pid: Option<u32>,
    }

    let pty_result = tokio::task::spawn_blocking(move || -> Result<PtyHandles, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: init_rows,
                cols: init_cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(wrapper_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env_remove("TMUX");
        cmd.env_remove("TMUX_PANE");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;
        let wrapper_pid = child.process_id();
        drop(child);

        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

        Ok(PtyHandles {
            reader,
            writer,
            master: pair.master,
            wrapper_pid,
        })
    })
    .await;

    let pty = match pty_result {
        Ok(Ok(h)) => h,
        Ok(Err(msg)) => {
            tracing::error!("{}", msg);
            let _ = ws_sender
                .send(Message::Binary(format!("\x30Error: {}\r\n", msg).into()))
                .await;
            return;
        }
        Err(e) => {
            tracing::error!("PTY setup task failed: {}", e);
            return;
        }
    };

    let mut pty_reader = pty.reader;
    let pty_writer = pty.writer;
    let master = Arc::new(Mutex::new(pty.master));
    let wrapper_pid = pty.wrapper_pid;

    let paused = Arc::new((Mutex::new(false), Condvar::new()));
    let paused_reader = paused.clone();

    let (output_tx, mut output_rx) = mpsc::channel::<bytes::Bytes>(256);

    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            {
                let (lock, cvar) = &*paused_reader;
                let mut is_paused = lock.lock().unwrap();
                if *is_paused {
                    let result = cvar
                        .wait_timeout(is_paused, Duration::from_secs(2))
                        .unwrap();
                    is_paused = result.0;
                    if *is_paused {
                        tracing::warn!("Flow control: auto-resuming after 2s timeout");
                        *is_paused = false;
                    }
                }
            }
            match pty_reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output_tx
                        .blocking_send(bytes::Bytes::copy_from_slice(&buf[..n]))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (pty_input_tx, pty_input_rx) = std::sync::mpsc::channel::<bytes::Bytes>();

    let writer_handle = std::thread::spawn(move || {
        let mut writer = pty_writer;
        for data in pty_input_rx {
            let _ = writer.write_all(&data);
        }
        std::mem::forget(writer);
    });

    // Client TTY tracking
    let client_tty_shared = state.client_tty.clone();

    // Per-connection tty tracking (for safe cleanup independent of global state)
    // Prevents race condition where a new connection's tty gets detached by old cleanup.
    let connection_tty: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let connection_tty_sender = connection_tty.clone();

    // ── ADAPTIVE BATCHING: WebSocket sender task ──
    // Adaptive batching: 4ms idle flush, 32KB cap.
    let mut sender_task = tokio::spawn(async move {
        let mut buffer = BytesMut::with_capacity(32768);
        let mut frame_buf = BytesMut::with_capacity(65537);
        let mut tty_detected = false;

        loop {
            let data = output_rx.recv().await;
            match data {
                Some(bytes) => {
                    if !tty_detected {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            if let Some(pos) = text.find("]7337;") {
                                let after = &text[pos + 6..];
                                if let Some(end) = after.find('\\') {
                                    let tty = after[..end].trim_end_matches('\x1b');
                                    // Accept both Linux (/dev/pts/N) and macOS (/dev/ttysN) PTY paths
                                    if tty.starts_with("/dev/") {
                                        if let Ok(mut lock) = client_tty_shared.lock() {
                                            *lock = Some(tty.to_string());
                                        }
                                        if let Ok(mut lock) = connection_tty_sender.lock() {
                                            *lock = Some(tty.to_string());
                                        }
                                        tty_detected = true;
                                    }
                                }
                            }
                        }
                    }
                    buffer.extend_from_slice(&bytes);

                    let deadline = tokio::time::Instant::now() + Duration::from_millis(2);
                    loop {
                        tokio::select! {
                            biased;
                            more = output_rx.recv() => {
                                match more {
                                    Some(more_bytes) => {
                                        if !tty_detected {
                                            if let Ok(text) = std::str::from_utf8(&more_bytes) {
                                                if let Some(pos) = text.find("]7337;") {
                                                    let after = &text[pos + 6..];
                                                    if let Some(end) = after.find('\\') {
                                        let tty = after[..end].trim_end_matches('\x1b');
                                        if tty.starts_with("/dev/") {
                                if let Ok(mut lock) = client_tty_shared.lock() {
                                    *lock = Some(tty.to_string());
                                }
                                if let Ok(mut lock) = connection_tty_sender.lock() {
                                    *lock = Some(tty.to_string());
                                }
                                tty_detected = true;
                                        }
                                                    }
                                                }
                                            }
                                        }
                                        buffer.extend_from_slice(&more_bytes);
                                        if buffer.len() > 65536 {
                                            break;
                                        }
                                    }
                                    None => {
                                        if !buffer.is_empty() {
                                            frame_buf.clear();
                                            frame_buf.put_u8(0x30);
                                            frame_buf.extend_from_slice(&buffer);
                                            let _ = ws_sender.send(Message::Binary(frame_buf.split().freeze())).await;
                                        }
                                        return;
                                    }
                                }
                            }
                            _ = tokio::time::sleep_until(deadline) => {
                                break;
                            }
                        }
                    }

                    if !buffer.is_empty() {
                        frame_buf.clear();
                        frame_buf.put_u8(0x30);
                        frame_buf.extend_from_slice(&buffer);
                        buffer.clear();
                        if ws_sender
                            .send(Message::Binary(frame_buf.split().freeze()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                None => {
                    if !buffer.is_empty() {
                        frame_buf.clear();
                        frame_buf.put_u8(0x30);
                        frame_buf.extend_from_slice(&buffer);
                        let _ = ws_sender
                            .send(Message::Binary(frame_buf.split().freeze()))
                            .await;
                    }
                    break;
                }
            }
        }
    });

    let master_recv = master.clone();
    let paused_recv = paused.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Binary(data) => {
                    if data.is_empty() {
                        continue;
                    }
                    let cmd = data[0];
                    let payload = &data[1..];

                    match cmd {
                        0x30 => {
                            let _ = pty_input_tx.send(bytes::Bytes::copy_from_slice(payload));
                        }
                        0x31 => {
                            if let Ok(text) = std::str::from_utf8(payload) {
                                if let Ok(resize) = serde_json::from_str::<ResizeMessage>(text) {
                                    if let Ok(m) = master_recv.lock() {
                                        let _ = m.resize(PtySize {
                                            rows: resize.rows,
                                            cols: resize.columns,
                                            pixel_width: 0,
                                            pixel_height: 0,
                                        });
                                    }
                                }
                            }
                        }
                        0x32 => {
                            let (lock, _cvar) = &*paused_recv;
                            if let Ok(mut is_paused) = lock.lock() {
                                *is_paused = true;
                            }
                        }
                        0x33 => {
                            let (lock, cvar) = &*paused_recv;
                            if let Ok(mut is_paused) = lock.lock() {
                                *is_paused = false;
                                cvar.notify_one();
                            }
                        }
                        _ => {}
                    }
                }
                Message::Text(text) => {
                    if let Ok(resize) = serde_json::from_str::<ResizeMessage>(text.as_str()) {
                        if let Ok(m) = master_recv.lock() {
                            let _ = m.resize(PtySize {
                                rows: resize.rows,
                                cols: resize.columns,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut sender_task => {
            recv_task.abort();
            let _ = recv_task.await;
        },
        _ = &mut recv_task => {
            sender_task.abort();
            let _ = sender_task.await;
        },
    }

    {
        let (lock, cvar) = &*paused;
        if let Ok(mut is_paused) = lock.lock() {
            *is_paused = false;
            cvar.notify_one();
        }
    }

    if let Some(pid) = wrapper_pid {
        let detached = tokio::task::spawn_blocking(move || {
            let owned = find_owned_tmux_clients(pid);
            for tty in &owned {
                if let Err(e) = run_cmd("tmux", &["detach-client", "-t", tty]) {
                    tracing::warn!("tmux detach-client {} failed: {}", tty, e);
                }
            }
            !owned.is_empty()
        })
        .await
        .unwrap_or(false);
        if detached {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    drop(master);
    let _ = reader_handle.join();
    let _ = writer_handle.join();

    let cleanup_tty = connection_tty.lock().ok().and_then(|lock| lock.clone());
    if let Ok(mut lock) = state.client_tty.lock() {
        if *lock == cleanup_tty {
            *lock = None;
        }
    }

    tracing::info!("Terminal session ended");
}

fn parse_init_message(msg: Message) -> (u16, u16) {
    let data = match msg {
        Message::Text(text) => text.as_bytes().to_vec(),
        Message::Binary(data) => data.to_vec(),
        _ => return (80, 24),
    };

    if let Ok(text) = std::str::from_utf8(&data) {
        if let Ok(init) = serde_json::from_str::<InitMessage>(text) {
            return (init.columns.max(1) as u16, init.rows.max(1) as u16);
        }
    }
    (80, 24)
}

fn write_wrapper_script(path: &str, shell: &str, tty_file: &str, cwd_file: &str) {
    let is_zsh = shell == "zsh" || shell.ends_with("/zsh");
    let is_bash = shell == "bash" || shell.ends_with("/bash");

    if is_zsh {
        // Set up ZDOTDIR with CWD hook
        let zdotdir = "/tmp/rust_terminal_zdotdir";
        let _ = std::fs::create_dir_all(zdotdir);

        // Symlink user's zsh dotfiles
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        for f in &[".zshenv", ".zprofile", ".zlogin", ".zlogout"] {
            let src = format!("{}/{}", home, f);
            let dst = format!("{}/{}", zdotdir, f);
            let _ = std::fs::remove_file(&dst);
            if Path::new(&src).exists() {
                let _ = std::os::unix::fs::symlink(&src, &dst);
            }
        }

        // Write custom .zshrc
        let zshrc = format!(
            r#"ZDOTDIR="$HOME" source "$HOME/.zshrc" 2>/dev/null
if [ -n "$RUST_TERMINAL_TMUX_SOCKET" ]; then
    tmux() {{ command tmux -L "$RUST_TERMINAL_TMUX_SOCKET" "$@"; }}
fi
__ttyd_cwd_hook() {{ echo $PWD > {} 2>/dev/null; }}
precmd_functions+=(__ttyd_cwd_hook)
"#,
            cwd_file
        );
        let _ = std::fs::write(format!("{}/{}", zdotdir, ".zshrc"), zshrc);

        let script = format!(
            r#"#!/bin/zsh
unset TMUX TMUX_PANE
tty > {} 2>/dev/null
printf '\033]7337;%s\033\\' "$(tty)" 2>/dev/null
tmux_rt() {{
    if [ -n "$RUST_TERMINAL_TMUX_SOCKET" ]; then command tmux -L "$RUST_TERMINAL_TMUX_SOCKET" "$@"; else command tmux "$@"; fi
}}
if tmux_rt has-session 2>/dev/null; then
    tmux_rt set -g window-size latest 2>/dev/null
    tmux_rt set -g history-limit 50000 2>/dev/null
    tmux_rt set -g extended-keys always 2>/dev/null
    tmux_rt set -g set-clipboard on 2>/dev/null
    tmux_rt set -g allow-passthrough on 2>/dev/null
    tmux_rt bind-key -n S-Enter send-keys -l $'\033[13;2u' 2>/dev/null
    tmux_rt unbind -T root MouseDrag1Pane 2>/dev/null
    tmux_rt attach
fi
ZDOTDIR={} exec {}
"#,
            tty_file, zdotdir, shell
        );
        let _ = std::fs::write(path, script);
    } else if is_bash {
        let bashrc = format!(
            r#"[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
if [ -n "$RUST_TERMINAL_TMUX_SOCKET" ]; then
    tmux() {{ command tmux -L "$RUST_TERMINAL_TMUX_SOCKET" "$@"; }}
fi
__ttyd_cwd_hook() {{ echo $PWD > {} 2>/dev/null; }}
PROMPT_COMMAND="__ttyd_cwd_hook${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}"
"#,
            cwd_file
        );
        let _ = std::fs::write("/tmp/rust_terminal_bashrc", bashrc);

        let script = format!(
            r#"#!/bin/bash
unset TMUX TMUX_PANE
tty > {} 2>/dev/null
printf '\033]7337;%s\033\\' "$(tty)" 2>/dev/null
tmux_rt() {{
    if [ -n "$RUST_TERMINAL_TMUX_SOCKET" ]; then command tmux -L "$RUST_TERMINAL_TMUX_SOCKET" "$@"; else command tmux "$@"; fi
}}
if tmux_rt has-session 2>/dev/null; then
    tmux_rt set -g window-size latest 2>/dev/null
    tmux_rt set -g history-limit 50000 2>/dev/null
    tmux_rt set -g extended-keys always 2>/dev/null
    tmux_rt set -g set-clipboard on 2>/dev/null
    tmux_rt set -g allow-passthrough on 2>/dev/null
    tmux_rt bind-key -n S-Enter send-keys -l $'\033[13;2u' 2>/dev/null
    tmux_rt unbind -T root MouseDrag1Pane 2>/dev/null
    tmux_rt attach
fi
exec bash --rcfile /tmp/rust_terminal_bashrc
"#,
            tty_file
        );
        let _ = std::fs::write(path, script);
    } else {
        let script = format!(
            r#"#!/bin/sh
unset TMUX TMUX_PANE
tty > {} 2>/dev/null
printf '\033]7337;%s\033\\' "$(tty)" 2>/dev/null
tmux_rt() {{
    if [ -n "$RUST_TERMINAL_TMUX_SOCKET" ]; then command tmux -L "$RUST_TERMINAL_TMUX_SOCKET" "$@"; else command tmux "$@"; fi
}}
if tmux_rt has-session 2>/dev/null; then
    tmux_rt set -g window-size latest 2>/dev/null
    tmux_rt set -g history-limit 50000 2>/dev/null
    tmux_rt set -g extended-keys always 2>/dev/null
    tmux_rt set -g set-clipboard on 2>/dev/null
    tmux_rt set -g allow-passthrough on 2>/dev/null
    tmux_rt bind-key -n S-Enter send-keys -l $'\033[13;2u' 2>/dev/null
    tmux_rt unbind -T root MouseDrag1Pane 2>/dev/null
    tmux_rt attach
fi
exec {}
"#,
            tty_file, shell
        );
        let _ = std::fs::write(path, script);
    }

    // Make executable
    let _ = StdCommand::new("chmod").arg("+x").arg(path).output();
}

#[derive(Deserialize)]
struct InitMessage {
    #[serde(default)]
    #[serde(alias = "AuthToken")]
    #[allow(dead_code)]
    auth_token: Option<String>,
    columns: u32,
    rows: u32,
}

#[derive(Deserialize)]
struct ResizeMessage {
    #[serde(alias = "AuthToken")]
    #[serde(default)]
    #[allow(dead_code)]
    auth_token: Option<String>,
    columns: u16,
    rows: u16,
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP API HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── JSON helpers ──────────────────────────────────────────────────────────

fn json_response<T: Serialize>(data: &T) -> Response {
    Json(data).into_response()
}

fn json_error(error: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
        .into_response()
}

// ─── GET /api/health ───────────────────────────────────────────────────────

async fn api_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

// ─── GET /api/client-tty ───────────────────────────────────────────────────

async fn api_client_tty(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let tty = tokio::task::spawn_blocking(move || get_client_tty_from_state(&state))
        .await
        .unwrap_or(None);
    Json(serde_json::json!({ "client_tty": tty }))
}

fn get_client_tty_from_state(state: &AppState) -> Option<String> {
    // First try from our stored state
    if let Ok(lock) = state.client_tty.lock() {
        if let Some(ref tty) = *lock {
            return Some(tty.clone());
        }
    }
    // Fallback: read from file
    get_client_tty_from_file()
}

fn get_client_tty_from_file() -> Option<String> {
    let tty_from_file = std::fs::read_to_string(tty_file_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Verify against current tmux clients
    if let Ok(output) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
        let clients: Vec<&str> = output
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();

        if let Some(ref tty) = tty_from_file {
            if clients.contains(&tty.as_str()) {
                return Some(tty.clone());
            }
        }
        if clients.len() == 1 {
            return Some(clients[0].to_string());
        }
    }

    tty_from_file
}

// ─── GET /api/cwd ──────────────────────────────────────────────────────────

async fn api_cwd(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let (cwd, is_git) = tokio::task::spawn_blocking(move || {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        let is_git = is_git_repo(&cwd);
        (cwd, is_git)
    })
    .await
    .unwrap_or_else(|_| (String::new(), false));
    Json(serde_json::json!({ "cwd": cwd, "is_git": is_git }))
}

fn get_effective_client_tty(state: &AppState, explicit: Option<String>) -> Option<String> {
    explicit.or_else(|| get_client_tty_from_state(state))
}

#[derive(Clone, Default, Deserialize)]
struct TerminalTargetQuery {
    mux: Option<String>,
    pane: Option<String>,
    client_tty: Option<String>,
}

fn resolve_terminal_cwd(
    state: &AppState,
    target: &TerminalTargetQuery,
) -> Result<String, ApiError> {
    match target.mux.as_deref() {
        Some("herdr") => {
            let pane_id = target
                .pane
                .as_deref()
                .filter(|pane| !pane.trim().is_empty())
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        "missing_pane".into(),
                        "pane is required when mux=herdr".into(),
                    )
                })?;
            let snapshot = get_herdr_snapshot(state);
            snapshot
                .get("panes")
                .and_then(serde_json::Value::as_array)
                .and_then(|panes| {
                    panes.iter().find(|pane| {
                        pane.get("pane_id").and_then(serde_json::Value::as_str) == Some(pane_id)
                    })
                })
                .and_then(|pane| {
                    ["foreground_cwd", "cwd"].iter().find_map(|field| {
                        pane.get(field)
                            .and_then(serde_json::Value::as_str)
                            .filter(|path| !path.trim().is_empty())
                            .map(str::to_string)
                    })
                })
                .ok_or_else(|| {
                    (
                        StatusCode::NOT_FOUND,
                        "herdr_pane_cwd_not_found".into(),
                        format!("No working directory available for Herdr pane {}", pane_id),
                    )
                })
        }
        Some("tmux") | None => Ok(get_cwd(get_effective_client_tty(
            state,
            target.client_tty.clone(),
        ))),
        Some(other) => Err((
            StatusCode::BAD_REQUEST,
            "invalid_mux".into(),
            format!("Unsupported terminal multiplexer: {}", other),
        )),
    }
}

fn resolve_git_worktree(
    state: &AppState,
    target: &TerminalTargetQuery,
) -> Result<(String, String), ApiError> {
    let cwd = resolve_terminal_cwd(state, target)?;
    if !is_git_repo(&cwd) {
        return Err((
            StatusCode::BAD_REQUEST,
            "not_git_repo".into(),
            format!("'{}' is not a git repository", cwd),
        ));
    }
    let git_root = get_git_root(&cwd);
    Ok((cwd, git_root))
}

fn register_git_context(state: &AppState, git_root: &str) -> String {
    let mut hasher = DefaultHasher::new();
    git_root.hash(&mut hasher);
    let context = format!("{:016x}", hasher.finish());
    if let Ok(mut contexts) = state.git_contexts.lock() {
        contexts.insert(context.clone(), git_root.to_string());
    }
    context
}

fn get_git_context(state: &AppState, context: &str) -> Option<String> {
    state
        .git_contexts
        .lock()
        .ok()
        .and_then(|contexts| contexts.get(context).cloned())
}

// ─── CWD Detection (priority chain, like Python) ──────────────────────────

fn get_cwd(client_tty: Option<String>) -> String {
    // 1. Tmux pane path
    if let Some(ref tty) = client_tty {
        if let Some(path) = get_tmux_pane_path(tty) {
            return path;
        }
    }

    // 2. CWD file
    if let Ok(content) = std::fs::read_to_string(cwd_file_path()) {
        let path = content.trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }

    // 3. ttyd child process CWD (Linux /proc)
    if Path::new("/proc").is_dir() {
        if let Some(cwd) = get_child_process_cwd() {
            return cwd;
        }
    }

    // 4. Home directory fallback
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

fn get_tmux_pane_path(client_tty: &str) -> Option<String> {
    let path = run_cmd(
        "tmux",
        &[
            "display-message",
            "-c",
            client_tty,
            "-p",
            "#{pane_current_path}",
        ],
    )
    .ok()?;
    let path = path.trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn get_child_process_cwd() -> Option<String> {
    // Find rust-terminal's child processes (the PTY shell)
    let my_pid = std::process::id().to_string();
    if let Ok(output) = run_cmd("pgrep", &["-P", &my_pid]) {
        for child_pid in output.lines() {
            let child_pid = child_pid.trim();
            if child_pid.is_empty() {
                continue;
            }
            let cwd_link = format!("/proc/{}/cwd", child_pid);
            if let Ok(cwd) = std::fs::read_link(&cwd_link) {
                return Some(cwd.to_string_lossy().to_string());
            }
            // Also check children of children (for tmux)
            if let Ok(grandchildren) = run_cmd("pgrep", &["-P", child_pid]) {
                for gc_pid in grandchildren.lines() {
                    let gc_pid = gc_pid.trim();
                    if gc_pid.is_empty() {
                        continue;
                    }
                    let cwd_link = format!("/proc/{}/cwd", gc_pid);
                    if let Ok(cwd) = std::fs::read_link(&cwd_link) {
                        return Some(cwd.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

// ─── Git Operations (subprocess, matching Python exactly) ──────────────────

fn is_git_repo(path: &str) -> bool {
    run_cmd_in("git", &["rev-parse", "--git-dir"], path).is_ok()
}

fn get_git_root(path: &str) -> String {
    run_cmd_in("git", &["rev-parse", "--show-toplevel"], path)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn get_branch(path: &str) -> String {
    run_cmd_in("git", &["rev-parse", "--abbrev-ref", "HEAD"], path)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn get_all_branches(path: &str) -> BranchesResponse {
    let current = get_branch(path);

    let local = run_cmd_in("git", &["branch", "--format=%(refname:short)"], path)
        .map(|s| {
            s.lines()
                .map(|l| l.to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let remote = run_cmd_in("git", &["branch", "-r", "--format=%(refname:short)"], path)
        .map(|s| {
            s.lines()
                .map(|l| l.to_string())
                .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
                .collect()
        })
        .unwrap_or_default();

    BranchesResponse {
        local,
        remote,
        current,
    }
}

fn get_changed_files(git_root: &str) -> Vec<ChangedFile> {
    let output = match run_cmd_in("git", &["diff", "--name-status"], git_root) {
        Ok(o) => o,
        Err(_) => return vec![],
    };

    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() == 2 {
                Some(ChangedFile {
                    status: parts[0].to_string(),
                    filename: parts[1].to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

fn parse_unified_diff(raw: &str, changed_files: &[ChangedFile]) -> DiffResult {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut total_additions: i64 = 0;
    let mut total_deletions: i64 = 0;

    let mut current_filename = String::new();
    let mut current_hunks: Vec<DiffHunk> = Vec::new();
    let mut current_lines: Vec<DiffLine> = Vec::new();
    let mut current_header = String::new();
    let mut file_adds: i64 = 0;
    let mut file_dels: i64 = 0;
    let mut old_line: i64 = 0;
    let mut new_line: i64 = 0;
    let mut is_binary = false;

    let flush_file = |filename: &str,
                      hunks: &mut Vec<DiffHunk>,
                      lines: &mut Vec<DiffLine>,
                      header: &str,
                      adds: i64,
                      dels: i64,
                      binary: bool,
                      files: &mut Vec<DiffFile>,
                      changed: &[ChangedFile]| {
        if !lines.is_empty() {
            hunks.push(DiffHunk {
                header: header.to_string(),
                lines: std::mem::take(lines),
            });
        }
        if !filename.is_empty() {
            let status = changed
                .iter()
                .find(|c| c.filename == filename)
                .map(|c| c.status.clone())
                .unwrap_or_else(|| "M".to_string());
            files.push(DiffFile {
                filename: filename.to_string(),
                status,
                binary,
                additions: adds,
                deletions: dels,
                hunks: std::mem::take(hunks),
            });
        }
    };

    for line in raw.lines() {
        if let Some(name) = line.strip_prefix("+++ b/") {
            current_filename = name.to_string();
        } else if let Some(rest) = line.strip_prefix("--- a/") {
            flush_file(
                &current_filename,
                &mut current_hunks,
                &mut current_lines,
                &current_header,
                file_adds,
                file_dels,
                is_binary,
                &mut files,
                changed_files,
            );
            total_additions += file_adds;
            total_deletions += file_dels;
            current_filename = rest.to_string();
            current_hunks = Vec::new();
            current_lines = Vec::new();
            current_header = String::new();
            file_adds = 0;
            file_dels = 0;
            is_binary = false;
        } else if line.starts_with("--- /dev/null") {
            flush_file(
                &current_filename,
                &mut current_hunks,
                &mut current_lines,
                &current_header,
                file_adds,
                file_dels,
                is_binary,
                &mut files,
                changed_files,
            );
            total_additions += file_adds;
            total_deletions += file_dels;
            current_filename = String::new();
            current_hunks = Vec::new();
            current_lines = Vec::new();
            current_header = String::new();
            file_adds = 0;
            file_dels = 0;
            is_binary = false;
        } else if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("new file")
            || line.starts_with("deleted file")
        {
            continue;
        } else if line.starts_with("Binary files") {
            is_binary = true;
        } else if line.starts_with("@@ ") {
            if !current_lines.is_empty() {
                current_hunks.push(DiffHunk {
                    header: current_header.clone(),
                    lines: std::mem::take(&mut current_lines),
                });
            }
            current_header = line.to_string();
            // Parse @@ -old_start,old_count +new_start,new_count @@
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                old_line = parts[1]
                    .trim_start_matches('-')
                    .split(',')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
                new_line = parts[2]
                    .trim_start_matches('+')
                    .split(',')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
            }
        } else if let Some(content) = line.strip_prefix('+') {
            file_adds += 1;
            current_lines.push(DiffLine {
                line_type: "add".to_string(),
                old_num: None,
                new_num: Some(new_line),
                content: content.to_string(),
            });
            new_line += 1;
        } else if let Some(content) = line.strip_prefix('-') {
            file_dels += 1;
            current_lines.push(DiffLine {
                line_type: "del".to_string(),
                old_num: Some(old_line),
                new_num: None,
                content: content.to_string(),
            });
            old_line += 1;
        } else {
            let content = line.strip_prefix(' ').unwrap_or(line);
            current_lines.push(DiffLine {
                line_type: "ctx".to_string(),
                old_num: Some(old_line),
                new_num: Some(new_line),
                content: content.to_string(),
            });
            old_line += 1;
            new_line += 1;
        }
    }

    flush_file(
        &current_filename,
        &mut current_hunks,
        &mut current_lines,
        &current_header,
        file_adds,
        file_dels,
        is_binary,
        &mut files,
        changed_files,
    );
    total_additions += file_adds;
    total_deletions += file_dels;

    DiffResult {
        summary: DiffSummary {
            total_files: files.len() as i64,
            total_additions,
            total_deletions,
        },
        files,
    }
}

/// Generate a synthetic unified diff for an untracked file (avoids `git add -N` side effects).
fn synthetic_diff_for_new_file(file: &str, git_root: &str) -> String {
    let path = std::path::Path::new(git_root).join(file);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let lines: Vec<&str> = content.lines().collect();
    let count = lines.len();
    let mut diff = format!(
        "diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{count} @@\n"
    );
    for line in &lines {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    diff
}

fn get_untracked_files(git_root: &str) -> Vec<String> {
    run_cmd_in(
        "git",
        &["ls-files", "--others", "--exclude-standard"],
        git_root,
    )
    .unwrap_or_default()
    .lines()
    .filter(|l| !l.is_empty())
    .map(|l| l.to_string())
    .collect()
}

fn get_files_diff(git_root: &str) -> DiffResult {
    let tracked_diff = run_cmd_in("git", &["diff", "-U3"], git_root).unwrap_or_default();

    let untracked = get_untracked_files(git_root);
    let mut combined = tracked_diff;
    let mut untracked_changed: Vec<ChangedFile> = Vec::new();
    for file in &untracked {
        combined.push_str(&synthetic_diff_for_new_file(file, git_root));
        untracked_changed.push(ChangedFile {
            status: "A".to_string(),
            filename: file.clone(),
        });
    }

    let mut changed_files = get_changed_files(git_root);
    changed_files.extend(untracked_changed);
    parse_unified_diff(&combined, &changed_files)
}

// ─── GET /api/diff ─────────────────────────────────────────────────────────

async fn api_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, ApiError> {
        let (cwd, git_root) = resolve_git_worktree(&state, &target)?;
        let branch = get_branch(&git_root);
        let diff_data = get_files_diff(&git_root);
        Ok(serde_json::json!({
            "cwd": cwd,
            "git_root": git_root,
            "branch": branch,
            "files": diff_data.files,
            "summary": diff_data.summary,
        }))
    })
    .await;
    match outcome {
        Ok(Ok(payload)) => Json(payload).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/git/branches ─────────────────────────────────────────────────

async fn api_git_branches(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<BranchesResponse, ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        Ok(get_all_branches(&git_root))
    })
    .await;

    match outcome {
        Ok(Ok(branches)) => json_response(&branches),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/git/checkout ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct CheckoutQuery {
    branch: Option<String>,
    #[serde(flatten)]
    target: TerminalTargetQuery,
}

async fn api_git_checkout(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<CheckoutQuery>,
) -> Response {
    let branch = match query.branch {
        Some(b) if !b.is_empty() => b,
        _ => {
            return json_error(
                "missing_branch",
                "Branch name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let target = query.target;

    let outcome = tokio::task::spawn_blocking({
        let branch = branch.clone();
        move || -> Result<(), ApiError> {
            let (_, git_root) = resolve_git_worktree(&state, &target)?;
            run_cmd_in("git", &["checkout", &branch], &git_root)
                .map(|_| ())
                .map_err(|msg| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "checkout_failed".into(),
                        msg,
                    )
                })
        }
    })
    .await;

    match outcome {
        Ok(Ok(())) => {
            Json(serde_json::json!({ "success": true, "branch": branch })).into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/git/status ───────────────────────────────────────────────────

#[derive(Serialize)]
struct StatusFile {
    file: String,
    status: String,
}

#[derive(Serialize)]
struct GitStatusResponse {
    staged: Vec<StatusFile>,
    unstaged: Vec<StatusFile>,
    branch: String,
}

fn parse_porcelain_status(output: &str) -> (Vec<StatusFile>, Vec<StatusFile>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let file = line[3..].to_string();

        if x != ' ' && x != '?' && x != '!' {
            let status = match x {
                'M' => "M",
                'A' => "A",
                'D' => "D",
                'R' => "R",
                'C' => "C",
                _ => "M",
            };
            staged.push(StatusFile {
                file: file.clone(),
                status: status.to_string(),
            });
        }

        if y != ' ' && y != '!' {
            let status = match y {
                'M' => "M",
                'D' => "D",
                '?' => "U",
                _ => "M",
            };
            unstaged.push(StatusFile {
                file: file.clone(),
                status: status.to_string(),
            });
        }
    }

    (staged, unstaged)
}

async fn api_git_status(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<GitStatusResponse, ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        let branch = get_branch(&git_root);
        let output =
            run_cmd_in("git", &["status", "--porcelain=v1"], &git_root).unwrap_or_default();
        let (staged, unstaged) = parse_porcelain_status(&output);
        Ok(GitStatusResponse {
            staged,
            unstaged,
            branch,
        })
    })
    .await;

    match outcome {
        Ok(Ok(s)) => json_response(&s),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/git/stage ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitFilesRequest {
    files: Option<Vec<String>>,
    all: Option<bool>,
}

async fn api_git_stage(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
    Json(body): Json<GitFilesRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        let res = if body.all.unwrap_or(false) {
            run_cmd_in("git", &["add", "-A"], &git_root)
        } else if let Some(files) = &body.files {
            if files.is_empty() {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "stage_failed".into(),
                    "No files specified".into(),
                ));
            }
            let args: Vec<&str> = std::iter::once("add")
                .chain(files.iter().map(|s| s.as_str()))
                .collect();
            run_cmd_in("git", &args, &git_root)
        } else {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "stage_failed".into(),
                "No files specified".into(),
            ));
        };
        res.map(|_| ()).map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "stage_failed".into(),
                msg,
            )
        })
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/git/unstage ────────────────────────────────────────────────

async fn api_git_unstage(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
    Json(body): Json<GitFilesRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        let res = if body.all.unwrap_or(false) {
            run_cmd_in("git", &["reset", "HEAD"], &git_root)
        } else if let Some(files) = &body.files {
            if files.is_empty() {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unstage_failed".into(),
                    "No files specified".into(),
                ));
            }
            let args: Vec<&str> = std::iter::once("reset")
                .chain(std::iter::once("HEAD"))
                .chain(files.iter().map(|s| s.as_str()))
                .collect();
            run_cmd_in("git", &args, &git_root)
        } else {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "unstage_failed".into(),
                "No files specified".into(),
            ));
        };
        res.map(|_| ()).map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "unstage_failed".into(),
                msg,
            )
        })
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/git/discard ────────────────────────────────────────────────

async fn api_git_discard(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
    Json(body): Json<GitFilesRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        let files = match &body.files {
            Some(f) if !f.is_empty() => f,
            _ => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "discard_failed".into(),
                    "No files specified".into(),
                ))
            }
        };
        for file in files {
            let is_tracked =
                run_cmd_in("git", &["ls-files", "--error-unmatch", file], &git_root).is_ok();
            if is_tracked {
                let _ = run_cmd_in("git", &["checkout", "--", file], &git_root);
            } else {
                let path = std::path::Path::new(&git_root).join(file);
                if path.exists() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        Ok(())
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/git/commit ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitCommitRequest {
    message: String,
}

async fn api_git_commit(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
    Json(body): Json<GitCommitRequest>,
) -> Response {
    if body.message.trim().is_empty() {
        return json_error(
            "empty_message",
            "Commit message required",
            StatusCode::BAD_REQUEST,
        );
    }

    let outcome = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        run_cmd_in("git", &["commit", "-m", &body.message], &git_root).map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "commit_failed".into(),
                msg,
            )
        })
    })
    .await;

    match outcome {
        Ok(Ok(output)) => Json(serde_json::json!({
            "success": true,
            "output": output.trim(),
        }))
        .into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/git/log ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct GitLogEntry {
    hash: String,
    message: String,
    author: String,
    date: String,
    context: String,
}

#[derive(Deserialize)]
struct GitLogQuery {
    count: Option<usize>,
    #[serde(flatten)]
    target: TerminalTargetQuery,
}

async fn api_git_log(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<GitLogQuery>,
) -> Response {
    let count = query.count.unwrap_or(50).min(200);
    let target = query.target;
    let outcome = tokio::task::spawn_blocking(move || -> Result<Vec<GitLogEntry>, ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        let context = register_git_context(&state, &git_root);
        let format = "%H\x1f%s\x1f%an\x1f%cr";
        let output = run_cmd_in(
            "git",
            &[
                "log",
                &format!("--max-count={}", count),
                &format!("--format={}", format),
            ],
            &git_root,
        )
        .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "log_failed".into(), msg))?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(4, '\x1f').collect();
                if parts.len() == 4 {
                    Some(GitLogEntry {
                        hash: parts[0][..7.min(parts[0].len())].to_string(),
                        message: parts[1].to_string(),
                        author: parts[2].to_string(),
                        date: parts[3].to_string(),
                        context: context.clone(),
                    })
                } else {
                    None
                }
            })
            .collect())
    })
    .await;

    match outcome {
        Ok(Ok(entries)) => json_response(&entries),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/git/commit-diff ──────────────────────────────────────────────

#[derive(Deserialize)]
struct CommitDiffQuery {
    hash: String,
    context: Option<String>,
    #[serde(flatten)]
    target: TerminalTargetQuery,
}

async fn api_git_commit_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<CommitDiffQuery>,
) -> Response {
    if query.hash.trim().is_empty() {
        return json_error(
            "missing_hash",
            "Commit hash required",
            StatusCode::BAD_REQUEST,
        );
    }

    let outcome = tokio::task::spawn_blocking(move || -> Result<DiffResult, ApiError> {
        let git_root = if let Some(context) = query.context.as_deref() {
            get_git_context(&state, context).ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    "git_context_not_found".into(),
                    "Git context expired; refresh the commit list".into(),
                )
            })?
        } else {
            resolve_git_worktree(&state, &query.target)?.1
        };
        if !is_git_repo(&git_root) {
            return Err((
                StatusCode::NOT_FOUND,
                "git_context_not_found".into(),
                "Git context expired; refresh the commit list".into(),
            ));
        }
        let revision = format!("{}^{{commit}}", query.hash.trim());
        let commit =
            run_cmd_in("git", &["rev-parse", "--verify", &revision], &git_root).map_err(|_| {
                (
                    StatusCode::NOT_FOUND,
                    "commit_not_found".into(),
                    "Commit not found".into(),
                )
            })?;
        let commit = commit.trim();

        let name_status = run_cmd_in(
            "git",
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-r",
                "-M",
                commit,
            ],
            &git_root,
        )
        .map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "commit_diff_failed".into(),
                msg,
            )
        })?;
        let changed_files = name_status
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\t').collect();
                let status = parts.first()?.chars().next()?.to_string();
                let filename = parts.last()?.to_string();
                Some(ChangedFile { status, filename })
            })
            .collect::<Vec<_>>();

        let raw = run_cmd_in(
            "git",
            &[
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-color",
                "--find-renames",
                "-U3",
                commit,
                "--",
            ],
            &git_root,
        )
        .map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "commit_diff_failed".into(),
                msg,
            )
        })?;

        Ok(parse_unified_diff(&raw, &changed_files))
    })
    .await;

    match outcome {
        Ok(Ok(diff)) => json_response(&diff),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/git/file-diff ────────────────────────────────────────────────

#[derive(Deserialize)]
struct FileDiffQuery {
    file: String,
    staged: Option<bool>,
    #[serde(flatten)]
    target: TerminalTargetQuery,
}

async fn api_git_file_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<FileDiffQuery>,
) -> Response {
    if query.file.is_empty() {
        return json_error(
            "missing_file",
            "File path required",
            StatusCode::BAD_REQUEST,
        );
    }

    let outcome = tokio::task::spawn_blocking(move || -> Result<DiffResult, ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &query.target)?;
        let file = query.file.clone();
        let is_staged = query.staged.unwrap_or(false);
        if is_staged {
            let raw = run_cmd_in("git", &["diff", "--cached", "-U3", "--", &file], &git_root)
                .unwrap_or_default();
            let changed = vec![ChangedFile {
                status: "M".to_string(),
                filename: file,
            }];
            Ok(parse_unified_diff(&raw, &changed))
        } else {
            let is_untracked =
                run_cmd_in("git", &["ls-files", "--error-unmatch", &file], &git_root).is_err();
            if is_untracked {
                let raw = synthetic_diff_for_new_file(&file, &git_root);
                let changed = vec![ChangedFile {
                    status: "A".to_string(),
                    filename: file,
                }];
                Ok(parse_unified_diff(&raw, &changed))
            } else {
                let raw =
                    run_cmd_in("git", &["diff", "-U3", "--", &file], &git_root).unwrap_or_default();
                let changed = vec![ChangedFile {
                    status: "M".to_string(),
                    filename: file,
                }];
                Ok(parse_unified_diff(&raw, &changed))
            }
        }
    })
    .await;

    match outcome {
        Ok(Ok(diff)) => {
            let file_diff = diff.files.into_iter().next();
            match file_diff {
                Some(f) => json_response(&f),
                None => Json(serde_json::json!({ "hunks": [], "additions": 0, "deletions": 0 }))
                    .into_response(),
            }
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/git/batch-file-diff ─────────────────────────────────────────

#[derive(Deserialize)]
struct BatchFileDiffRequest {
    files: Vec<BatchFileDiffEntry>,
}

#[derive(Deserialize)]
struct BatchFileDiffEntry {
    file: String,
    staged: bool,
}

async fn api_git_batch_file_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
    Json(body): Json<BatchFileDiffRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;

        let mut results = serde_json::Map::new();
        for entry in &body.files {
            let diff = if entry.staged {
                let raw = run_cmd_in(
                    "git",
                    &["diff", "--cached", "-U3", "--", &entry.file],
                    &git_root,
                )
                .unwrap_or_default();
                let changed = vec![ChangedFile {
                    status: "M".to_string(),
                    filename: entry.file.clone(),
                }];
                parse_unified_diff(&raw, &changed)
            } else {
                let is_untracked = run_cmd_in(
                    "git",
                    &["ls-files", "--error-unmatch", &entry.file],
                    &git_root,
                )
                .is_err();
                if is_untracked {
                    let raw = synthetic_diff_for_new_file(&entry.file, &git_root);
                    let changed = vec![ChangedFile {
                        status: "A".to_string(),
                        filename: entry.file.clone(),
                    }];
                    parse_unified_diff(&raw, &changed)
                } else {
                    let raw = run_cmd_in("git", &["diff", "-U3", "--", &entry.file], &git_root)
                        .unwrap_or_default();
                    let changed = vec![ChangedFile {
                        status: "M".to_string(),
                        filename: entry.file.clone(),
                    }];
                    parse_unified_diff(&raw, &changed)
                }
            };
            let file_diff = diff.files.into_iter().next();
            let value = match file_diff {
                Some(f) => serde_json::to_value(&f).unwrap_or(serde_json::json!(null)),
                None => serde_json::json!({ "hunks": [], "additions": 0, "deletions": 0 }),
            };
            results.insert(entry.file.clone(), value);
        }
        Ok(serde_json::Value::Object(results))
    })
    .await;

    match outcome {
        Ok(Ok(val)) => Json(val).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/git/stage-hunk ──────────────────────────────────────────────

#[derive(Deserialize)]
struct HunkPatchRequest {
    patch: String,
}

async fn api_git_stage_hunk(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
    Json(body): Json<HunkPatchRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        apply_patch(&git_root, &body.patch, &["apply", "--cached"])
            .map(|_| ())
            .map_err(|msg| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "stage_hunk_failed".into(),
                    msg,
                )
            })
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/git/discard-hunk ────────────────────────────────────────────

async fn api_git_discard_hunk(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(target): Query<TerminalTargetQuery>,
    Json(body): Json<HunkPatchRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let (_, git_root) = resolve_git_worktree(&state, &target)?;
        apply_patch(&git_root, &body.patch, &["apply", "--reverse"])
            .map(|_| ())
            .map_err(|msg| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "discard_hunk_failed".into(),
                    msg,
                )
            })
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

fn apply_patch(git_root: &str, patch: &str, args: &[&str]) -> Result<String, String> {
    use std::io::Write;

    let mut child = StdCommand::new("git")
        .args(args)
        .current_dir(git_root)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    child
        .stdin
        .take()
        .unwrap()
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// ─── Tmux Operations ──────────────────────────────────────────────────────

// ─── GET /api/herdr/list ──────────────────────────────────────────────────

async fn api_herdr_list(axum::extract::State(state): axum::extract::State<AppState>) -> Response {
    match herdr::list().await {
        Ok(payload) => {
            publish_herdr_snapshot(&state, payload.clone(), None);
            Json(payload).into_response()
        }
        Err(error) => {
            tracing::warn!("Failed to list herdr panes: {}", error);
            json_error("herdr_unavailable", &error, StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

#[derive(Deserialize)]
struct HerdrPaneQuery {
    pane: Option<String>,
}

#[derive(Deserialize)]
struct HerdrCreateQuery {
    name: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct HerdrCloseQuery {
    pane: Option<String>,
    workspace: Option<String>,
}

#[derive(Deserialize)]
struct HerdrQuickShellQuery {
    pane: Option<String>,
    cwd: Option<String>,
    direction: Option<String>,
}

#[derive(Deserialize)]
struct HerdrPaneModeQuery {
    pane: Option<String>,
    mode: Option<String>,
}

#[derive(Deserialize)]
struct HerdrCaptureQuery {
    pane: Option<String>,
    lines: Option<u32>,
}

#[derive(Deserialize)]
struct HerdrPageQuery {
    pane: Option<String>,
    page: Option<u32>,
}

#[derive(Deserialize)]
struct HerdrPasteRequest {
    text: String,
}

async fn api_herdr_focus(Query(query): Query<HerdrPaneQuery>) -> Response {
    let pane_id = match required_herdr_pane(query.pane) {
        Ok(pane_id) => pane_id,
        Err(()) => return missing_herdr_pane_response(),
    };
    match herdr::request("pane.focus", serde_json::json!({ "pane_id": pane_id })).await {
        Ok(result) => Json(serde_json::json!({
            "success": true,
            "paneId": pane_id,
            "result": result,
        }))
        .into_response(),
        Err(error) => herdr_operation_error("focus_failed", error),
    }
}

// ─── POST /api/herdr/paste ─────────────────────────────────────────────────────

async fn api_herdr_paste(
    Query(query): Query<HerdrPaneQuery>,
    Json(body): Json<HerdrPasteRequest>,
) -> Response {
    let pane_id = match required_herdr_pane(query.pane) {
        Ok(pane_id) => pane_id,
        Err(()) => return missing_herdr_pane_response(),
    };
    if body.text.is_empty() {
        return json_error(
            "missing_text",
            "paste text is required",
            StatusCode::BAD_REQUEST,
        );
    }

    let byte_length = body.text.len();
    match herdr::request(
        "pane.send_text",
        serde_json::json!({
            "pane_id": pane_id,
            "text": bracketed_paste_text(&body.text),
        }),
    )
    .await
    {
        Ok(result) => Json(serde_json::json!({
            "success": true,
            "paneId": pane_id,
            "byteLength": byte_length,
            "result": result,
        }))
        .into_response(),
        Err(error) => herdr_operation_error("paste_failed", error),
    }
}

fn bracketed_paste_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\r").replace('\n', "\r");
    format!("\x1b[200~{}\x1b[201~", normalized)
}

async fn api_herdr_create(Query(query): Query<HerdrCreateQuery>) -> Response {
    let name = match query.name.filter(|name| !name.trim().is_empty()) {
        Some(name) => name,
        None => {
            return json_error(
                "missing_name",
                "Workspace name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let mut params = serde_json::json!({
        "label": name,
        "focus": true,
    });
    if let Some(cwd) = query.cwd.filter(|cwd| !cwd.trim().is_empty()) {
        params["cwd"] = serde_json::Value::String(cwd);
    }
    match herdr::request("workspace.create", params).await {
        Ok(result) => Json(serde_json::json!({
            "success": true,
            "paneId": find_herdr_pane_id(&result),
            "result": result,
        }))
        .into_response(),
        Err(error) => herdr_operation_error("create_failed", error),
    }
}

async fn api_herdr_close(Query(query): Query<HerdrCloseQuery>) -> Response {
    let (method, params, target) = match (query.pane, query.workspace) {
        (Some(pane_id), None) if !pane_id.trim().is_empty() => (
            "pane.close",
            serde_json::json!({ "pane_id": pane_id }),
            pane_id,
        ),
        (None, Some(workspace_id)) if !workspace_id.trim().is_empty() => (
            "workspace.close",
            serde_json::json!({ "workspace_id": workspace_id }),
            workspace_id,
        ),
        _ => {
            return json_error(
                "missing_target",
                "Exactly one pane or workspace target is required",
                StatusCode::BAD_REQUEST,
            )
        }
    };
    match herdr::request(method, params).await {
        Ok(result) => Json(serde_json::json!({
            "success": true,
            "target": target,
            "result": result,
        }))
        .into_response(),
        Err(error) => herdr_operation_error("close_failed", error),
    }
}

async fn api_herdr_release(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<HerdrPaneQuery>,
) -> Response {
    let pane_id = match required_herdr_pane(query.pane) {
        Ok(pane_id) => pane_id,
        Err(()) => return missing_herdr_pane_response(),
    };
    match active_herdr_controller(&state, &pane_id) {
        Some(sender) => match sender.send(HerdrInput::Release).await {
            Ok(()) => {
                Json(serde_json::json!({ "success": true, "paneId": pane_id })).into_response()
            }
            Err(error) => herdr_operation_error("release_failed", error.to_string()),
        },
        None => json_error(
            "controller_not_found",
            "No active rust-terminal controller for this pane",
            StatusCode::CONFLICT,
        ),
    }
}

async fn api_herdr_quick_shell(Query(query): Query<HerdrQuickShellQuery>) -> Response {
    let pane_id = match required_herdr_pane(query.pane) {
        Ok(pane_id) => pane_id,
        Err(()) => return missing_herdr_pane_response(),
    };
    let direction = query.direction.unwrap_or_else(|| "right".to_string());
    if direction != "right" && direction != "down" {
        return json_error(
            "invalid_direction",
            "direction must be right or down",
            StatusCode::BAD_REQUEST,
        );
    }
    let mut params = serde_json::json!({
        "target_pane_id": pane_id,
        "direction": direction,
        "focus": true,
    });
    if let Some(cwd) = query.cwd.filter(|cwd| !cwd.trim().is_empty()) {
        params["cwd"] = serde_json::Value::String(cwd);
    }
    match herdr::request("pane.split", params).await {
        Ok(result) => Json(serde_json::json!({
            "success": true,
            "mode": "split",
            "paneId": find_herdr_pane_id(&result),
            "result": result,
        }))
        .into_response(),
        Err(error) => herdr_operation_error("quick_shell_failed", error),
    }
}

async fn api_herdr_pane_mode(Query(query): Query<HerdrPaneModeQuery>) -> Response {
    let pane_id = match required_herdr_pane(query.pane) {
        Ok(pane_id) => pane_id,
        Err(()) => return missing_herdr_pane_response(),
    };
    let mode = query.mode.unwrap_or_else(|| "toggle".to_string());
    if !matches!(mode.as_str(), "toggle" | "on" | "off") {
        return json_error(
            "invalid_mode",
            "mode must be toggle, on, or off",
            StatusCode::BAD_REQUEST,
        );
    }
    match herdr::request(
        "pane.zoom",
        serde_json::json!({ "pane_id": pane_id, "mode": mode }),
    )
    .await
    {
        Ok(result) => Json(serde_json::json!({
            "success": true,
            "paneId": pane_id,
            "mode": mode,
            "result": result,
        }))
        .into_response(),
        Err(error) => herdr_operation_error("pane_mode_failed", error),
    }
}

async fn api_herdr_capture_pane(Query(query): Query<HerdrCaptureQuery>) -> Response {
    let pane_id = match required_herdr_pane(query.pane) {
        Ok(pane_id) => pane_id,
        Err(()) => return missing_herdr_pane_response(),
    };
    let lines = query.lines.unwrap_or(1000).clamp(1, 10000);
    match herdr::request(
        "pane.read",
        serde_json::json!({
            "pane_id": pane_id,
            "source": "recent",
            "lines": lines,
            "strip_ansi": true,
            "format": "text",
        }),
    )
    .await
    {
        Ok(result) => {
            let text = result
                .get("read")
                .and_then(|read| read.get("text"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            Json(serde_json::json!({
                "lines": text.lines().collect::<Vec<_>>(),
                "paneId": pane_id,
                "result": result,
            }))
            .into_response()
        }
        Err(error) => herdr_operation_error("capture_failed", error),
    }
}

async fn api_herdr_page_up(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<HerdrPageQuery>,
) -> Response {
    let pane_id = match required_herdr_pane(query.pane) {
        Ok(pane_id) => pane_id,
        Err(()) => return missing_herdr_pane_response(),
    };
    let page = query.page.unwrap_or(1).clamp(1, 100);
    let scroll_lines = page.saturating_mul(24);
    let sender = match active_herdr_controller(&state, &pane_id) {
        Some(sender) => sender,
        None => {
            return json_error(
                "controller_not_found",
                "No active rust-terminal controller for this pane",
                StatusCode::CONFLICT,
            )
        }
    };
    if let Err(error) = sender
        .send(HerdrInput::Scroll {
            direction: "up".to_string(),
            lines: scroll_lines,
        })
        .await
    {
        return herdr_operation_error("scroll_failed", error.to_string());
    }
    let capture_lines = page.saturating_mul(200).clamp(1, 10000);
    match herdr::request(
        "pane.read",
        serde_json::json!({
            "pane_id": pane_id,
            "source": "recent",
            "lines": capture_lines,
            "strip_ansi": true,
            "format": "text",
        }),
    )
    .await
    {
        Ok(result) => {
            let text = result
                .get("read")
                .and_then(|read| read.get("text"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            Json(serde_json::json!({
                "success": true,
                "paneId": pane_id,
                "page": page,
                "lines": text.lines().collect::<Vec<_>>(),
            }))
            .into_response()
        }
        Err(error) => herdr_operation_error("scroll_failed", error),
    }
}

fn required_herdr_pane(pane: Option<String>) -> Result<String, ()> {
    pane.filter(|pane| !pane.trim().is_empty()).ok_or(())
}

fn missing_herdr_pane_response() -> Response {
    json_error("missing_pane", "pane is required", StatusCode::BAD_REQUEST)
}

fn active_herdr_controller(state: &AppState, pane_id: &str) -> Option<mpsc::Sender<HerdrInput>> {
    state
        .herdr_controllers
        .lock()
        .ok()
        .and_then(|controllers| controllers.get(pane_id).cloned())
}

fn herdr_operation_error(code: &str, error: String) -> Response {
    tracing::warn!("herdr operation failed: {}", error);
    json_error(code, &error, StatusCode::BAD_GATEWAY)
}

fn find_herdr_pane_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(pane_id) = object.get("pane_id").and_then(serde_json::Value::as_str) {
                return Some(pane_id.to_string());
            }
            object.values().find_map(find_herdr_pane_id)
        }
        serde_json::Value::Array(values) => values.iter().find_map(find_herdr_pane_id),
        _ => None,
    }
}

fn get_current_tmux_session(client_tty: Option<&str>) -> Option<String> {
    let tty = client_tty?;

    let output = run_cmd(
        "tmux",
        &["list-clients", "-F", "#{client_tty} #{client_session}"],
    )
    .ok()?;

    for line in output.lines() {
        let parts: Vec<&str> = line.trim().splitn(2, ' ').collect();
        if parts.len() == 2 && parts[0] == tty {
            return Some(parts[1].to_string());
        }
    }
    None
}

// ─── GET /api/tmux/list ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxQuery {
    client_tty: Option<String>,
}

async fn api_tmux_list(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxQuery>,
) -> Json<serde_json::Value> {
    let payload = tokio::task::spawn_blocking(move || {
        let snapshot = get_tmux_snapshot(&state);
        let client_tty = get_effective_client_tty(&state, query.client_tty);
        let current = get_current_tmux_session(client_tty.as_deref());
        serde_json::json!({
            "sessions": snapshot.sessions,
            "currentSession": current,
            "scannedAt": snapshot.scanned_at,
            "projectGroups": snapshot.project_groups,
            "otherSessions": snapshot.other_sessions,
        })
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({ "sessions": [], "currentSession": null }));
    Json(payload)
}

// ─── GET /api/tmux/switch ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxSwitchQuery {
    session: Option<String>,
    client_tty: Option<String>,
}

async fn api_tmux_switch(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxSwitchQuery>,
) -> Response {
    let session = match query.session {
        Some(s) if !s.is_empty() => s,
        _ => {
            return json_error(
                "missing_session",
                "Session name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let operation_state = state.clone();
    let outcome: Result<Result<(), ApiError>, _> = tokio::task::spawn_blocking(move || {
        let client_tty = match get_effective_client_tty(&operation_state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "missing_client_tty".into(),
                    "client_tty required".into(),
                ));
            }
        };
        if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
            if !clients.contains(&client_tty) {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "switch_failed".into(),
                    format!("Client {} not attached to tmux", client_tty),
                ));
            }
        }
        run_cmd(
            "tmux",
            &["switch-client", "-c", &client_tty, "-t", &session],
        )
        .map(|_| ())
        .map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "switch_failed".into(),
                msg,
            )
        })
    })
    .await;

    match outcome {
        Ok(Ok(())) => {
            trigger_tmux_scan(&state);
            Json(serde_json::json!({ "success": true })).into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/tmux/create ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxCreateQuery {
    name: Option<String>,
    client_tty: Option<String>,
    cwd: Option<String>,
}

async fn api_tmux_create(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxCreateQuery>,
) -> Response {
    let name = match query.name {
        Some(n) if !n.is_empty() => n,
        _ => {
            return json_error(
                "missing_name",
                "Session name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let operation_state = state.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        let client_tty = match get_effective_client_tty(&operation_state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "missing_client_tty".into(),
                    "client_tty required".into(),
                ));
            }
        };
        let create_result = if let Some(cwd) = query.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
            run_cmd("tmux", &["new-session", "-d", "-s", &name, "-c", cwd])
        } else {
            run_cmd("tmux", &["new-session", "-d", "-s", &name])
        };
        create_result.map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "create_failed".into(),
                msg,
            )
        })?;
        run_cmd("tmux", &["switch-client", "-c", &client_tty, "-t", &name])
            .map(|_| name)
            .map_err(|msg| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "create_failed".into(),
                    msg,
                )
            })
    })
    .await;

    match outcome {
        Ok(Ok(name)) => {
            trigger_tmux_scan(&state);
            Json(serde_json::json!({
                "success": true,
                "message": format!("Session '{}' created", name),
            }))
            .into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/tmux/kill ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxKillQuery {
    name: Option<String>,
}

async fn api_tmux_kill(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxKillQuery>,
) -> Response {
    let name = match query.name {
        Some(n) if !n.is_empty() => n,
        _ => {
            return json_error(
                "missing_name",
                "Session name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let result = tokio::task::spawn_blocking({
        let name = name.clone();
        move || run_cmd("tmux", &["kill-session", "-t", &name])
    })
    .await;

    match result {
        Ok(Ok(_)) => {
            trigger_tmux_scan(&state);
            Json(serde_json::json!({
                "success": true,
                "message": format!("Session '{}' killed", name),
            }))
            .into_response()
        }
        Ok(Err(_)) => json_error(
            "kill_failed",
            &format!("Failed to kill session '{}'", name),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/tmux/detach ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxDetachQuery {
    client_tty: Option<String>,
}

async fn api_tmux_detach(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxDetachQuery>,
) -> Response {
    let operation_state = state.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let client_tty = match get_effective_client_tty(&operation_state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "missing_client_tty".into(),
                    "client_tty required".into(),
                ));
            }
        };
        if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
            if !clients.contains(&client_tty) {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "detach_failed".into(),
                    format!("Client {} not attached to tmux", client_tty),
                ));
            }
        }
        run_cmd("tmux", &["detach-client", "-t", &client_tty])
            .map(|_| ())
            .map_err(|msg| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "detach_failed".into(),
                    msg,
                )
            })
    })
    .await;

    match outcome {
        Ok(Ok(())) => {
            trigger_tmux_scan(&state);
            Json(serde_json::json!({ "success": true })).into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/tmux/quick-shell ─────────────────────────────────────────────

async fn api_tmux_quick_shell(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxDetachQuery>,
) -> Response {
    let client_tty = match query.client_tty {
        Some(tty) if !tty.is_empty() => tty,
        _ => {
            return json_error(
                "missing_client_tty",
                "client_tty required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let operation_state = state.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<(String, String), ApiError> {
        if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
            if !clients.contains(&client_tty) {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "quick_shell_failed".into(),
                    format!("Client {} not attached to tmux", client_tty),
                ));
            }
        }

        let cwd = get_tmux_pane_path(&client_tty)
            .or_else(|| Some(get_cwd(Some(client_tty.clone()))))
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

        let shell_command = format!("exec {}", operation_state.shell);

        if tmux_supports_display_popup() {
            let popup_args = [
                "display-popup",
                "-E",
                "-w",
                "90%",
                "-h",
                "80%",
                "-c",
                client_tty.as_str(),
                "-d",
                cwd.as_str(),
                "-T",
                " Quick Shell — exit to return ",
                shell_command.as_str(),
            ];

            match spawn_detached_cmd("tmux", &popup_args) {
                Ok(_) => return Ok(("popup".to_string(), cwd)),
                Err(msg) => {
                    tracing::warn!("Quick Shell popup failed, falling back to window: {}", msg);
                }
            }
        }

        let session = match get_current_tmux_session(Some(&client_tty)) {
            Some(session) => session,
            None => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "quick_shell_failed".into(),
                    "No active tmux session found for this client".into(),
                ));
            }
        };

        run_cmd(
            "tmux",
            &[
                "new-window",
                "-t",
                &session,
                "-c",
                &cwd,
                "-n",
                "Quick Shell",
                &shell_command,
            ],
        )
        .map(|_| ("window".to_string(), cwd))
        .map_err(|msg| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "quick_shell_failed".into(),
                msg,
            )
        })
    })
    .await;

    match outcome {
        Ok(Ok((mode, cwd))) => {
            trigger_tmux_scan(&state);
            Json(serde_json::json!({
                "success": true,
                "mode": mode,
                "cwd": cwd,
            }))
            .into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error(
            "internal_error",
            "Task failed",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/tmux/pane-mode ───────────────────────────────────────────────

async fn api_tmux_pane_mode(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxQuery>,
) -> Json<serde_json::Value> {
    let tui_active = tokio::task::spawn_blocking(move || {
        let client_tty = get_effective_client_tty(&state, query.client_tty);
        let session = client_tty
            .as_deref()
            .and_then(|t| get_current_tmux_session(Some(t)));
        match session {
            Some(ref sess) => run_cmd(
                "tmux",
                &[
                    "display-message",
                    "-t",
                    &format!("{}:", sess),
                    "-p",
                    "#{alternate_on}",
                ],
            )
            .map(|s| s.trim() == "1")
            .unwrap_or(false),
            None => run_cmd("tmux", &["display-message", "-p", "#{alternate_on}"])
                .map(|s| s.trim() == "1")
                .unwrap_or(false),
        }
    })
    .await
    .unwrap_or(false);

    Json(serde_json::json!({ "tuiActive": tui_active }))
}

// ─── GET /api/tmux/capture-pane ────────────────────────────────────────────

async fn api_tmux_capture_pane(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxQuery>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        let client_tty = match get_effective_client_tty(&state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "no_tty".into(),
                    "No client TTY available".into(),
                ));
            }
        };
        let session = match get_current_tmux_session(Some(&client_tty)) {
            Some(s) => s,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "no_session".into(),
                    "No tmux session found".into(),
                ));
            }
        };
        let target = format!("{}:", session);
        run_cmd("tmux", &["capture-pane", "-t", &target, "-pS", "-"]).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "capture_failed".into(),
                e,
            )
        })
    })
    .await;

    match outcome {
        Ok(Ok(content)) => {
            let lines: Vec<&str> = content.lines().collect();
            Json(serde_json::json!({ "lines": lines })).into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(e) => json_error(
            "task_failed",
            &format!("{}", e),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/tmux/page-up ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct PageUpQuery {
    client_tty: Option<String>,
    page: Option<i32>,
}

async fn api_tmux_page_up(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<PageUpQuery>,
) -> Response {
    let page = query.page.unwrap_or(1).max(1);
    let outcome =
        tokio::task::spawn_blocking(move || -> Result<(Vec<String>, i32, i32), ApiError> {
            let client_tty = match get_effective_client_tty(&state, query.client_tty) {
                Some(t) => t,
                None => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "no_tty".into(),
                        "No client TTY available".into(),
                    ))
                }
            };
            let session = match get_current_tmux_session(Some(&client_tty)) {
                Some(s) => s,
                None => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "no_session".into(),
                        "No tmux session found".into(),
                    ))
                }
            };
            let target = format!("{}:", session);
            let info = run_cmd(
                "tmux",
                &[
                    "display-message",
                    "-t",
                    &target,
                    "-p",
                    "#{pane_height} #{history_size}",
                ],
            )
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "capture_failed".into(),
                    e,
                )
            })?;
            let parts: Vec<&str> = info.trim().split(' ').collect();
            let rows: i32 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(40);
            let history: i32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);

            if history == 0 {
                return Ok((Vec::new(), 0, 0));
            }

            let end_line = -((page - 1) * rows + 1);
            let start_line = -(page * rows);
            let clamped_start = start_line.max(-history);

            if clamped_start > end_line {
                return Ok((Vec::new(), history, rows));
            }

            let content = run_cmd(
                "tmux",
                &[
                    "capture-pane",
                    "-t",
                    &target,
                    "-p",
                    "-S",
                    &clamped_start.to_string(),
                    "-E",
                    &end_line.to_string(),
                ],
            )
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "capture_failed".into(),
                    e,
                )
            })?;

            let lines: Vec<String> = content.lines().map(String::from).collect();
            Ok((lines, history, rows))
        })
        .await;

    match outcome {
        Ok(Ok((lines, history, rows))) => {
            Json(serde_json::json!({ "lines": lines, "history": history, "rows": rows }))
                .into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(e) => json_error(
            "task_failed",
            &format!("{}", e),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET /api/events (SSE) ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct EventsQuery {
    client_tty: Option<String>,
    mux: Option<String>,
    #[allow(dead_code)]
    pane: Option<String>,
}

async fn api_events(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<EventsQuery>,
) -> Response {
    if query.mux.as_deref() == Some("herdr") {
        let receiver = state.herdr_event_tx.subscribe();
        let initial_state = state.clone();
        let stream = futures_util::stream::unfold(
            (true, receiver, initial_state),
            move |(is_first, mut receiver, shared_state)| async move {
                if is_first {
                    let payload = serde_json::json!({
                        "herdr": get_herdr_snapshot(&shared_state),
                        "event": null,
                    });
                    return Some((
                        Ok::<Event, Infallible>(Event::default().data(payload.to_string())),
                        (false, receiver, shared_state),
                    ));
                }
                loop {
                    match receiver.recv().await {
                        Ok(payload) => {
                            return Some((
                                Ok::<Event, Infallible>(Event::default().data(payload.to_string())),
                                (false, receiver, shared_state),
                            ));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    }
                }
            },
        );
        return Sse::new(stream)
            .keep_alive(
                KeepAlive::new()
                    .interval(Duration::from_secs(15))
                    .text("keep-alive"),
            )
            .into_response();
    }

    let explicit_tty = query.client_tty.clone();
    let shared_state = state.clone();

    let stream =
        futures_util::stream::unfold((true, String::new()), move |(is_first, prev_json)| {
            let explicit_tty = explicit_tty.clone();
            let shared_state = shared_state.clone();
            async move {
                if !is_first {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }

                let payload = tokio::task::spawn_blocking(move || {
                    let client_tty = get_effective_client_tty(&shared_state, explicit_tty);
                    let tty_clone = client_tty.clone();
                    let cwd = get_cwd(tty_clone.clone());
                    let mut branch = String::new();
                    let mut path = cwd.clone();

                    if is_git_repo(&cwd) {
                        let git_root = get_git_root(&cwd);
                        branch = get_branch(&git_root);
                        path = git_root;
                    }

                    let snapshot = get_tmux_snapshot(&shared_state);
                    let current_session = get_current_tmux_session(tty_clone.as_deref());

                    let tui_active = match current_session.as_deref() {
                        Some(sess) => run_cmd(
                            "tmux",
                            &[
                                "display-message",
                                "-t",
                                &format!("{}:", sess),
                                "-p",
                                "#{alternate_on}",
                            ],
                        )
                        .map(|s| s.trim() == "1")
                        .unwrap_or(false),
                        None => false,
                    };

                    serde_json::json!({
                        "branch": branch,
                        "path": path,
                        "tuiActive": tui_active,
                        "tmux": {
                            "sessions": snapshot.sessions,
                            "currentSession": current_session,
                            "scannedAt": snapshot.scanned_at,
                            "projectGroups": snapshot.project_groups,
                            "otherSessions": snapshot.other_sessions,
                        }
                    })
                })
                .await
                .unwrap_or_else(|_| serde_json::json!({}));

                let json_str = payload.to_string();
                let mut comparison_payload = payload;
                if let Some(tmux) = comparison_payload
                    .get_mut("tmux")
                    .and_then(|value| value.as_object_mut())
                {
                    tmux.insert("scannedAt".to_string(), serde_json::Value::Null);
                }
                let comparison_json = comparison_payload.to_string();
                if !is_first && comparison_json == prev_json {
                    return Some((
                        Ok::<Event, Infallible>(Event::default().comment("no-change")),
                        (false, prev_json),
                    ));
                }
                let event = Event::default().data(json_str.clone());
                Some((Ok::<Event, Infallible>(event), (false, comparison_json)))
            }
        });

    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response()
}

// ─── GET/POST /api/user-config ─────────────────────────────────────────────

fn user_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".vibeterm.json")
}

async fn api_get_user_config() -> Response {
    let path = user_config_path();
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => ([(header::CONTENT_TYPE, "application/json")], content).into_response(),
        Err(_) => Json(serde_json::json!({})).into_response(),
    }
}

async fn api_set_user_config(body: axum::body::Bytes) -> Response {
    let path = user_config_path();
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    match tokio::fs::write(&path, &body).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => json_error(
            "write_failed",
            &e.to_string(),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── GET/POST /api/goal-workspace ─────────────────────────────────────────

const GOAL_WORKSPACE_VERSION: u8 = 1;
const MAX_GOAL_BODY_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GoalVariableDefinition {
    name: String,
    default_value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GoalVariableValue {
    name: String,
    value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GoalTemplate {
    id: String,
    title: String,
    variables: Vec<GoalVariableDefinition>,
    body: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GoalWorkingCopy {
    id: String,
    source_template_id: Option<String>,
    source_template_title: String,
    title: String,
    variables: Vec<GoalVariableValue>,
    body: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum GoalActiveItem {
    Template { id: String },
    Copy { id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GoalWorkspace {
    version: u8,
    templates: Vec<GoalTemplate>,
    working_copies: Vec<GoalWorkingCopy>,
    active_item: Option<GoalActiveItem>,
}

impl GoalWorkspace {
    fn empty() -> Self {
        Self {
            version: GOAL_WORKSPACE_VERSION,
            templates: Vec::new(),
            working_copies: Vec::new(),
            active_item: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalDumpRequest {
    working_copy_id: String,
    text: String,
}

fn goal_workspace_path() -> Result<PathBuf, ApiError> {
    Ok(promptgoal_dir()?.join("workspace.json"))
}

fn valid_goal_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_variable_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Result<(), String> {
    let mut seen = HashSet::new();
    for name in names {
        if name.trim().is_empty()
            || name
                .chars()
                .any(|character| matches!(character, '\r' | '\n' | '='))
        {
            return Err(format!("Invalid variable name: {name:?}"));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("Duplicate variable name: {name}"));
        }
    }
    Ok(())
}

fn validate_goal_workspace(workspace: &GoalWorkspace) -> Result<(), String> {
    if workspace.version != GOAL_WORKSPACE_VERSION {
        return Err(format!(
            "Unsupported workspace version: {}",
            workspace.version
        ));
    }

    let mut template_ids = HashSet::new();
    for template in &workspace.templates {
        if !valid_goal_id(&template.id) || !template_ids.insert(template.id.as_str()) {
            return Err(format!("Invalid or duplicate template ID: {}", template.id));
        }
        validate_variable_names(
            template
                .variables
                .iter()
                .map(|variable| variable.name.as_str()),
        )?;
    }

    let mut copy_ids = HashSet::new();
    for copy in &workspace.working_copies {
        if !valid_goal_id(&copy.id) || !copy_ids.insert(copy.id.as_str()) {
            return Err(format!("Invalid or duplicate working copy ID: {}", copy.id));
        }
        if copy
            .source_template_id
            .as_deref()
            .is_some_and(|id| !valid_goal_id(id))
        {
            return Err(format!(
                "Invalid source template ID: {:?}",
                copy.source_template_id
            ));
        }
        validate_variable_names(copy.variables.iter().map(|variable| variable.name.as_str()))?;
    }

    match &workspace.active_item {
        Some(GoalActiveItem::Template { id }) if !template_ids.contains(id.as_str()) => {
            return Err(format!("Active template does not exist: {id}"));
        }
        Some(GoalActiveItem::Copy { id }) if !copy_ids.contains(id.as_str()) => {
            return Err(format!("Active working copy does not exist: {id}"));
        }
        _ => {}
    }
    Ok(())
}

fn atomic_write(path: &Path, body: &[u8]) -> Result<(), ApiError> {
    let parent = path.parent().ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "directory_create_failed".to_string(),
            "Workspace path has no parent directory".to_string(),
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "directory_create_failed".to_string(),
            format!("Failed to create workspace directory: {error}"),
        )
    })?;

    let timestamp = Local::now().format("%Y%m%d%H%M%S%3f");
    let mut collision = 0_u64;
    let (temp_path, mut file) = loop {
        let temp_path = parent.join(format!(
            ".workspace.json.{}.{}.{collision}.tmp",
            std::process::id(),
            timestamp
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => break (temp_path, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => collision += 1,
            Err(error) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "file_create_failed".to_string(),
                    format!("Failed to create workspace temp file: {error}"),
                ));
            }
        }
    };

    if let Err(error) = file.write_all(body).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temp_path);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "write_failed".to_string(),
            format!("Failed to write workspace temp file: {error}"),
        ));
    }
    drop(file);

    if let Err(error) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "rename_failed".to_string(),
            format!("Failed to atomically replace workspace: {error}"),
        ));
    }
    Ok(())
}

fn legacy_variable_assignment(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    let (raw_name, raw_value) = trimmed.split_once('=')?;
    let name = raw_name.trim();
    if name.is_empty()
        || !name.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_uppercase() || (index > 0 && byte.is_ascii_digit())
        })
    {
        return None;
    }
    Some((name.to_string(), raw_value.trim().to_string()))
}

fn migrate_legacy_prompt(text: &str) -> (Vec<GoalVariableDefinition>, String) {
    const VARIABLE_START: &str = "【变量区】";
    const VARIABLE_END: &str = "【执行区】";
    let Some(start_marker) = text.find(VARIABLE_START) else {
        return (Vec::new(), text.to_string());
    };
    let section_start = start_marker + VARIABLE_START.len();
    let (section_end, suffix_start) = match text[section_start..].find(VARIABLE_END) {
        Some(relative_end) => {
            let section_end = section_start + relative_end;
            (section_end, section_end + VARIABLE_END.len())
        }
        None => (text.len(), text.len()),
    };

    let mut variables = Vec::new();
    let mut seen = HashSet::new();
    let mut remaining_lines = Vec::new();
    for line in text[section_start..section_end].lines() {
        if let Some((name, default_value)) = legacy_variable_assignment(line) {
            if seen.insert(name.to_lowercase()) {
                variables.push(GoalVariableDefinition {
                    name,
                    default_value,
                });
            }
        } else {
            remaining_lines.push(line);
        }
    }

    let remaining_section = remaining_lines.join("\n");
    let body = [
        text[..start_marker].trim(),
        remaining_section.trim(),
        text[suffix_start..].trim(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    (variables, body)
}

fn normalize_goal_body(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut previous_blank = false;
    for line in text.trim().lines() {
        let blank = line.trim().is_empty();
        if blank && previous_blank {
            continue;
        }
        if !normalized.is_empty() {
            normalized.push('\n');
        }
        normalized.push_str(line.trim_end_matches('\r'));
        previous_blank = blank;
    }
    normalized
}

fn extract_goal_test_hints(text: &str) -> Option<(String, String)> {
    const HEADING: &str = "P3 测试补充信息";
    const ASSIGNMENT: &str = "TEST_HINTS";
    let lines: Vec<_> = text.lines().collect();
    let heading_index = lines
        .iter()
        .position(|line| line.trim_end_matches('\r').trim() == HEADING)?;
    let assignment_index = heading_index + 1;
    let assignment = lines.get(assignment_index)?.trim_end_matches('\r');
    let (name, first_value) = assignment.split_once('=')?;
    if name.trim() != ASSIGNMENT {
        return None;
    }

    let section_end = lines[assignment_index + 1..]
        .iter()
        .position(|line| {
            let line = line.trim_end_matches('\r').trim();
            line.starts_with("P3 测试（") || line.starts_with("测试（")
        })
        .map(|relative| assignment_index + 1 + relative)
        .unwrap_or(lines.len());
    let mut value_lines = vec![first_value.trim_start().to_string()];
    value_lines.extend(
        lines[assignment_index + 1..section_end]
            .iter()
            .map(|line| line.trim_end_matches('\r').to_string()),
    );
    while value_lines.last().is_some_and(|line| line.is_empty()) {
        value_lines.pop();
    }

    let before = lines[..heading_index].join("\n");
    let after = lines[section_end..].join("\n");
    let body = [before.trim_end(), after.trim_start()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    Some((value_lines.join("\n"), body))
}

fn migrate_workspace_test_hints(workspace: &mut GoalWorkspace) -> bool {
    let mut changed = false;
    for template in &mut workspace.templates {
        let Some((value, body)) = extract_goal_test_hints(&template.body) else {
            continue;
        };
        if !template
            .variables
            .iter()
            .any(|variable| variable.name.eq_ignore_ascii_case("TEST_HINTS"))
        {
            template.variables.push(GoalVariableDefinition {
                name: "TEST_HINTS".to_string(),
                default_value: value,
            });
        }
        template.body = body;
        changed = true;
    }
    for copy in &mut workspace.working_copies {
        let Some((value, body)) = extract_goal_test_hints(&copy.body) else {
            continue;
        };
        if !copy
            .variables
            .iter()
            .any(|variable| variable.name.eq_ignore_ascii_case("TEST_HINTS"))
        {
            copy.variables.push(GoalVariableValue {
                name: "TEST_HINTS".to_string(),
                value,
            });
        }
        copy.body = body;
        changed = true;
    }
    changed
}

fn is_goal_group(id: &str, title: &str) -> bool {
    id.to_ascii_lowercase().contains("goal") || title.to_ascii_lowercase().contains("goal")
}

#[derive(Clone)]
struct LegacyGoalBlock {
    label: String,
    text: String,
}

#[derive(Clone, Copy)]
enum GoalScenario {
    BoeLark,
    BoeNexus,
    NonIm,
    Ppe,
}

impl GoalScenario {
    const ALL: [Self; 4] = [Self::BoeLark, Self::BoeNexus, Self::NonIm, Self::Ppe];

    fn title(self) -> &'static str {
        match self {
            Self::BoeLark => "BOE 飞书",
            Self::BoeNexus => "BOE Nexus",
            Self::NonIm => "非 IM",
            Self::Ppe => "PPE",
        }
    }

    fn bit(self) -> u8 {
        match self {
            Self::BoeLark => 1,
            Self::BoeNexus => 2,
            Self::NonIm => 4,
            Self::Ppe => 8,
        }
    }
}

const ALL_GOAL_SCENARIOS: u8 = 1 | 2 | 4 | 8;

fn is_numbered_goal_block(label: &str) -> bool {
    let Some((prefix, _)) = label.split_once('｜') else {
        return false;
    };
    let prefix = prefix.trim().trim_end_matches(|character: char| {
        matches!(character.to_ascii_uppercase(), 'A' | 'B' | 'C' | 'D')
    });
    !prefix.is_empty() && prefix.bytes().all(|byte| byte.is_ascii_digit())
}

fn goal_block_scenarios(label: &str) -> u8 {
    let normalized = label.to_ascii_lowercase().replace(' ', "");
    if normalized.contains("ppe") {
        return GoalScenario::Ppe.bit();
    }
    if normalized.contains("nexus") {
        return GoalScenario::BoeNexus.bit();
    }
    if normalized.contains("非im") {
        return GoalScenario::NonIm.bit();
    }
    if normalized.contains("boe") {
        if normalized.contains("飞书") {
            return GoalScenario::BoeLark.bit();
        }
        return GoalScenario::BoeLark.bit()
            | GoalScenario::BoeNexus.bit()
            | GoalScenario::NonIm.bit();
    }
    ALL_GOAL_SCENARIOS
}

fn legacy_goal_groups(value: &serde_json::Value) -> Vec<(String, String, Vec<LegacyGoalBlock>)> {
    let Some(groups) = value
        .get("presetGroups")
        .and_then(|groups| groups.as_array())
    else {
        return Vec::new();
    };

    groups
        .iter()
        .enumerate()
        .filter_map(|(group_index, group)| {
            let id = group
                .get("id")
                .and_then(|id| id.as_str())
                .unwrap_or_default();
            let title = group
                .get("label")
                .and_then(|label| label.as_str())
                .filter(|label| !label.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("Goal 分组 {}", group_index + 1));
            if !is_goal_group(id, &title) {
                return None;
            }
            let blocks: Vec<_> = group
                .get("presets")
                .and_then(|presets| presets.as_array())
                .map(|presets| {
                    presets
                        .iter()
                        .map(|preset| {
                            let label = preset
                                .get("label")
                                .and_then(|label| label.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let text = preset
                                .get("text")
                                .and_then(|text| text.as_str())
                                .unwrap_or_default()
                                .to_string();
                            LegacyGoalBlock { label, text }
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !blocks
                .iter()
                .any(|block| is_numbered_goal_block(&block.label))
            {
                return None;
            }
            Some((id.to_string(), title, blocks))
        })
        .collect()
}

fn goal_group_template_id(group_id: &str, title: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in group_id.bytes().chain([0]).chain(title.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("template-goal-{hash:016x}")
}

fn merge_legacy_goal_blocks<'a>(
    blocks: impl IntoIterator<Item = &'a LegacyGoalBlock>,
) -> (Vec<GoalVariableDefinition>, String) {
    let mut variables = Vec::new();
    let mut variable_names = HashSet::new();
    let mut bodies = Vec::new();
    for block in blocks {
        let (mut block_variables, mut body) = migrate_legacy_prompt(&block.text);
        if let Some((value, remaining_body)) = extract_goal_test_hints(&body) {
            block_variables.push(GoalVariableDefinition {
                name: "TEST_HINTS".to_string(),
                default_value: value,
            });
            body = remaining_body;
        }
        for variable in block_variables {
            if variable_names.insert(variable.name.to_lowercase()) {
                variables.push(variable);
            }
        }
        let body = body.trim();
        if !body.is_empty() {
            bodies.push(body.to_string());
        }
    }
    if let Some(index) = variables
        .iter()
        .position(|variable| variable.name.eq_ignore_ascii_case("TEST_HINTS"))
    {
        let test_hints = variables.remove(index);
        variables.push(test_hints);
    }
    (variables, normalize_goal_body(&bodies.join("\n\n")))
}

fn expand_legacy_goal_group(
    group_id: &str,
    group_title: &str,
    blocks: &[LegacyGoalBlock],
    now: &str,
) -> Vec<GoalTemplate> {
    // Structured Goal groups may also contain scratch or reference presets. Only
    // the explicitly numbered blocks belong to the ordered, runnable template.
    let ordered_blocks: Vec<_> = blocks
        .iter()
        .filter(|block| is_numbered_goal_block(&block.label))
        .cloned()
        .collect();
    let has_scenario_blocks = ordered_blocks
        .iter()
        .any(|block| goal_block_scenarios(&block.label) != ALL_GOAL_SCENARIOS);
    if !has_scenario_blocks {
        let (variables, body) = merge_legacy_goal_blocks(&ordered_blocks);
        return vec![GoalTemplate {
            id: goal_group_template_id(group_id, group_title),
            title: group_title.to_string(),
            variables,
            body,
            created_at: now.to_string(),
            updated_at: now.to_string(),
        }];
    }

    GoalScenario::ALL
        .into_iter()
        .map(|scenario| {
            let selected = blocks
                .iter()
                .filter(|block| is_numbered_goal_block(&block.label))
                .filter(|block| goal_block_scenarios(&block.label) & scenario.bit() != 0);
            let (variables, body) = merge_legacy_goal_blocks(selected);
            let title = format!("{group_title}｜{}", scenario.title());
            GoalTemplate {
                id: goal_group_template_id(group_id, &title),
                title,
                variables,
                body,
                created_at: now.to_string(),
                updated_at: now.to_string(),
            }
        })
        .collect()
}

fn migrate_legacy_workspace(path: &Path) -> Result<GoalWorkspace, ApiError> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GoalWorkspace::empty());
        }
        Err(error) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "legacy_read_failed".to_string(),
                format!("Failed to read legacy config: {error}"),
            ));
        }
    };
    let legacy: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_legacy_config".to_string(),
            format!("Failed to parse legacy config: {error}"),
        )
    })?;
    let now = Local::now().to_rfc3339();
    let templates: Vec<_> = legacy_goal_groups(&legacy)
        .into_iter()
        .flat_map(|(group_id, group_title, blocks)| {
            expand_legacy_goal_group(&group_id, &group_title, &blocks, &now)
        })
        .collect();
    let active_item = templates.first().map(|template| GoalActiveItem::Template {
        id: template.id.clone(),
    });
    Ok(GoalWorkspace {
        version: GOAL_WORKSPACE_VERSION,
        templates,
        working_copies: Vec::new(),
        active_item,
    })
}

fn goal_workspace_needs_legacy_repair(workspace: &GoalWorkspace) -> bool {
    if !workspace.working_copies.is_empty()
        || workspace
            .templates
            .iter()
            .any(|template| template.created_at != template.updated_at)
    {
        return false;
    }

    workspace.templates.iter().any(|template| {
        template.id.starts_with("template-migrated-")
            || template.body.contains("\n\n\n")
            || (template.title.starts_with("CC Goal｜移动无Review｜")
                && template
                    .body
                    .contains("【怎么用｜先读这段】这是一份\"测试技法库\""))
    })
}

fn load_or_create_goal_workspace(
    workspace_path: &Path,
    legacy_path: &Path,
) -> Result<GoalWorkspace, ApiError> {
    match std::fs::read(workspace_path) {
        Ok(content) => {
            let mut workspace: GoalWorkspace =
                serde_json::from_slice(&content).map_err(|error| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "invalid_workspace".to_string(),
                        format!("Failed to parse goal workspace: {error}"),
                    )
                })?;
            validate_goal_workspace(&workspace).map_err(|message| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_workspace".to_string(),
                    message,
                )
            })?;
            let moved_test_hints = migrate_workspace_test_hints(&mut workspace);
            // Earlier Goal Workbench builds migrated every prompt block separately,
            // preserved large holes left by extracted variables, or included an
            // unnumbered scratch preset. Repair only those known, untouched
            // workspaces. A clean workspace is independent from the legacy prompt
            // library and must never be overwritten during an ordinary GET.
            if legacy_path.is_file() && goal_workspace_needs_legacy_repair(&workspace) {
                let mut synced = workspace.clone();
                let mut source_templates = migrate_legacy_workspace(legacy_path)?.templates;
                for template in &mut source_templates {
                    if let Some(existing) = workspace
                        .templates
                        .iter()
                        .find(|existing| existing.id == template.id)
                    {
                        template.created_at = existing.created_at.clone();
                        if existing.title == template.title
                            && existing.variables == template.variables
                            && existing.body == template.body
                        {
                            template.updated_at = existing.updated_at.clone();
                        }
                    }
                }
                synced.templates = source_templates;
                if matches!(
                    &synced.active_item,
                    Some(GoalActiveItem::Template { id })
                        if !synced.templates.iter().any(|template| template.id == *id)
                ) {
                    synced.active_item = synced
                        .templates
                        .first()
                        .map(|template| GoalActiveItem::Template {
                            id: template.id.clone(),
                        })
                        .or_else(|| {
                            synced
                                .working_copies
                                .first()
                                .map(|copy| GoalActiveItem::Copy {
                                    id: copy.id.clone(),
                                })
                        });
                }
                if synced != workspace {
                    let serialized = serde_json::to_vec_pretty(&synced).map_err(|error| {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "serialize_failed".to_string(),
                            format!("Failed to serialize synced goal workspace: {error}"),
                        )
                    })?;
                    atomic_write(workspace_path, &serialized)?;
                    return Ok(synced);
                }
            }
            if moved_test_hints {
                let serialized = serde_json::to_vec_pretty(&workspace).map_err(|error| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "serialize_failed".to_string(),
                        format!("Failed to serialize migrated goal workspace: {error}"),
                    )
                })?;
                atomic_write(workspace_path, &serialized)?;
            }
            Ok(workspace)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let workspace = migrate_legacy_workspace(legacy_path)?;
            let serialized = serde_json::to_vec_pretty(&workspace).map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "serialize_failed".to_string(),
                    format!("Failed to serialize goal workspace: {error}"),
                )
            })?;
            atomic_write(workspace_path, &serialized)?;
            Ok(workspace)
        }
        Err(error) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "workspace_read_failed".to_string(),
            format!("Failed to read goal workspace: {error}"),
        )),
    }
}

async fn api_get_goal_workspace() -> Response {
    let workspace_path = match goal_workspace_path() {
        Ok(path) => path,
        Err((status, code, message)) => return json_error(&code, &message, status),
    };
    let legacy_path = user_config_path();
    match tokio::task::spawn_blocking(move || {
        load_or_create_goal_workspace(&workspace_path, &legacy_path)
    })
    .await
    {
        Ok(Ok(workspace)) => Json(workspace).into_response(),
        Ok(Err((status, code, message))) => json_error(&code, &message, status),
        Err(error) => json_error(
            "read_task_failed",
            &format!("Workspace read task failed: {error}"),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn api_set_goal_workspace(req: Request) -> Response {
    let body = match axum::body::to_bytes(req.into_body(), MAX_GOAL_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            return json_error(
                "body_too_large",
                "Workspace exceeds the 50 MB limit",
                StatusCode::PAYLOAD_TOO_LARGE,
            );
        }
    };
    let workspace: GoalWorkspace = match serde_json::from_slice(&body) {
        Ok(workspace) => workspace,
        Err(error) => {
            return json_error(
                "invalid_json",
                &format!("Invalid workspace JSON: {error}"),
                StatusCode::BAD_REQUEST,
            );
        }
    };
    if let Err(message) = validate_goal_workspace(&workspace) {
        return json_error("invalid_workspace", &message, StatusCode::BAD_REQUEST);
    }
    let body = match serde_json::to_vec_pretty(&workspace) {
        Ok(body) => body,
        Err(error) => {
            return json_error(
                "serialize_failed",
                &error.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let path = match goal_workspace_path() {
        Ok(path) => path,
        Err((status, code, message)) => return json_error(&code, &message, status),
    };
    match tokio::task::spawn_blocking(move || atomic_write(&path, &body)).await {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, message))) => json_error(&code, &message, status),
        Err(error) => json_error(
            "write_task_failed",
            &format!("Workspace write task failed: {error}"),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/goal-dump ──────────────────────────────────────────────────

async fn api_goal_dump(req: Request) -> Response {
    let body = match axum::body::to_bytes(req.into_body(), MAX_GOAL_BODY_BYTES + 64 * 1024).await {
        Ok(body) => body,
        Err(_) => {
            return json_error(
                "body_too_large",
                "Selected text exceeds the 50 MB limit",
                StatusCode::PAYLOAD_TOO_LARGE,
            );
        }
    };
    let request: GoalDumpRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => {
            return json_error(
                "invalid_json",
                &format!("Invalid goal dump JSON: {error}"),
                StatusCode::BAD_REQUEST,
            );
        }
    };
    if !valid_goal_id(&request.working_copy_id) {
        return json_error(
            "invalid_working_copy_id",
            "Working copy ID is invalid",
            StatusCode::BAD_REQUEST,
        );
    }
    if request.text.is_empty() {
        return json_error(
            "empty_text",
            "No selected text provided",
            StatusCode::BAD_REQUEST,
        );
    }
    if request.text.len() > MAX_GOAL_BODY_BYTES {
        return json_error(
            "body_too_large",
            "Selected text exceeds the 50 MB limit",
            StatusCode::PAYLOAD_TOO_LARGE,
        );
    }

    let workspace_path = match goal_workspace_path() {
        Ok(path) => path,
        Err((status, code, message)) => return json_error(&code, &message, status),
    };
    let legacy_path = user_config_path();
    let copy_id = request.working_copy_id;
    let text = request.text.into_bytes();
    let timestamp = Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    match tokio::task::spawn_blocking(move || {
        let workspace = load_or_create_goal_workspace(&workspace_path, &legacy_path)?;
        if !workspace
            .working_copies
            .iter()
            .any(|copy| copy.id == copy_id)
        {
            return Err((
                StatusCode::NOT_FOUND,
                "working_copy_not_found".to_string(),
                "Working copy does not exist".to_string(),
            ));
        }
        let dir = workspace_path
            .parent()
            .expect("workspace path has a parent")
            .join("attachments")
            .join(&copy_id);
        create_dump_file(&dir, &text, &timestamp)
    })
    .await
    {
        Ok(Ok(path)) => Json(serde_json::json!({ "path": path.to_string_lossy() })).into_response(),
        Ok(Err((status, code, message))) => json_error(&code, &message, status),
        Err(error) => json_error(
            "write_task_failed",
            &format!("Goal dump task failed: {error}"),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/dump-file ───────────────────────────────────────────────────

fn promptgoal_dir() -> Result<PathBuf, ApiError> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let home = PathBuf::from(home);
    if home.is_absolute() {
        Ok(home.join("promptgoal"))
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(home).join("promptgoal"))
            .map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "directory_create_failed".to_string(),
                    format!("Failed to resolve promptgoal directory: {error}"),
                )
            })
    }
}

fn create_dump_file(dir: &Path, body: &[u8], timestamp: &str) -> Result<PathBuf, ApiError> {
    std::fs::create_dir_all(dir).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "directory_create_failed".to_string(),
            format!("Failed to create promptgoal directory: {error}"),
        )
    })?;

    let mut collision = 0_u64;
    loop {
        let filename = if collision == 0 {
            format!("{timestamp}.md")
        } else {
            format!("{timestamp}-{collision}.md")
        };
        let path = dir.join(filename);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                collision += 1;
                continue;
            }
            Err(error) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "file_create_failed".to_string(),
                    format!("Failed to create dump file: {error}"),
                ));
            }
        };

        if let Err(error) = file.write_all(body) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "write_failed".to_string(),
                format!("Failed to write dump file: {error}"),
            ));
        }
        return Ok(path);
    }
}

async fn api_dump_file(req: Request) -> Response {
    let body = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(body) => body,
        Err(_) => return json_error("read_error", "Failed to read body", StatusCode::BAD_REQUEST),
    };
    if body.is_empty() {
        return json_error("empty_body", "No text provided", StatusCode::BAD_REQUEST);
    }

    let dir = match promptgoal_dir() {
        Ok(dir) => dir,
        Err((status, code, message)) => return json_error(&code, &message, status),
    };
    let timestamp = Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    match tokio::task::spawn_blocking(move || create_dump_file(&dir, &body, &timestamp)).await {
        Ok(Ok(path)) => Json(serde_json::json!({
            "path": path.to_string_lossy(),
        }))
        .into_response(),
        Ok(Err((status, code, message))) => json_error(&code, &message, status),
        Err(error) => json_error(
            "write_task_failed",
            &format!("Dump file task failed: {error}"),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ─── POST /api/upload ──────────────────────────────────────────────────────

async fn api_upload_file(req: Request) -> Response {
    let content_type = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // Extract original filename from X-Filename header (if provided)
    let original_name = req
        .headers()
        .get("X-Filename")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Read body (50MB limit)
    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return json_error("read_error", "Failed to read body", StatusCode::BAD_REQUEST),
    };

    if body_bytes.is_empty() {
        return json_error("empty_body", "No file data", StatusCode::BAD_REQUEST);
    }

    // Determine extension: prefer original filename ext, fallback to content-type
    let ext = original_name
        .as_deref()
        .and_then(|n| n.rsplit('.').next())
        .filter(|e| !e.is_empty() && e.len() <= 10)
        .unwrap_or(match content_type.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            "text/plain" => "txt",
            "text/csv" => "csv",
            "application/json" => "json",
            "application/pdf" => "pdf",
            "application/zip" => "zip",
            "application/gzip" => "gz",
            "application/x-tar" => "tar",
            "text/javascript" | "application/javascript" => "js",
            "text/html" => "html",
            "text/css" => "css",
            "text/xml" | "application/xml" => "xml",
            "application/x-yaml" | "text/yaml" => "yaml",
            "text/markdown" => "md",
            _ => "bin",
        });

    let upload_dir = "/tmp/ttyd_uploads";
    let _ = tokio::fs::create_dir_all(upload_dir).await;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = if let Some(ref name) = original_name {
        let stem = name.rsplit('/').next().unwrap_or(name);
        let stem = stem.split('.').next().unwrap_or(stem);
        let clean: String = stem
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        format!("{}_{}.{}", clean, timestamp, ext)
    } else {
        format!("upload_{}.{}", timestamp, ext)
    };
    let filepath = format!("{}/{}", upload_dir, filename);

    match tokio::fs::write(&filepath, &body_bytes).await {
        Ok(_) => Json(serde_json::json!({
            "path": filepath,
            "filename": filename,
        }))
        .into_response(),
        Err(e) => json_error(
            "write_error",
            &format!("Failed to write file: {}", e),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA TYPES
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Serialize)]
struct BranchesResponse {
    local: Vec<String>,
    remote: Vec<String>,
    current: String,
}

struct ChangedFile {
    status: String,
    filename: String,
}

#[derive(Serialize)]
struct DiffLine {
    #[serde(rename = "type")]
    line_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_num: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_num: Option<i64>,
    content: String,
}

#[derive(Serialize)]
struct DiffHunk {
    header: String,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
struct DiffFile {
    filename: String,
    status: String,
    binary: bool,
    additions: i64,
    deletions: i64,
    hunks: Vec<DiffHunk>,
}

#[derive(Serialize)]
struct DiffSummary {
    #[serde(rename = "totalFiles")]
    total_files: i64,
    #[serde(rename = "totalAdditions")]
    total_additions: i64,
    #[serde(rename = "totalDeletions")]
    total_deletions: i64,
}

#[derive(Serialize)]
struct DiffResult {
    files: Vec<DiffFile>,
    summary: DiffSummary,
}

// ═══════════════════════════════════════════════════════════════════════════
// SUBPROCESS HELPERS
// ═══════════════════════════════════════════════════════════════════════════

fn run_cmd(cmd: &str, args: &[&str]) -> Result<String, String> {
    let mut command = StdCommand::new(cmd);
    if cmd == "tmux" {
        if let Ok(socket) = std::env::var("RUST_TERMINAL_TMUX_SOCKET") {
            if !socket.is_empty() {
                command.args(["-L", &socket]);
            }
        }
    }
    match command
        .args(args)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

fn find_owned_tmux_clients(wrapper_pid: u32) -> Vec<String> {
    let output = match run_cmd(
        "tmux",
        &["list-clients", "-F", "#{client_tty} #{client_pid}"],
    ) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };

    let mut owned = Vec::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let tty = match parts.next() {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        let pid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        if process_descends_from(pid, wrapper_pid) {
            owned.push(tty.to_string());
        }
    }
    owned
}

fn process_descends_from(pid: u32, ancestor: u32) -> bool {
    if pid == ancestor {
        return true;
    }
    let mut current = pid;
    for _ in 0..10 {
        let ppid = match run_cmd("ps", &["-o", "ppid=", "-p", &current.to_string()])
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
        {
            Some(p) => p,
            None => return false,
        };
        if ppid == ancestor {
            return true;
        }
        if ppid <= 1 {
            return false;
        }
        current = ppid;
    }
    false
}

fn spawn_detached_cmd(cmd: &str, args: &[&str]) -> Result<(), String> {
    let mut command = StdCommand::new(cmd);
    if cmd == "tmux" {
        if let Ok(socket) = std::env::var("RUST_TERMINAL_TMUX_SOCKET") {
            if !socket.is_empty() {
                command.args(["-L", &socket]);
            }
        }
    }
    let mut child = command
        .args(args)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(())
}

fn tmux_supports_display_popup() -> bool {
    run_cmd("tmux", &["list-commands", "display-popup"])
        .map(|output| {
            output
                .lines()
                .any(|line| line.starts_with("display-popup "))
        })
        .unwrap_or(false)
}

fn run_cmd_in(cmd: &str, args: &[&str], cwd: &str) -> Result<String, String> {
    match StdCommand::new(cmd)
        .args(args)
        .current_dir(cwd)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::Message;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tmux_discovery::TmuxSession;
    use tower::ServiceExt;

    #[test]
    fn dump_file_creates_directory_and_preserves_bytes() {
        let temp = tempfile::TempDir::new().unwrap();
        let dir = temp.path().join("missing").join("promptgoal");
        let body = b"  first line\n\xe4\xb8\xad\xe6\x96\x87\n\n";

        let path = create_dump_file(&dir, body, "20260719-013245-123").unwrap();

        assert!(path.is_absolute());
        assert_eq!(path.file_name().unwrap(), "20260719-013245-123.md");
        assert_eq!(std::fs::read(path).unwrap(), body);
    }

    #[test]
    fn dump_file_never_overwrites_and_is_unique_under_concurrency() {
        let temp = tempfile::TempDir::new().unwrap();
        let dir = temp.path().join("promptgoal");
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("20260719-013245-123.md");
        std::fs::write(&original, b"original").unwrap();

        let dir = Arc::new(dir);
        let handles: Vec<_> = (0..12)
            .map(|index| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let body = format!("concurrent-{index}");
                    let path =
                        create_dump_file(&dir, body.as_bytes(), "20260719-013245-123").unwrap();
                    (path, body)
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        let paths: std::collections::HashSet<_> =
            results.iter().map(|(path, _)| path.clone()).collect();

        assert_eq!(paths.len(), results.len());
        assert_eq!(std::fs::read(&original).unwrap(), b"original");
        for (path, body) in results {
            assert_eq!(std::fs::read(path).unwrap(), body.as_bytes());
        }
    }

    #[test]
    fn test_parse_init_message_binary_valid() {
        let json = r#"{"AuthToken":"","columns":120,"rows":40}"#;
        let msg = Message::Binary(json.as_bytes().to_vec().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 120);
        assert_eq!(rows, 40);
    }

    #[test]
    fn test_parse_init_message_text_valid() {
        let json = r#"{"AuthToken":"","columns":80,"rows":24}"#;
        let msg = Message::Text(json.to_string().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_parse_init_message_invalid_returns_defaults() {
        let msg = Message::Binary(b"not json".to_vec().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_parse_init_message_ping_returns_defaults() {
        let msg = Message::Ping(vec![1, 2, 3].into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_output_frame_starts_with_0x30() {
        let payload = b"hello world";
        let mut frame = Vec::with_capacity(payload.len() + 1);
        frame.push(0x30u8);
        frame.extend_from_slice(payload);
        assert_eq!(frame[0], 0x30);
        assert_eq!(&frame[1..], payload);
    }

    #[test]
    fn test_resize_message_deserialization() {
        let json = r#"{"AuthToken":"","columns":100,"rows":30}"#;
        let msg: ResizeMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.columns, 100);
        assert_eq!(msg.rows, 30);
    }

    #[test]
    fn test_resize_message_without_auth_token() {
        let json = r#"{"columns":200,"rows":50}"#;
        let msg: ResizeMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.columns, 200);
        assert_eq!(msg.rows, 50);
        assert!(msg.auth_token.is_none());
    }

    #[test]
    fn test_init_message_deserialization() {
        let json = r#"{"columns":120,"rows":40}"#;
        let msg: InitMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.columns, 120);
        assert_eq!(msg.rows, 40);
    }

    #[test]
    fn test_bounded_channel_capacity() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        for i in 0..100u8 {
            tx.send(vec![i]).unwrap();
        }
    }

    // ─── parse_init_message extra edge cases ──────────────────────────────

    #[test]
    fn test_parse_init_message_zero_columns_clamped_to_one() {
        let json = r#"{"columns":0,"rows":24}"#;
        let msg = Message::Text(json.to_string().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 1);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_parse_init_message_zero_rows_clamped_to_one() {
        let json = r#"{"columns":80,"rows":0}"#;
        let msg = Message::Text(json.to_string().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 1);
    }

    #[test]
    fn test_parse_init_message_close_returns_defaults() {
        let msg = Message::Close(None);
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    // ─── parse_porcelain_status ───────────────────────────────────────────

    #[test]
    fn test_parse_porcelain_status_empty() {
        let (staged, unstaged) = parse_porcelain_status("");
        assert!(staged.is_empty());
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_staged_modified() {
        let output = "M  src/main.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].file, "src/main.rs");
        assert_eq!(staged[0].status, "M");
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_unstaged_modified() {
        let output = " M src/main.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert_eq!(unstaged.len(), 1);
        assert_eq!(unstaged[0].file, "src/main.rs");
        assert_eq!(unstaged[0].status, "M");
    }

    #[test]
    fn test_parse_porcelain_status_both_staged_and_unstaged() {
        let output = "MM src/main.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 1);
        assert_eq!(unstaged.len(), 1);
        assert_eq!(staged[0].file, "src/main.rs");
        assert_eq!(unstaged[0].file, "src/main.rs");
    }

    #[test]
    fn test_parse_porcelain_status_untracked() {
        let output = "?? new_file.txt\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert_eq!(unstaged.len(), 1);
        assert_eq!(unstaged[0].status, "U");
        assert_eq!(unstaged[0].file, "new_file.txt");
    }

    #[test]
    fn test_parse_porcelain_status_added_and_deleted() {
        let output = "A  added.txt\nD  removed.txt\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].status, "A");
        assert_eq!(staged[0].file, "added.txt");
        assert_eq!(staged[1].status, "D");
        assert_eq!(staged[1].file, "removed.txt");
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_renamed() {
        let output = "R  src/old.rs -> src/new.rs\n";
        let (staged, _) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].status, "R");
    }

    #[test]
    fn test_parse_porcelain_status_short_lines_skipped() {
        let output = "X\n??\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_ignored_files_excluded() {
        let output = "!! ignored.txt\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_multiple_mixed() {
        let output = "M  staged.rs\n M unstaged.rs\n?? untracked.txt\nA  added.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 2);
        assert_eq!(unstaged.len(), 2);
    }

    // ─── parse_unified_diff ───────────────────────────────────────────────

    #[test]
    fn test_parse_unified_diff_empty() {
        let result = parse_unified_diff("", &[]);
        assert!(result.files.is_empty());
        assert_eq!(result.summary.total_files, 0);
        assert_eq!(result.summary.total_additions, 0);
        assert_eq!(result.summary.total_deletions, 0);
    }

    #[test]
    fn test_parse_unified_diff_simple_modification() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   index 1234..5678 100644\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1,3 +1,3 @@\n\
                    line1\n\
                   -old_line2\n\
                   +new_line2\n\
                    line3\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].filename, "foo.txt");
        assert_eq!(result.files[0].status, "M");
        assert_eq!(result.files[0].additions, 1);
        assert_eq!(result.files[0].deletions, 1);
        assert_eq!(result.summary.total_additions, 1);
        assert_eq!(result.summary.total_deletions, 1);
        assert_eq!(result.files[0].hunks.len(), 1);
    }

    #[test]
    fn test_parse_unified_diff_new_file() {
        let raw = "diff --git a/new.txt b/new.txt\n\
                   new file mode 100644\n\
                   --- /dev/null\n\
                   +++ b/new.txt\n\
                   @@ -0,0 +1,2 @@\n\
                   +hello\n\
                   +world\n";
        let changed = vec![ChangedFile {
            status: "A".to_string(),
            filename: "new.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].filename, "new.txt");
        assert_eq!(result.files[0].additions, 2);
        assert_eq!(result.files[0].deletions, 0);
    }

    #[test]
    fn test_parse_unified_diff_multiple_files() {
        let raw = "diff --git a/a.txt b/a.txt\n\
                   --- a/a.txt\n\
                   +++ b/a.txt\n\
                   @@ -1 +1 @@\n\
                   -old_a\n\
                   +new_a\n\
                   diff --git a/b.txt b/b.txt\n\
                   --- a/b.txt\n\
                   +++ b/b.txt\n\
                   @@ -1,2 +1,3 @@\n\
                    keep\n\
                   +inserted\n\
                    end\n";
        let changed = vec![
            ChangedFile {
                status: "M".to_string(),
                filename: "a.txt".to_string(),
            },
            ChangedFile {
                status: "M".to_string(),
                filename: "b.txt".to_string(),
            },
        ];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.summary.total_additions, 2);
        assert_eq!(result.summary.total_deletions, 1);
    }

    #[test]
    fn test_parse_unified_diff_binary_file() {
        let raw = "diff --git a/img.png b/img.png\n\
                   index 1234..5678 100644\n\
                   Binary files a/img.png and b/img.png differ\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "img.png".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(
            result.files.len(),
            0,
            "binary-only diff has no --- a/ marker, parser yields no file entry"
        );
        let raw_with_marker = "diff --git a/img.png b/img.png\n\
                               --- a/img.png\n\
                               +++ b/img.png\n\
                               Binary files a/img.png and b/img.png differ\n";
        let result2 = parse_unified_diff(raw_with_marker, &changed);
        assert_eq!(result2.files.len(), 1);
        assert!(result2.files[0].binary);
    }

    #[test]
    fn test_parse_unified_diff_status_falls_back_to_modified() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1 +1 @@\n\
                   -a\n\
                   +b\n";
        let changed: Vec<ChangedFile> = vec![];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files[0].status, "M");
    }

    #[test]
    fn test_parse_unified_diff_uses_provided_status() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1 +1 @@\n\
                   -a\n\
                   +b\n";
        let changed = vec![ChangedFile {
            status: "D".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files[0].status, "D");
    }

    #[test]
    fn test_parse_unified_diff_line_numbers_tracked() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -10,3 +10,3 @@\n\
                    ctx_a\n\
                   -old\n\
                   +new\n\
                    ctx_b\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        let lines = &result.files[0].hunks[0].lines;
        assert_eq!(lines[0].line_type, "ctx");
        assert_eq!(lines[0].old_num, Some(10));
        assert_eq!(lines[0].new_num, Some(10));
        assert_eq!(lines[1].line_type, "del");
        assert_eq!(lines[1].old_num, Some(11));
        assert_eq!(lines[1].new_num, None);
        assert_eq!(lines[2].line_type, "add");
        assert_eq!(lines[2].old_num, None);
        assert_eq!(lines[2].new_num, Some(11));
        assert_eq!(lines[3].line_type, "ctx");
        assert_eq!(lines[3].old_num, Some(12));
        assert_eq!(lines[3].new_num, Some(12));
    }

    #[test]
    fn test_parse_unified_diff_multiple_hunks_in_file() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1 +1 @@\n\
                   -a\n\
                   +b\n\
                   @@ -10 +10 @@\n\
                   -c\n\
                   +d\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].hunks.len(), 2);
        assert_eq!(result.files[0].additions, 2);
        assert_eq!(result.files[0].deletions, 2);
    }

    #[test]
    fn tmux_snapshot_only_reports_semantic_changes() {
        let state = AppState::new("zsh", PathBuf::from("."));
        let first = DiscoverySnapshot {
            sessions: vec![TmuxSession {
                name: "one".to_string(),
                windows: 1,
                attached: false,
                last_activity: 1,
            }],
            scanned_at: 100,
            ..DiscoverySnapshot::default()
        };
        assert!(update_tmux_snapshot(&state, first.clone()));
        let mut same = first.clone();
        same.scanned_at = 200;
        assert!(!update_tmux_snapshot(&state, same));
        assert_eq!(get_tmux_snapshot(&state).scanned_at, 200);

        let mut command_changed = first;
        command_changed.sessions[0].last_activity = 2;
        command_changed.scanned_at = 300;
        assert!(update_tmux_snapshot(&state, command_changed));
    }

    #[tokio::test(start_paused = true)]
    async fn tmux_scanner_runs_immediately_then_every_five_seconds() {
        let state = AppState::new("zsh", PathBuf::from("."));
        let calls = Arc::new(AtomicUsize::new(0));
        let scanner_calls = calls.clone();
        start_tmux_discovery_with(
            state.clone(),
            Arc::new(move |_| {
                let call = scanner_calls.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(DiscoverySnapshot {
                    sessions: vec![TmuxSession {
                        name: format!("scan-{call}"),
                        windows: 1,
                        attached: false,
                        last_activity: call as u64,
                    }],
                    scanned_at: call as u64,
                    ..DiscoverySnapshot::default()
                })
            }),
        );

        while get_tmux_snapshot(&state).sessions.is_empty() {
            tokio::task::yield_now().await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_millis(4999)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        while calls.load(Ordering::SeqCst) == 1 {
            tokio::task::yield_now().await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn tmux_list_api_keeps_flat_sessions_and_adds_group_fields() {
        let state = AppState::new("zsh", PathBuf::from("."));
        update_tmux_snapshot(
            &state,
            DiscoverySnapshot {
                sessions: vec![TmuxSession {
                    name: "arbitrary name".to_string(),
                    windows: 2,
                    attached: true,
                    last_activity: 42,
                }],
                scanned_at: 1234,
                ..DiscoverySnapshot::default()
            },
        );
        let response = build_router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/tmux/list")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["sessions"][0]["name"], "arbitrary name");
        assert_eq!(value["scannedAt"], 1234);
        assert!(value["projectGroups"].is_array());
        assert!(value["otherSessions"].is_array());
        assert!(value.get("currentSession").is_some());
    }

    #[test]
    fn herdr_snapshot_helper_sorts_pane_ids() {
        let mut snapshot = serde_json::json!({
            "panes": [
                { "pane_id": "w2:p1", "agent_status": "unknown" },
                { "pane_id": "w1:p1", "agent_status": "idle" },
            ],
            "agents": [
                { "pane_id": "w2:p1", "agent_status": "working" },
            ],
        });
        assert_eq!(herdr_pane_ids(&snapshot), vec!["w1:p1", "w2:p1"]);
        let event = serde_json::json!({
            "event": "pane.agent_status_changed",
            "data": { "pane_id": "w2:p1", "agent_status": "blocked" },
        });
        assert_eq!(
            herdr_status_event(&event),
            Some(("w2:p1".to_string(), "blocked".to_string()))
        );
        apply_herdr_status_overrides(
            &mut snapshot,
            &HashMap::from([("w2:p1".to_string(), "blocked".to_string())]),
        );
        assert_eq!(
            herdr_snapshot_status(&snapshot, "w2:p1").as_deref(),
            Some("blocked")
        );
    }

    #[test]
    fn herdr_bracketed_paste_preserves_text_without_pressing_enter() {
        let text = "第一行\n\n```rust\nlet value = \"保持原样\";\n```\n😀";
        assert_eq!(
            bracketed_paste_text(text),
            "\x1b[200~第一行\r\r```rust\rlet value = \"保持原样\";\r```\r😀\x1b[201~"
        );
    }

    #[test]
    fn herdr_git_context_uses_the_requested_pane_foreground_cwd() {
        let state = AppState::new("zsh", PathBuf::new());
        *state.herdr_snapshot.lock().unwrap() = serde_json::json!({
            "panes": [
                {
                    "pane_id": "w1:p1",
                    "cwd": "/repo/one",
                    "foreground_cwd": "/repo/one/subdir"
                },
                { "pane_id": "w2:p1", "cwd": "/repo/two" }
            ]
        });

        let first = resolve_terminal_cwd(
            &state,
            &TerminalTargetQuery {
                mux: Some("herdr".to_string()),
                pane: Some("w1:p1".to_string()),
                client_tty: None,
            },
        )
        .unwrap();
        let second = resolve_terminal_cwd(
            &state,
            &TerminalTargetQuery {
                mux: Some("herdr".to_string()),
                pane: Some("w2:p1".to_string()),
                client_tty: None,
            },
        )
        .unwrap();

        assert_eq!(first, "/repo/one/subdir");
        assert_eq!(second, "/repo/two");
    }
}
