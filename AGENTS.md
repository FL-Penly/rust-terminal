# AGENTS.md — Rust Terminal

Mobile-optimized web terminal: Rust/Axum backend + React/TypeScript frontend, served as a single binary.

## Architecture

```
server/src/main.rs    — Single-file Rust server (~1461 lines): WebSocket PTY, HTTP API, static serving
frontend/src/         — React 18 + TypeScript + Vite + Tailwind CSS SPA (built as single HTML file)
run.sh                — Build & run script (auto-builds if binary missing)
```

The server spawns a PTY via `portable-pty`, bridges it over WebSocket using the ttyd protocol,
and exposes REST/SSE endpoints for git, tmux, and CWD tracking. The frontend is bundled into
a single `index.html` via `vite-plugin-singlefile` and served by the Rust binary.

## Build & Run Commands

### Server (Rust)

```bash
cd server && cargo build --release        # Release build
cd server && cargo build                  # Debug build
cd server && cargo check                  # Type-check only (fast)
cd server && cargo clippy                 # Lint (not enforced in CI, but run it)
```

### Frontend (TypeScript/React)

```bash
cd frontend && npm install                # Install dependencies (first time)
cd frontend && npm run dev                # Vite dev server with HMR
cd frontend && npm run build              # Production build (tsc -b && vite build)
cd frontend && npx tsc --noEmit           # Type-check only (no build)
```

### Full Stack

```bash
./run.sh                                  # Build (if needed) + run on port 7682
./run.sh bash                             # Run with bash instead of zsh
PORT=8080 ./run.sh                        # Custom port
```

### Tests

No test framework is currently configured for either server or frontend.
When adding tests:
- Rust: use `#[cfg(test)]` modules with `cargo test`
- Frontend: prefer Vitest (`npx vitest run` / `npx vitest run path/to/file`)

## Project Layout

```
server/
  src/main.rs              # Everything: CLI, state, router, handlers, subprocess helpers, data types
  Cargo.toml               # Dependencies: axum, tokio, portable-pty, serde, clap, tracing

frontend/
  src/
    App.tsx                # Root component (providers + layout)
    main.tsx               # ReactDOM entry point
    components/            # UI components (PascalCase.tsx)
    contexts/              # React Context providers (PascalCaseContext.tsx)
    hooks/                 # Custom hooks (useCamelCase.ts)
    utils/                 # Utility classes/functions (kebab-case.ts)
    workers/               # Web Workers (kebab-case.ts)
    styles/
      index.css            # Tailwind directives + CSS custom properties (dark theme)
      theme.ts             # Theme token object referencing CSS variables
  package.json             # React 18, xterm.js, Vite 5, Tailwind 3, TypeScript 5
  tsconfig.json            # strict: true, noUnusedLocals, noUnusedParameters
  vite.config.ts           # react plugin + singlefile plugin
  tailwind.config.js       # Custom colors mapped to CSS variables
```

## Code Style — Rust (server/)

### Imports

Group in this order, separated by blank lines:
1. `axum` imports (extract, http, response, routing)
2. External crates (`bytes`, `clap`, `futures_util`, `portable_pty`, `serde`, etc.)
3. `std` imports (grouped in a single `use std::{...}` block)
4. `tokio` imports
5. `tower_http` imports

### Code Organization

The single `main.rs` is divided by decorated section headers:

```rust
// ═══════════════════════════════════════════════════════════════════════════
// MAJOR SECTION (e.g., WEBSOCKET TERMINAL, HTTP API HANDLERS)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Minor Section (e.g., GET /api/diff) ───────────────────────────────────
```

### Naming & Types

- `snake_case` for functions/variables, `PascalCase` for types/structs
- Use `#[derive(Serialize)]` on response structs; use `#[serde(rename = "camelCase")]` for JSON field names
- Use `serde_json::json!({...})` for ad-hoc JSON responses
- Helper functions return `Result<String, String>` (not custom error types)
- CLI args via `clap::Parser` with `#[derive(Parser)]`

### Error Handling

- Match on `Result`, log with `tracing::error!()` / `tracing::warn!()`, and return early
- Use `let _ = ...` to explicitly ignore results where failure is acceptable
- For API handlers: return `json_error(error_code, message, StatusCode)` on failure
- Never panic in handlers — always handle errors gracefully

### Async Patterns

- Blocking I/O (subprocesses, file reads) → wrap in `tokio::task::spawn_blocking`
- Shared state via `Arc<Mutex<T>>` (std Mutex, not tokio — only held briefly)
- PTY reader runs in `std::thread::spawn` (blocking I/O)
- WebSocket tasks use `tokio::select!` for multiplexing

### Logging

Use `tracing` macros exclusively — never `println!` or `eprintln!` (except `print_access_urls`):
```rust
tracing::info!("Terminal session: {}x{}", cols, rows);
tracing::error!("Failed to open PTY: {}", e);
tracing::warn!("tmux detach-client failed: {}", e);
```

## Code Style — Frontend (frontend/)

### TypeScript Configuration

Strict mode is ON. These are enforced by `tsconfig.json`:
- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noFallthroughCasesInSwitch: true`

Do NOT use `as any`, `@ts-ignore`, or `@ts-expect-error`.

### Components

- Functional components only (no class components)
- Named exports: `export const MyComponent: React.FC = () => { ... }`
- Only `App` uses default export
- Props via inline types or `interface` (prefer `interface` over `type` for object shapes)
- Use `React.FC` or `React.FC<Props>` for component typing

### State Management

- React Context + `useState`/`useRef` — no external state library
- Context pattern: `createContext<T | null>(null)` → `useXxx()` hook with null check → `XxxProvider`
- Throw on missing context: `if (!context) throw new Error('useX must be used within XProvider')`
- `useRef` for values that don't trigger re-renders (WebSocket, timers, previous values)
- `useCallback` for functions passed to children or used in effects
- `localStorage` for user preferences (font size, toolbar state, command config)

### Styling

- **Tailwind CSS** for all styling — inline `className` strings
- CSS custom properties defined in `styles/index.css` for the dark theme palette
- Tailwind config maps semantic names to CSS vars: `bg-bg-primary`, `text-text-secondary`, etc.
- No CSS modules, no styled-components, no inline `style` objects (except dynamic values like height)
- Touch-specific styles: `touch-action: none` on terminal, haptic feedback via `navigator.vibrate`

### Imports

Order within a file:
1. React hooks (`import { useEffect, useRef, ... } from 'react'`)
2. External libraries (`@xterm/xterm`, `react-diff-viewer-continued`)
3. Local contexts (`../contexts/...`)
4. Local hooks (`../hooks/...`)
5. Local components (`./ComponentName`)
6. Local utils (`../utils/...`)
7. CSS imports (`@xterm/xterm/css/xterm.css`)

### API Communication

- `fetch()` for all HTTP requests (no axios)
- WebSocket for terminal I/O (ttyd binary protocol with command byte prefix)
- SSE (`EventSource`) for real-time status updates, with polling fallback
- Always use `AbortSignal.timeout(3000)` on fetch calls for resilience

### File Naming

| Type | Convention | Example |
|------|-----------|---------|
| Components | `PascalCase.tsx` | `StatusBar.tsx`, `DiffViewer.tsx` |
| Contexts | `PascalCaseContext.tsx` | `TerminalContext.tsx` |
| Hooks | `useCamelCase.ts` | `useTmuxSessions.ts` |
| Utils | `kebab-case.ts` | `predictive-echo.ts` |
| Workers | `kebab-case.ts` | `activity-worker.ts` |

### Error Handling (Frontend)

- Wrap fetch calls in try/catch, log errors with `console.error('[Component] message:', err)`
- Use optional chaining and nullish coalescing for defensive access
- Never let unhandled promise rejections escape — always catch

## Key Dependencies

### Server
- `axum` 0.8 (with `ws` feature) — HTTP framework and WebSocket
- `tokio` 1 (full) — async runtime
- `portable-pty` 0.8 — cross-platform PTY
- `clap` 4 — CLI argument parsing
- `tracing` / `tracing-subscriber` — structured logging
- `serde` / `serde_json` — serialization
- `tower-http` 0.6 — CORS middleware

### Frontend
- `@xterm/xterm` 5.5 — terminal emulator (with WebGL, Canvas, Fit addons)
- `react` 18 / `react-dom` 18 — UI framework
- `react-diff-viewer-continued` — git diff display
- `tailwindcss` 3 — utility-first CSS
- `vite` 5 + `vite-plugin-singlefile` — bundler (outputs single HTML)
