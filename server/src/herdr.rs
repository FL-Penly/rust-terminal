use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    net::UnixStream,
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub const SUPPORTED_PROTOCOL: u64 = 20;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub enum TerminalEvent {
    Frame(bytes::Bytes),
    Closed(String),
}

pub struct TerminalController {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

pub struct TerminalProcess {
    #[allow(dead_code)]
    child: Child,
}

pub struct TerminalReader {
    stdout: Lines<BufReader<ChildStdout>>,
}

pub struct TerminalWriter {
    stdin: ChildStdin,
}

pub struct EventSubscription {
    reader: Lines<BufReader<UnixStream>>,
}

impl TerminalController {
    pub async fn spawn(pane_id: &str, cols: u16, rows: u16) -> Result<Self, String> {
        if pane_id.trim().is_empty() {
            return Err("pane id is required".to_string());
        }

        let mut child = Command::new(herdr_binary())
            .args([
                "terminal",
                "session",
                "control",
                pane_id,
                "--takeover",
                "--cols",
                &cols.max(1).to_string(),
                "--rows",
                &rows.max(1).to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Failed to start herdr terminal controller: {}", error))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open herdr controller stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open herdr controller stdout".to_string())?;

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!("herdr terminal controller: {}", line);
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
        })
    }

    pub fn split(self) -> (TerminalProcess, TerminalReader, TerminalWriter) {
        (
            TerminalProcess { child: self.child },
            TerminalReader {
                stdout: self.stdout,
            },
            TerminalWriter { stdin: self.stdin },
        )
    }
}

impl TerminalReader {
    pub async fn next_event(&mut self) -> Result<TerminalEvent, String> {
        match self.stdout.next_line().await {
            Ok(Some(line)) => parse_terminal_line(&line),
            Ok(None) => Err("herdr terminal controller closed its output stream".to_string()),
            Err(error) => Err(format!("Failed reading herdr terminal stream: {}", error)),
        }
    }
}

impl TerminalWriter {
    pub async fn send_input(&mut self, data: &[u8]) -> Result<(), String> {
        self.write_command(json!({
            "type": "terminal.input",
            "bytes": BASE64.encode(data),
        }))
        .await
    }

    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.write_command(json!({
            "type": "terminal.resize",
            "cols": cols.max(1),
            "rows": rows.max(1),
        }))
        .await
    }

    pub async fn scroll(&mut self, direction: &str, lines: u32) -> Result<(), String> {
        self.write_command(json!({
            "type": "terminal.scroll",
            "direction": direction,
            "lines": lines.max(1),
        }))
        .await
    }

    pub async fn release(&mut self) -> Result<(), String> {
        self.write_command(json!({ "type": "terminal.release" }))
            .await
    }

    async fn write_command(&mut self, command: Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&command)
            .map_err(|error| format!("Failed encoding herdr terminal command: {}", error))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Failed writing herdr terminal command: {}", error))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Failed flushing herdr terminal command: {}", error))
    }
}

pub async fn request(method: &str, params: Value) -> Result<Value, String> {
    let socket_path = socket_path()?;
    let mut stream = UnixStream::connect(&socket_path).await.map_err(|error| {
        format!(
            "Failed to connect to herdr at {}: {}",
            socket_path.display(),
            error
        )
    })?;
    let id = format!(
        "rust-terminal:{}",
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let envelope = request_envelope(&id, method, params);
    let mut encoded = serde_json::to_vec(&envelope)
        .map_err(|error| format!("Failed encoding herdr request: {}", error))?;
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .await
        .map_err(|error| format!("Failed writing herdr request: {}", error))?;
    stream
        .flush()
        .await
        .map_err(|error| format!("Failed flushing herdr request: {}", error))?;

    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .map_err(|error| format!("Failed reading herdr response: {}", error))?;
    if response.trim().is_empty() {
        return Err("herdr returned an empty response".to_string());
    }

    parse_response(&id, &response)
}

pub async fn list() -> Result<Value, String> {
    let (panes, workspaces, agents) = tokio::try_join!(
        request("pane.list", json!({})),
        request("workspace.list", json!({})),
        request("agent.list", json!({})),
    )?;

    Ok(json!({
        "mux": "herdr",
        "protocol": SUPPORTED_PROTOCOL,
        "panes": panes.get("panes").cloned().unwrap_or_else(|| json!([])),
        "workspaces": workspaces.get("workspaces").cloned().unwrap_or_else(|| json!([])),
        "agents": agents.get("agents").cloned().unwrap_or_else(|| json!([])),
    }))
}

pub async fn protocol_version() -> Result<u64, String> {
    let output = Command::new(herdr_binary())
        .args(["api", "schema", "--json"])
        .output()
        .await
        .map_err(|error| format!("Failed to inspect herdr protocol: {}", error))?;
    if !output.status.success() {
        return Err(format!(
            "herdr api schema failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let schema: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid herdr schema output: {}", error))?;
    schema
        .get("protocol")
        .and_then(Value::as_u64)
        .ok_or_else(|| "herdr schema did not include protocol".to_string())
}

fn herdr_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("HERDR_BIN_PATH").filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }

    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/herdr"),
        PathBuf::from("/usr/local/bin/herdr"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/herdr"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("herdr"))
}

impl EventSubscription {
    pub async fn connect(pane_ids: &[String]) -> Result<Self, String> {
        let socket_path = socket_path()?;
        let mut stream = UnixStream::connect(&socket_path).await.map_err(|error| {
            format!(
                "Failed to connect to herdr events at {}: {}",
                socket_path.display(),
                error
            )
        })?;
        let id = format!(
            "rust-terminal-events:{}",
            NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        let mut subscriptions = vec![json!({ "type": "pane.agent_detected" })];
        subscriptions.extend(pane_ids.iter().map(|pane_id| {
            json!({
                "type": "pane.agent_status_changed",
                "pane_id": pane_id,
            })
        }));
        let envelope = request_envelope(
            &id,
            "events.subscribe",
            json!({ "subscriptions": subscriptions }),
        );
        let mut encoded = serde_json::to_vec(&envelope)
            .map_err(|error| format!("Failed encoding herdr subscription: {}", error))?;
        encoded.push(b'\n');
        stream
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Failed writing herdr subscription: {}", error))?;
        stream
            .flush()
            .await
            .map_err(|error| format!("Failed flushing herdr subscription: {}", error))?;

        let mut reader = BufReader::new(stream).lines();
        let acknowledgement = reader
            .next_line()
            .await
            .map_err(|error| format!("Failed reading herdr subscription response: {}", error))?
            .ok_or_else(|| "herdr closed the subscription before acknowledgement".to_string())?;
        parse_response(&id, &acknowledgement)?;
        Ok(Self { reader })
    }

    pub async fn next_event(&mut self) -> Result<Value, String> {
        let line = self
            .reader
            .next_line()
            .await
            .map_err(|error| format!("Failed reading herdr event: {}", error))?
            .ok_or_else(|| "herdr event subscription disconnected".to_string())?;
        let value: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Invalid herdr event: {}", error))?;
        if value.get("event").and_then(Value::as_str).is_none() {
            return Err("herdr event did not include event name".to_string());
        }
        Ok(value)
    }
}

fn request_envelope(id: &str, method: &str, params: Value) -> Value {
    json!({
        "id": id,
        "method": method,
        "params": params,
    })
}

fn parse_response(expected_id: &str, response: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(response)
        .map_err(|error| format!("Invalid herdr response: {}", error))?;
    if value.get("id").and_then(Value::as_str) != Some(expected_id) {
        return Err("herdr response id did not match request".to_string());
    }
    if let Some(error) = value.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("unknown_error");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown herdr error");
        return Err(format!("{}: {}", code, message));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "herdr response did not include result".to_string())
}

fn parse_terminal_line(line: &str) -> Result<TerminalEvent, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("Invalid herdr terminal message: {}", error))?;
    match value.get("type").and_then(Value::as_str) {
        Some("terminal.frame") => {
            let encoded = value
                .get("bytes")
                .and_then(Value::as_str)
                .ok_or_else(|| "herdr terminal frame did not include bytes".to_string())?;
            BASE64
                .decode(encoded)
                .map(bytes::Bytes::from)
                .map(TerminalEvent::Frame)
                .map_err(|error| format!("Invalid base64 in herdr terminal frame: {}", error))
        }
        Some("terminal.closed") => Ok(TerminalEvent::Closed(
            value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("herdr terminal controller closed")
                .to_string(),
        )),
        Some(message_type) => Err(format!(
            "Unexpected herdr terminal message type: {}",
            message_type
        )),
        None => Err("herdr terminal message did not include type".to_string()),
    }
}

fn socket_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("HERDR_SOCKET_PATH") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set and HERDR_SOCKET_PATH was not provided".to_string())?;
    Ok(PathBuf::from(home).join(".config/herdr/herdr.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_envelope_always_includes_method_and_params() {
        let value = request_envelope("request-1", "pane.list", json!({}));
        assert_eq!(value["id"], "request-1");
        assert_eq!(value["method"], "pane.list");
        assert_eq!(value["params"], json!({}));
        assert!(value.get("type").is_none());
    }

    #[test]
    fn parses_success_and_error_responses() {
        let success = parse_response(
            "request-1",
            r#"{"id":"request-1","result":{"type":"pong"}}"#,
        )
        .unwrap();
        assert_eq!(success["type"], "pong");

        let error = parse_response(
            "request-2",
            r#"{"id":"request-2","error":{"code":"not_found","message":"missing"}}"#,
        )
        .unwrap_err();
        assert_eq!(error, "not_found: missing");
    }

    #[test]
    fn decodes_terminal_frames_and_preserves_close_reason() {
        let event = parse_terminal_line(
            r#"{"type":"terminal.frame","seq":1,"bytes":"G1sySGkbWzBt","encoding":"ansi","full":true,"width":80,"height":24}"#,
        )
        .unwrap();
        match event {
            TerminalEvent::Frame(data) => assert_eq!(data.as_ref(), b"\x1b[2Hi\x1b[0m"),
            TerminalEvent::Closed(_) => panic!("expected terminal frame"),
        }

        let event = parse_terminal_line(
            r#"{"type":"terminal.closed","reason":"terminal attach taken over"}"#,
        )
        .unwrap();
        match event {
            TerminalEvent::Closed(reason) => {
                assert_eq!(reason, "terminal attach taken over")
            }
            TerminalEvent::Frame(_) => panic!("expected terminal close"),
        }
    }
}
