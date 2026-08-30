#!/usr/bin/env bash
# Manual smoke-test checklist for rust-terminal.
# After every Phase, run this and tick off each item before declaring victory.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-7682}"
HOST="http://127.0.0.1:${PORT}"

c_red()   { printf "\033[31m%s\033[0m" "$*"; }
c_green() { printf "\033[32m%s\033[0m" "$*"; }
c_yel()   { printf "\033[33m%s\033[0m" "$*"; }
c_blue()  { printf "\033[34m%s\033[0m" "$*"; }

ok()   { echo "  $(c_green '✓') $*"; }
warn() { echo "  $(c_yel '!') $*"; }
fail() { echo "  $(c_red '✗') $*"; }

section() {
  echo
  echo "$(c_blue "── $* ──")"
}

# ── 1. Static checks ─────────────────────────────────────────────────────
section "1. Static checks"

cd "${ROOT}/server"
if cargo build --quiet >/dev/null 2>&1; then
  ok "cargo build (debug) succeeds"
else
  fail "cargo build (debug) failed"
fi

if cargo test --quiet >/dev/null 2>&1; then
  ok "cargo test passes"
else
  fail "cargo test FAILED — investigate before proceeding"
fi

if cargo clippy --quiet --all-targets -- -D warnings >/dev/null 2>&1; then
  ok "cargo clippy clean"
else
  warn "cargo clippy has warnings (not enforced, but worth a look)"
fi

cd "${ROOT}/frontend"
if npx tsc --noEmit >/dev/null 2>&1; then
  ok "frontend tsc --noEmit clean"
else
  fail "frontend type errors"
fi

if npm run test --silent >/dev/null 2>&1; then
  ok "frontend vitest passes"
else
  fail "frontend tests failed"
fi

# ── 2. Live server checks ────────────────────────────────────────────────
section "2. Live HTTP API checks (requires server running on ${HOST})"

if ! curl -fsS --max-time 2 "${HOST}/api/health" >/dev/null 2>&1; then
  warn "Server not running on ${HOST}. Skipping live checks."
  warn "Start with: ./run.sh   then re-run this script."
  echo
else
  ok "server reachable"

  for path in /api/health /api/cwd /api/client-tty /api/tmux/list /api/git/status; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${HOST}${path}" 2>/dev/null || echo "ERR")
    if [[ "$code" == "200" || "$code" == "400" ]]; then
      ok "GET ${path} → ${code}"
    else
      fail "GET ${path} → ${code}"
    fi
  done

  body=$(curl -fsS --max-time 5 "${HOST}/api/health" 2>/dev/null || echo "")
  if echo "$body" | grep -q '"status"'; then
    ok "/api/health returns expected JSON"
  else
    fail "/api/health JSON shape unexpected: $body"
  fi
fi

# ── 3. Manual checklist (humans only) ────────────────────────────────────
section "3. Manual smoke (human verification required)"

cat <<EOF
  Open ${HOST} in browser. Tick each:

  [ ] 1. Terminal renders, prompt shows
  [ ] 2. Type a command (ls), output appears with no lag
  [ ] 3. Long output (find / 2>/dev/null | head -200) streams smoothly
  [ ] 4. tmux works — switch windows, split panes, no freeze
  [ ] 5. Branch selector (top-right) lists branches; checkout works
  [ ] 6. Git panel — stage, unstage, commit a small change end-to-end
  [ ] 7. Git diff renders correctly for modified file
  [ ] 8. File upload (paste image) works; file appears in /tmp/ttyd_uploads
  [ ] 9. Resize browser window — terminal resizes without distortion
  [ ] 10. Kill server (Ctrl+C in run.sh), reload page — connection overlay shows
  [ ] 11. Restart server, page auto-reconnects
  [ ] 12. Mobile view (DevTools mobile emulator) — keyboard appears, no scroll jank
  [ ] 13. Pinch-to-zoom on mobile changes font size
  [ ] 14. Long-press on session tab opens kill confirmation
  [ ] 15. CopyMode (transcript view) — page-up captures history correctly

  Phase-specific verification (additionally check after each phase):

  Phase 0:
  [ ] All automated tests still green (above)

  Phase 1:
  [ ] No new compile warnings
  [ ] macOS PTY tty (e.g. /dev/ttys012) is detected by the frontend (was broken)

  Phase 2:
  [ ] Concurrent API requests (open multiple browser tabs) don't block each other
  [ ] /api/git/branches under load doesn't stall other endpoints

  Phase 3:
  [ ] PTY throughput >= baseline (yes | head -c 100M test)
  [ ] No keystroke loss in vim/htop

  Phase 4:
  [ ] SSE branch changes still propagate to frontend
  [ ] git review with N>10 changed files loads quickly

  Phase 5:
  [ ] Typing in commit composer doesn't lag the diff view

EOF

echo
echo "$(c_blue 'Done.') Verify the manual items above before signing off this phase."
