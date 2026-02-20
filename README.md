# Rust Terminal

A mobile-optimized web terminal powered by a single Rust binary. Access your development terminal from your phone — operate AI coding tools like Claude Code, OpenCode on the go.

## Features

- Single Rust binary — zero external dependencies
- Mobile-optimized virtual keyboard (ESC, Tab, Ctrl+C, arrow keys)
- Expandable toolbar (▲/▼ toggle for narrow screens)
- Customizable quick command buttons
- Text input modal (easier long text input on mobile)
- Status bar (connection state, git branch, token count)
- Tmux session management (reconnect without losing context)
- Git Diff viewer (card-based, per-file hunk navigation)
- Git branch selector with checkout support
- Image paste and upload support
- Pinch-to-zoom with persistent font size
- Single-finger touch scroll in TUI apps (tmux, vim)
- iTerm2-style drag-to-select text in tmux
- Copy viewport overlay for mobile text selection
- Predictive echo for reduced input latency
- WebGL/Canvas accelerated rendering with auto-fallback

## Quick Start

```bash
# Build and run (first run compiles the Rust binary)
./run.sh

# Or specify a shell
./run.sh bash

# Custom port
PORT=8080 ./run.sh
```

After startup, access the URL shown in terminal output from your phone.

## Prerequisites

- Rust toolchain (for building)
- Node.js (for building frontend, only needed once)

### Building

```bash
# Build frontend
cd frontend && npm install && npm run build && cd ..

# Build server (or just run ./run.sh which auto-builds)
cd server && cargo build --release
```

## Architecture

```
Phone ──HTTP/WS──▶ Rust Server (:7682)
                    ├── WebSocket /ws     → PTY (terminal)
                    ├── GET /api/*        → Git, Tmux, CWD APIs
                    ├── POST /api/*       → Image upload
                    ├── GET /api/events   → SSE (status updates)
                    └── GET /*            → Static files (frontend)
```

Everything runs in a single process. No external dependencies at runtime.

## Configuration

```bash
cp .env.example .env
```

| Config | Description | Default |
|--------|-------------|---------|
| `PORT` | Server port | 7682 |

## Features Detail

### Tmux Session Management

Tmux buttons in the status bar allow you to:
- Create new sessions
- Switch between sessions
- Detach to plain shell
- Kill sessions (long-press)

**Why Tmux?** Mobile browsers disconnect WebSocket when backgrounded. After reconnecting, a new shell starts. Using tmux preserves your session — just reattach after reconnection.

### Git Diff Viewer

Click the green "Diff" button in the toolbar to view Git changes in the current directory.

CWD tracking is set up automatically via the shell wrapper script. If you need manual setup:

```bash
# zsh (~/.zshrc)
precmd() { echo $PWD > /tmp/ttyd_cwd; }

# bash (~/.bashrc)
PROMPT_COMMAND='echo $PWD > /tmp/ttyd_cwd'
```

### Custom Command Buttons

The ⚙️ button in the toolbar allows you to:
- Show/hide default commands
- Add custom command buttons

Configuration is saved in browser localStorage.

### Copy Viewport

The purple "Sel" button opens a full-screen text overlay of the terminal buffer, allowing you to select and copy text on mobile — where native terminal text selection is difficult.

## File Structure

```
├── run.sh               # Build & run script
├── .env.example         # Config template
├── server/
│   ├── Cargo.toml       # Rust dependencies
│   └── src/main.rs      # Unified server (WebSocket + HTTP API + static files)
└── frontend/
    ├── package.json     # Build dependencies
    ├── src/             # React + TypeScript source
    └── dist/            # Built frontend (served by Rust)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ws` | WebSocket | Terminal PTY connection |
| `/api/health` | GET | Health check |
| `/api/client-tty` | GET | Current client TTY |
| `/api/cwd` | GET | Current working directory |
| `/api/diff` | GET | Git diff data |
| `/api/git/branches` | GET | List branches |
| `/api/git/checkout` | GET | Checkout branch |
| `/api/tmux/list` | GET | List tmux sessions |
| `/api/tmux/switch` | GET | Switch tmux session |
| `/api/tmux/create` | GET | Create tmux session |
| `/api/tmux/kill` | GET | Kill tmux session |
| `/api/tmux/detach` | GET | Detach from tmux |
| `/api/events` | GET | SSE status stream |
| `/api/upload-image` | POST | Upload image file |
