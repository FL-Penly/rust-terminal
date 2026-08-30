mod common;

use axum::http::StatusCode;
use common::{
    assert_status, body_json, send_get, send_post_bytes, send_post_json, test_app, EnvGuard,
};
use serde_json::json;
use serial_test::serial;

#[tokio::test]
async fn health_returns_ok_status() {
    let resp = send_get(test_app(), "/api/health").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn client_tty_returns_null_when_no_session_active() {
    let resp = send_get(test_app(), "/api/client-tty").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert!(
        body["client_tty"].is_null() || body["client_tty"].is_string(),
        "client_tty should be null or string, got {:?}",
        body["client_tty"]
    );
}

#[tokio::test]
async fn cwd_returns_path_and_is_git_flag() {
    let resp = send_get(test_app(), "/api/cwd").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert!(body["cwd"].is_string());
    assert!(body["is_git"].is_boolean());
}

#[tokio::test]
async fn herdr_git_context_requires_a_known_pane_and_never_falls_back() {
    let missing = send_get(test_app(), "/api/diff?mux=herdr").await;
    assert_status(&missing, StatusCode::BAD_REQUEST);
    let missing_body = body_json(missing).await;
    assert_eq!(missing_body["error"], "missing_pane");

    let unknown = send_get(test_app(), "/api/diff?mux=herdr&pane=w9:p9").await;
    assert_status(&unknown, StatusCode::NOT_FOUND);
    let unknown_body = body_json(unknown).await;
    assert_eq!(unknown_body["error"], "herdr_pane_cwd_not_found");
}

#[tokio::test]
#[serial]
async fn user_config_post_then_get_round_trips() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);

    let resp = send_post_bytes(
        test_app(),
        "/api/user-config",
        "application/json",
        br#"{"theme":"dark","fontSize":14}"#.to_vec(),
    )
    .await;
    assert_status(&resp, StatusCode::OK);

    let resp2 = send_get(test_app(), "/api/user-config").await;
    assert_status(&resp2, StatusCode::OK);
    let body = body_json(resp2).await;
    assert_eq!(body["theme"], "dark");
    assert_eq!(body["fontSize"], 14);
}

#[tokio::test]
#[serial]
async fn user_config_get_returns_empty_when_file_does_not_exist() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);

    let resp = send_get(test_app(), "/api/user-config").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert!(body.is_object());
    assert_eq!(body.as_object().unwrap().len(), 0);
}

#[tokio::test]
async fn unknown_route_falls_back_to_static_404_when_no_dist() {
    let resp = send_get(test_app(), "/api/this-does-not-exist").await;
    assert!(
        resp.status() == StatusCode::NOT_FOUND || resp.status() == StatusCode::METHOD_NOT_ALLOWED,
        "expected 404 or 405 fallback, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn options_request_includes_cors_headers() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let app = test_app();
    let resp = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/health")
                .header("origin", "http://example.com")
                .header("access-control-request-method", "GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let allow_origin = resp.headers().get("access-control-allow-origin");
    assert!(
        allow_origin.is_some(),
        "expected CORS allow-origin header on OPTIONS preflight"
    );
}

#[tokio::test]
async fn json_error_envelope_for_invalid_branch_checkout() {
    let resp = send_get(test_app(), "/api/git/checkout").await;
    let status = resp.status();
    let body = body_json(resp).await;
    assert!(
        status == StatusCode::BAD_REQUEST,
        "expected 400 for missing branch, got {}",
        status
    );
    assert_eq!(body["error"], "missing_branch");
    assert!(body["message"].is_string());
}

#[tokio::test]
async fn json_error_envelope_for_invalid_tmux_switch() {
    let resp = send_get(test_app(), "/api/tmux/switch").await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "missing_session");
}

#[tokio::test]
async fn json_error_envelope_for_invalid_tmux_create() {
    let resp = send_get(test_app(), "/api/tmux/create").await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "missing_name");
}

#[tokio::test]
async fn json_error_envelope_for_invalid_herdr_focus() {
    let resp = send_get(test_app(), "/api/herdr/focus").await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "missing_pane");
}

#[tokio::test]
async fn json_error_envelope_for_invalid_herdr_create() {
    let resp = send_get(test_app(), "/api/herdr/create").await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "missing_name");
}

#[tokio::test]
async fn json_error_envelope_for_invalid_herdr_close() {
    let resp = send_get(test_app(), "/api/herdr/close").await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "missing_target");
}

#[tokio::test]
async fn herdr_paste_requires_a_target_pane() {
    let resp = send_post_json(
        test_app(),
        "/api/herdr/paste",
        serde_json::json!({ "text": "first\nsecond" }),
    )
    .await;
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "missing_pane");
}

#[tokio::test]
async fn herdr_paste_rejects_empty_text_before_contacting_herdr() {
    let resp = send_post_json(
        test_app(),
        "/api/herdr/paste?pane=w1%3Ap1",
        serde_json::json!({ "text": "" }),
    )
    .await;
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "missing_text");
}

#[tokio::test]
async fn json_error_envelope_for_invalid_tmux_kill() {
    let resp = send_get(test_app(), "/api/tmux/kill").await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "missing_name");
}

#[tokio::test]
async fn git_commit_with_empty_message_returns_400() {
    let resp = common::send_post_json(test_app(), "/api/git/commit", json!({"message": ""})).await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "empty_message");
}

#[tokio::test]
async fn git_commit_with_whitespace_message_returns_400() {
    let resp = common::send_post_json(
        test_app(),
        "/api/git/commit",
        json!({"message": "   \n\t  "}),
    )
    .await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "empty_message");
}

#[tokio::test]
async fn upload_with_empty_body_returns_400() {
    let resp = send_post_bytes(
        test_app(),
        "/api/upload",
        "application/octet-stream",
        vec![],
    )
    .await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "empty_body");
}

#[tokio::test]
#[serial]
async fn dump_file_creates_promptgoal_and_preserves_body() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);
    let content = "  \u{4e2d}\u{6587}\n\nfinal line\n";

    let resp = send_post_bytes(
        test_app(),
        "/api/dump-file",
        "text/plain; charset=utf-8",
        content.as_bytes().to_vec(),
    )
    .await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    let path = std::path::PathBuf::from(body["path"].as_str().unwrap());

    assert!(path.is_absolute());
    assert_eq!(path.parent().unwrap(), tmp.path().join("promptgoal"));
    assert_eq!(path.extension().unwrap(), "md");
    assert_eq!(std::fs::read(path).unwrap(), content.as_bytes());
}

#[tokio::test]
#[serial]
async fn dump_file_rejects_only_a_zero_length_body() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);

    let empty = send_post_bytes(
        test_app(),
        "/api/dump-file",
        "text/plain; charset=utf-8",
        vec![],
    )
    .await;
    assert_status(&empty, StatusCode::BAD_REQUEST);
    assert_eq!(body_json(empty).await["error"], "empty_body");

    let whitespace = send_post_bytes(
        test_app(),
        "/api/dump-file",
        "text/plain; charset=utf-8",
        b"  \n\t".to_vec(),
    )
    .await;
    assert_status(&whitespace, StatusCode::OK);
}

#[tokio::test]
async fn file_diff_with_empty_filename_returns_400() {
    let resp = send_get(test_app(), "/api/git/file-diff?file=").await;
    assert_status(&resp, StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "missing_file");
}
