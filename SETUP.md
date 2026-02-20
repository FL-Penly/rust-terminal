# Setup Guide

This document covers everything needed to build and run Rust Terminal from a fresh clone. The frontend is pre-built and committed as a single HTML file — only the Rust server needs compiling.

## System Requirements

| Requirement | Required | Notes |
|-------------|----------|-------|
| **Rust toolchain** (rustc + cargo) | Yes | Minimum edition 2021. Install via [rustup](https://rustup.rs/) |
| **C compiler + linker** | Yes | Needed by Rust's `portable-pty` crate. Usually `gcc`/`cc` |
| **Linux or macOS** | Yes | Uses Unix PTY (`/dev/pts/`). Windows not supported (WSL works) |
| **tmux** | Recommended | Enables session persistence across disconnects. Without it, the terminal works but sessions are lost on disconnect |
| **Node.js / npm** | No | Frontend is pre-built (`frontend/dist/index.html`). Only needed if modifying frontend source |
| **git** | No | Only needed for the git diff/branch features in the UI |

## Install Dependencies

### Ubuntu / Debian

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Build essentials (C compiler, linker, pkg-config)
sudo apt-get update && sudo apt-get install -y build-essential pkg-config

# tmux (recommended)
sudo apt-get install -y tmux
```

### CentOS / RHEL / Fedora

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Build essentials
sudo yum groupinstall -y "Development Tools"
# or on Fedora/RHEL 8+:
sudo dnf groupinstall -y "Development Tools"

# tmux (recommended)
sudo yum install -y tmux
```

### macOS

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Xcode command line tools (provides C compiler)
xcode-select --install

# tmux (recommended)
brew install tmux
```

### Docker / Minimal Containers

```dockerfile
# Example for Debian-based containers
RUN apt-get update && apt-get install -y \
    curl build-essential pkg-config tmux \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . "$HOME/.cargo/env"
```

## Quick Start

```bash
git clone <repo-url> rust-terminal
cd rust-terminal

# Build and run (first run compiles the Rust binary, takes 1-2 minutes)
./run.sh

# If your system doesn't have zsh, specify bash:
./run.sh bash

# Custom port:
PORT=8080 ./run.sh
```

After startup, access the URL printed in terminal output from your phone or browser.

## What `run.sh` Does

1. Sources `.env` if it exists (for `PORT` config)
2. If the binary doesn't exist, runs `cargo build --release` (~1-2 min first time)
3. Kills any existing instance on the same port
4. Starts the server in background via `nohup`
5. Prints access URLs

The binary is built to `server/target/release/rust-terminal`.

## Verify Installation

```bash
# Check server is running
curl http://localhost:7682/api/health
# Expected: {"status":"ok"}

# Check from another device (replace with your IP)
curl http://<your-ip>:7682/api/health
```

## Stopping the Server

```bash
pkill -f 'rust-terminal.*--port 7682'
```

## Rebuilding

### Server (after modifying `server/src/main.rs`)

```bash
cd server && cargo build --release
# Then restart:
cd .. && ./run.sh
```

### Frontend (after modifying `frontend/src/`)

```bash
cd frontend
npm install    # first time only
npm run build  # outputs to frontend/dist/index.html
cd ..
./run.sh       # restart server to serve new frontend
```

## Troubleshooting

### `cargo build` fails with linker errors

Missing C toolchain. Install build essentials:
```bash
# Ubuntu/Debian
sudo apt-get install -y build-essential pkg-config

# macOS
xcode-select --install
```

### `./run.sh` says "command not found: zsh"

Your system doesn't have zsh. Use bash instead:
```bash
./run.sh bash
```

### Server starts but can't access from phone

- Check firewall: `sudo ufw allow 7682` (Ubuntu) or equivalent
- Ensure phone and server are on the same network
- Try the IP address shown in startup output, not `localhost`

### `hostname -I` error on macOS

This is cosmetic — the server still starts. The startup script uses a Linux-specific command to display IPs. Access via `http://localhost:7682` or find your IP with `ifconfig | grep inet`.

### tmux features not working

Install tmux:
```bash
# Ubuntu/Debian
sudo apt-get install -y tmux

# macOS
brew install tmux
```

Without tmux, the terminal works normally but sessions are not preserved across disconnects.

### Port already in use

```bash
# Kill existing instance
pkill -f 'rust-terminal.*--port 7682'

# Or use a different port
PORT=8080 ./run.sh
```
