use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, Request,
    },
    http::{header, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{any, get, post},
    Json, Router,
};
use bytes::BytesMut;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{

    convert::Infallible,
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command as StdCommand,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

use tower_http::cors::CorsLayer;

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
struct AppState {
    shell: String,
    static_dir: PathBuf,
    client_tty: Arc<Mutex<Option<String>>>,
}

// ─── Main ──────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    // Strip TMUX env vars (like Python version)
    std::env::remove_var("TMUX");
    std::env::remove_var("TMUX_PANE");

    let state = AppState {
        shell: cli.shell.clone(),
        static_dir: cli.static_dir.clone(),
        client_tty: Arc::new(Mutex::new(None)),
    };

    // Build router
    let app = build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], cli.port));
    tracing::info!("Listening on http://0.0.0.0:{}", cli.port);

    // Print access URLs
    print_access_urls(cli.port);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
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

fn build_router(state: AppState) -> Router {
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
        .route("/api/tmux/list", get(api_tmux_list))
        .route("/api/tmux/switch", get(api_tmux_switch))
        .route("/api/tmux/create", get(api_tmux_create))
        .route("/api/tmux/kill", get(api_tmux_kill))
        .route("/api/tmux/detach", get(api_tmux_detach))
        .route("/api/events", get(api_events))
        .route("/api/upload-image", post(api_upload_image))
        // Static file serving — catch-all for frontend
        .fallback(move |req: Request| serve_static(req, static_dir.clone()))
        .layer(cors)
        .with_state(state)
}

// ═══════════════════════════════════════════════════════════════════════════
// STATIC FILE SERVING
// ═══════════════════════════════════════════════════════════════════════════

async fn serve_static(req: Request, static_dir: PathBuf) -> Response {
    let path = req.uri().path().trim_start_matches('/');

    // Try to serve the requested file
    let file_path = static_dir.join(if path.is_empty() { "index.html" } else { path });

    if file_path.exists() && file_path.is_file() {
        serve_file(&file_path).await
    } else {
        // SPA fallback: serve index.html for unknown routes
        let index = static_dir.join("index.html");
        if index.exists() {
            serve_file(&index).await
        } else {
            (StatusCode::NOT_FOUND, "Frontend not built. Run: cd frontend && npm run build").into_response()
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

async fn ws_handler(
    ws: WebSocketUpgrade,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Response {
    ws.protocols(["tty"])
        .on_upgrade(move |socket| handle_terminal(socket, state))
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

    // Step 2: Generate and write wrapper script
    let wrapper_path = "/tmp/rust_terminal_wrapper.sh";
    let tty_file = "/tmp/ttyd_client_tty";
    let cwd_file = "/tmp/ttyd_cwd";
    write_wrapper_script(wrapper_path, &state.shell, tty_file, cwd_file);

    // Step 3: Spawn PTY
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: init_rows,
        cols: init_cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::error!("Failed to open PTY: {}", e);
            let _ = ws_sender
                .send(Message::Binary(
                    format!("\x30Error: Failed to open PTY: {}\r\n", e).into(),
                ))
                .await;
            return;
        }
    };

    let mut cmd = CommandBuilder::new(wrapper_path);
    cmd.env("TERM", "xterm-256color");
    // Remove TMUX vars from PTY child
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");

    let _child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            tracing::error!("Failed to spawn shell: {}", e);
            let _ = ws_sender
                .send(Message::Binary(
                    format!("\x30Error: Failed to spawn shell: {}\r\n", e).into(),
                ))
                .await;
            return;
        }
    };

    // Drop slave end so child gets EOF when master closes
    drop(pair.slave);

    // Get reader and writer
    let mut pty_reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Failed to clone PTY reader: {}", e);
            return;
        }
    };
    let pty_writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("Failed to take PTY writer: {}", e);
            return;
        }
    };
    let pty_writer = Arc::new(Mutex::new(pty_writer));

    // Keep master alive for resize
    let master = Arc::new(Mutex::new(pair.master));

    // Flow control: shared pause signal between PTY reader thread and WebSocket receiver
    let paused = Arc::new((Mutex::new(false), Condvar::new()));
    let paused_reader = paused.clone();

    // Channel: PTY output → WebSocket sender
    let (output_tx, mut output_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // PTY reader thread (blocking I/O → separate thread)
    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 32768];
        loop {
            // Flow control: wait if paused (auto-resume after 2s)
            {
                let (lock, cvar) = &*paused_reader;
                let mut is_paused = lock.lock().unwrap();
                if *is_paused {
                    let result = cvar.wait_timeout(is_paused, Duration::from_secs(2)).unwrap();
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
                    if output_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Client TTY tracking
    let client_tty_shared = state.client_tty.clone();

    // Per-connection tty tracking (for safe cleanup independent of global state)
    // Prevents race condition where a new connection's tty gets detached by old cleanup.
    let connection_tty: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let connection_tty_sender = connection_tty.clone();

    // ── ADAPTIVE BATCHING: WebSocket sender task ──
    // Adaptive batching: 4ms idle flush, 32KB cap.
    let sender_task = tokio::spawn(async move {
        let mut buffer = BytesMut::with_capacity(16384);
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
                                    if tty.starts_with("/dev/pts/") {
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

                    let deadline = tokio::time::Instant::now() + Duration::from_millis(4);
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
                                                        if tty.starts_with("/dev/pts/") {
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
                                        if buffer.len() > 32768 {
                                            break;
                                        }
                                    }
                                    None => {
                                        if !buffer.is_empty() {
                                            let mut frame = Vec::with_capacity(buffer.len() + 1);
                                            frame.push(0x30);
                                            frame.extend_from_slice(&buffer);
                                            let _ = ws_sender.send(Message::Binary(frame.into())).await;
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
                        let mut frame = Vec::with_capacity(buffer.len() + 1);
                        frame.push(0x30); // ttyd output prefix
                        frame.extend_from_slice(&buffer);
                        buffer.clear();
                        if ws_sender.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                    }
                }
                None => {
                    if !buffer.is_empty() {
                        let mut frame = Vec::with_capacity(buffer.len() + 1);
                        frame.push(0x30);
                        frame.extend_from_slice(&buffer);
                        let _ = ws_sender.send(Message::Binary(frame.into())).await;
                    }
                    break;
                }
            }
        }
    });

    // ── WebSocket receiver task: client → PTY ──
    let pty_writer_recv = pty_writer.clone();
    let master_recv = master.clone();
    let paused_recv = paused.clone();

    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Binary(data) => {
                    if data.is_empty() {
                        continue;
                    }
                    let cmd = data[0];
                    let payload = &data[1..];

                    match cmd {
                        // 0x30 = '0' = terminal input
                        0x30 => {
                            if let Ok(mut writer) = pty_writer_recv.lock() {
                                let _ = writer.write_all(payload);
                                let _ = writer.flush();
                            }
                        }
                        // 0x31 = '1' = resize
                        0x31 => {
                            if let Ok(text) = std::str::from_utf8(payload) {
                                if let Ok(resize) =
                                    serde_json::from_str::<ResizeMessage>(text)
                                {
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
                        // 0x32 = flow control: pause
                        0x32 => {
                            let (lock, _cvar) = &*paused_recv;
                            if let Ok(mut is_paused) = lock.lock() {
                                *is_paused = true;
                            }
                        }
                        // 0x33 = flow control: resume
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

    // Wait for either task to finish
    tokio::select! {
        _ = sender_task => {},
        _ = recv_task => {},
    }

    // Ensure PTY reader thread is unpaused so it can exit cleanly
    {
        let (lock, cvar) = &*paused;
        if let Ok(mut is_paused) = lock.lock() {
            *is_paused = false;
            cvar.notify_one();
        }
    }

    // Gracefully detach tmux client before the child process is killed,
    // preventing SIGHUP cascade that can destroy tmux sessions.
    // Use per-connection tty (not global) to avoid race with concurrent connections.
    let cleanup_tty = connection_tty.lock().ok().and_then(|lock| lock.clone());
    if let Some(ref tty) = cleanup_tty {
        if let Err(e) = run_cmd("tmux", &["detach-client", "-t", tty]) {
            tracing::warn!("tmux detach-client failed: {}", e);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // Only clear global tty if it still belongs to this connection (compare-and-swap)
    if let Ok(mut lock) = state.client_tty.lock() {
        if *lock == cleanup_tty {
            *lock = None;
        }
    }

    let _ = reader_handle;
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
if tmux has-session 2>/dev/null; then
    tmux set -g window-size latest 2>/dev/null
    tmux attach
fi
ZDOTDIR={} exec {}
"#,
            tty_file, zdotdir, shell
        );
        let _ = std::fs::write(path, script);
    } else if is_bash {
        let bashrc = format!(
            r#"[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
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
if tmux has-session 2>/dev/null; then
    tmux set -g window-size latest 2>/dev/null
    tmux attach
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
if tmux has-session 2>/dev/null; then
    tmux set -g window-size latest 2>/dev/null
    tmux attach
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
    let tty = get_client_tty_from_state(&state);
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
    let tty_from_file = std::fs::read_to_string("/tmp/ttyd_client_tty")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Verify against current tmux clients
    if let Ok(output) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
        let clients: Vec<&str> = output.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();

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
    let cwd = get_cwd(get_effective_client_tty(&state, None));
    let is_git = is_git_repo(&cwd);
    Json(serde_json::json!({ "cwd": cwd, "is_git": is_git }))
}

fn get_effective_client_tty(state: &AppState, explicit: Option<String>) -> Option<String> {
    explicit.or_else(|| get_client_tty_from_state(state))
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
    if let Ok(content) = std::fs::read_to_string("/tmp/ttyd_cwd") {
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
    // Get session name for this client
    let session = run_cmd(
        "tmux",
        &["display-message", "-c", client_tty, "-p", "#{client_session}"],
    )
    .ok()?;
    let session = session.trim();
    if session.is_empty() {
        return None;
    }

    // Get pane path for session
    let path = run_cmd(
        "tmux",
        &["display-message", "-t", session, "-p", "#{pane_current_path}"],
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

    let remote = run_cmd_in(
        "git",
        &["branch", "-r", "--format=%(refname:short)"],
        path,
    )
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
        if line.starts_with("+++ b/") {
            if current_filename.is_empty() {
                current_filename = line[6..].to_string();
            }
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
        } else if line.starts_with("diff --git") {
            continue;
        } else if line.starts_with("index ") || line.starts_with("new file") || line.starts_with("deleted file") {
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

fn get_files_diff(git_root: &str) -> DiffResult {
    let _ = run_cmd_in("git", &["add", "-N", "."], git_root);

    let raw = match run_cmd_in("git", &["diff", "-U3"], git_root) {
        Ok(o) => o,
        Err(_) => return DiffResult {
            files: vec![],
            summary: DiffSummary { total_files: 0, total_additions: 0, total_deletions: 0 },
        },
    };

    let changed_files = get_changed_files(git_root);
    parse_unified_diff(&raw, &changed_files)
}

// ─── GET /api/diff ─────────────────────────────────────────────────────────

async fn api_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Response {
    let cwd = get_cwd(get_effective_client_tty(&state, None));

    if !is_git_repo(&cwd) {
        return Json(serde_json::json!({
            "error": "not_git_repo",
            "message": format!("'{}' is not a git repository", cwd),
            "cwd": cwd,
        }))
        .into_response();
    }

    let git_root = get_git_root(&cwd);
    let branch = get_branch(&git_root);

    // Run diff in blocking task (subprocess I/O)
    let git_root_clone = git_root.clone();
    let diff_data = tokio::task::spawn_blocking(move || get_files_diff(&git_root_clone))
        .await
        .unwrap_or_else(|_| DiffResult {
            files: vec![],
            summary: DiffSummary {
                total_files: 0,
                total_additions: 0,
                total_deletions: 0,
            },
        });

    Json(serde_json::json!({
        "cwd": cwd,
        "git_root": git_root,
        "branch": branch,
        "files": diff_data.files,
        "summary": diff_data.summary,
    }))
    .into_response()
}

// ─── GET /api/git/branches ─────────────────────────────────────────────────

async fn api_git_branches(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Response {
    let cwd = get_cwd(get_effective_client_tty(&state, None));

    if !is_git_repo(&cwd) {
        return json_error("not_git_repo", "Not a git repository", StatusCode::BAD_REQUEST);
    }

    let git_root = get_git_root(&cwd);
    let branches = get_all_branches(&git_root);
    json_response(&branches)
}

// ─── GET /api/git/checkout ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct CheckoutQuery {
    branch: Option<String>,
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

    let cwd = get_cwd(get_effective_client_tty(&state, None));
    if !is_git_repo(&cwd) {
        return json_error("not_git_repo", "Not a git repository", StatusCode::BAD_REQUEST);
    }

    let git_root = get_git_root(&cwd);

    match run_cmd_in("git", &["checkout", &branch], &git_root) {
        Ok(_) => Json(serde_json::json!({ "success": true, "branch": branch })).into_response(),
        Err(msg) => json_error("checkout_failed", &msg, StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── Tmux Operations ──────────────────────────────────────────────────────

fn get_tmux_sessions() -> Vec<TmuxSession> {
    match run_cmd(
        "tmux",
        &["ls", "-F", "#{session_name}:#{session_windows}:#{session_attached}"],
    ) {
        Ok(output) => output
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split(':').collect();
                if parts.len() >= 3 {
                    Some(TmuxSession {
                        name: parts[0].to_string(),
                        windows: parts[1].parse().unwrap_or(0),
                        attached: parts[2].parse::<i32>().unwrap_or(0) > 0,
                    })
                } else {
                    None
                }
            })
            .collect(),
        Err(_) => vec![],
    }
}

fn get_current_tmux_session(client_tty: Option<&str>) -> Option<String> {
    let tty = client_tty?;

    let output = run_cmd("tmux", &["list-clients", "-F", "#{client_tty} #{client_session}"]).ok()?;

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
    let sessions = get_tmux_sessions();
    let client_tty = get_effective_client_tty(&state, query.client_tty);
    let current = get_current_tmux_session(client_tty.as_deref());

    Json(serde_json::json!({
        "sessions": sessions,
        "currentSession": current,
    }))
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

    let client_tty = match get_effective_client_tty(&state, query.client_tty) {
        Some(tty) => tty,
        None => {
            return json_error(
                "missing_client_tty",
                "client_tty required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    // Verify client is connected to tmux
    if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
        if !clients.contains(&client_tty) {
            return json_error(
                "switch_failed",
                &format!("Client {} not attached to tmux", client_tty),
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    match run_cmd(
        "tmux",
        &["switch-client", "-c", &client_tty, "-t", &session],
    ) {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(msg) => json_error("switch_failed", &msg, StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/create ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxCreateQuery {
    name: Option<String>,
    client_tty: Option<String>,
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

    let client_tty = match get_effective_client_tty(&state, query.client_tty) {
        Some(tty) => tty,
        None => {
            return json_error(
                "missing_client_tty",
                "client_tty required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let _ = run_cmd("tmux", &["new-session", "-d", "-s", &name]);

    match run_cmd(
        "tmux",
        &["switch-client", "-c", &client_tty, "-t", &name],
    ) {
        Ok(_) => Json(serde_json::json!({
            "success": true,
            "message": format!("Session '{}' created", name),
        }))
        .into_response(),
        Err(msg) => json_error("create_failed", &msg, StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/kill ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxKillQuery {
    name: Option<String>,
}

async fn api_tmux_kill(Query(query): Query<TmuxKillQuery>) -> Response {
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

    match run_cmd("tmux", &["kill-session", "-t", &name]) {
        Ok(_) => Json(serde_json::json!({
            "success": true,
            "message": format!("Session '{}' killed", name),
        }))
        .into_response(),
        Err(_) => json_error(
            "kill_failed",
            &format!("Failed to kill session '{}'", name),
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
    let client_tty = match get_effective_client_tty(&state, query.client_tty) {
        Some(tty) => tty,
        None => {
            return json_error(
                "missing_client_tty",
                "client_tty required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    // Verify client is connected to tmux
    if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
        if !clients.contains(&client_tty) {
            return json_error(
                "detach_failed",
                &format!("Client {} not attached to tmux", client_tty),
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    match run_cmd("tmux", &["detach-client", "-t", &client_tty]) {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(msg) => json_error("detach_failed", &msg, StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/events (SSE) ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct EventsQuery {
    client_tty: Option<String>,
}

async fn api_events(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<EventsQuery>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let explicit_tty = query.client_tty.clone();
    let shared_state = state.clone();

    let stream = futures_util::stream::unfold(true, move |is_first| {
        let explicit_tty = explicit_tty.clone();
        let shared_state = shared_state.clone();
        async move {
            if !is_first {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }

            let client_tty = get_effective_client_tty(&shared_state, explicit_tty);
            let tty_clone = client_tty.clone();

            let payload = tokio::task::spawn_blocking(move || {
                let cwd = get_cwd(tty_clone.clone());
                let mut branch = String::new();
                let mut path = cwd.clone();

                if is_git_repo(&cwd) {
                    let git_root = get_git_root(&cwd);
                    branch = get_branch(&git_root);
                    path = git_root;
                }

                let sessions = get_tmux_sessions();
                let current_session = get_current_tmux_session(tty_clone.as_deref());

                serde_json::json!({
                    "branch": branch,
                    "path": path,
                    "tmux": {
                        "sessions": sessions,
                        "currentSession": current_session,
                    }
                })
            })
            .await
            .unwrap_or_else(|_| serde_json::json!({}));

            let event = Event::default().data(payload.to_string());
            Some((Ok(event), false))
        }
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

// ─── POST /api/upload-image ────────────────────────────────────────────────

async fn api_upload_image(req: Request) -> Response {
    let content_type = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !content_type.starts_with("image/") {
        return json_error(
            "invalid_content_type",
            "Expected image/*",
            StatusCode::BAD_REQUEST,
        );
    }

    // Read body
    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            return json_error("read_error", "Failed to read body", StatusCode::BAD_REQUEST)
        }
    };

    if body_bytes.is_empty() {
        return json_error("empty_body", "No image data", StatusCode::BAD_REQUEST);
    }

    // Determine extension
    let ext = if content_type.contains("jpeg") || content_type.contains("jpg") {
        "jpg"
    } else if content_type.contains("gif") {
        "gif"
    } else if content_type.contains("webp") {
        "webp"
    } else {
        "png"
    };

    // Create upload directory
    let upload_dir = "/tmp/ttyd_images";
    let _ = std::fs::create_dir_all(upload_dir);

    // Generate filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("screenshot_{}.{}", timestamp, ext);
    let filepath = format!("{}/{}", upload_dir, filename);

    // Write file
    match std::fs::write(&filepath, &body_bytes) {
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

#[derive(Serialize, Clone)]
struct TmuxSession {
    name: String,
    windows: i32,
    attached: bool,
}

struct ChangedFile {
    status: String,
    filename: String,
}

#[derive(Serialize)]
struct DiffLine {
    #[serde(rename = "type")]
    line_type: String, // "add", "del", "ctx"
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

struct DiffResult {
    files: Vec<DiffFile>,
    summary: DiffSummary,
}

// ═══════════════════════════════════════════════════════════════════════════
// SUBPROCESS HELPERS
// ═══════════════════════════════════════════════════════════════════════════

fn run_cmd(cmd: &str, args: &[&str]) -> Result<String, String> {
    match StdCommand::new(cmd)
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
