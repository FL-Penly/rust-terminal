#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

export NODE_PATH="$(npm root -g 2>/dev/null || echo "")"

BENCH_PORT="${BENCH_PORT:-17682}"
SERVER_BIN="$REPO_ROOT/server/target/release/rust-terminal"

if [[ ! -f "$SERVER_BIN" ]]; then
    echo "ERROR: Release binary not found. Run: cd server && cargo build --release"
    exit 1
fi

echo "=== Web Terminal Performance Benchmark ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Using isolated server on port $BENCH_PORT"
echo ""

BENCH_FAKE_BIN="/tmp/bench_notmux_$$"
mkdir -p "$BENCH_FAKE_BIN"
printf '#!/bin/sh\nexit 1\n' > "$BENCH_FAKE_BIN/tmux"
chmod +x "$BENCH_FAKE_BIN/tmux"
trap 'kill $BENCH_PID 2>/dev/null || true; rm -rf "$BENCH_FAKE_BIN"' EXIT

PATH="$BENCH_FAKE_BIN:$PATH" "$SERVER_BIN" --port "$BENCH_PORT" --shell sh \
    --static-dir "$REPO_ROOT/frontend/dist" &>/tmp/bench_server.log &
BENCH_PID=$!

for i in $(seq 1 20); do
    if curl -sf "http://localhost:$BENCH_PORT/api/health" >/dev/null 2>&1; then
        break
    fi
    sleep 0.3
done
if ! curl -sf "http://localhost:$BENCH_PORT/api/health" >/dev/null 2>&1; then
    echo "ERROR: Bench server failed to start. Log:"
    cat /tmp/bench_server.log
    exit 1
fi
echo "✓ Bench server started (pid $BENCH_PID)"
echo ""

export BENCH_PORT

echo "--- Throughput Test ---"
node "$SCRIPT_DIR/throughput.js"
echo ""

echo "--- Latency Test ---"
node "$SCRIPT_DIR/latency.js"
echo ""

echo "--- Memory Test ---"
node "$SCRIPT_DIR/memory.js"
echo ""

echo "=== Benchmark Complete ==="
