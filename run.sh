#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi

PORT="${PORT:-7682}"
CMD="${1:-zsh}"
BINARY="$SCRIPT_DIR/server/target/release/rust-terminal"

if [ ! -f "$BINARY" ]; then
    echo "Building Rust backend..."
    cd "$SCRIPT_DIR/server" && cargo build --release
fi

pkill -f "rust-terminal.*--port $PORT" 2>/dev/null || true
sleep 1

nohup "$BINARY" \
    --port "$PORT" \
    --shell "$CMD" \
    --static-dir "$SCRIPT_DIR/frontend/dist" \
    >/dev/null 2>&1 &

sleep 2

if ! pgrep -f "rust-terminal.*--port $PORT" >/dev/null 2>&1; then
    echo "Error: rust-terminal failed to start"
    exit 1
fi

echo ""
echo "=========================================="
echo "  Rust Terminal Started!"
echo "=========================================="
echo ""
echo "  Command: $CMD"
echo "  Port: $PORT"
echo ""
echo "  Access URLs:"
echo "    http://localhost:$PORT"
if [[ "$(uname)" == "Darwin" ]]; then
    ipconfig getifaddr en0 2>/dev/null | while read ip; do
        echo "    http://$ip:$PORT"
    done
else
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | while read ip; do
        echo "    http://$ip:$PORT"
    done
fi
echo ""
echo "  Stop: pkill -f 'rust-terminal.*--port $PORT'"
echo "=========================================="
