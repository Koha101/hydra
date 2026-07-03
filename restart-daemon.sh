#!/bin/bash
echo "DEPRECATED: use 'hydra restart <platform>' instead (bun cli/hydra.ts restart discord)" >&2
set -euo pipefail
# Safely restart the hydra daemon.
#
# Safe for spawned sessions to run — bridges auto-reconnect (~5s),
# sessions persist in sessions.json. The only visible effect is a
# brief routing gap while the daemon restarts.
#
# Usage:
#   ./restart-daemon.sh                              # uses env defaults
#   SPAWN_CWD=~/my-project ./restart-daemon.sh       # explicit

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env-setup.sh"

: "${TMUX_SESSION:=${CHAT_PLATFORM}-daemon}"
: "${SPAWN_CWD:=$HOME}"
: "${CLAUDE_CONFIG_DIR:=$HOME/.claude}"
SOCK="$STATE_DIR/daemon.sock"
# Per-platform log file (see start-daemon.sh) — avoids the shared-log false signal.
LOG="${HYDRA_LOG:-$HOME/hydra-${CHAT_PLATFORM:-discord}-daemon.log}"

echo "$(date): Restart requested" >> "$LOG"

# 1. Pre-flight: compile-check BEFORE killing the old daemon
echo "Pre-flight compile check..."
source "$SCRIPT_DIR/compile-check.sh"
if ! COMPILE_OUT=$(_compile_check "$SCRIPT_DIR"); then
  echo "✗ Compile check FAILED — old daemon left running."
  printf '%s' "$COMPILE_OUT" | sed 's/^/    /'
  echo "$(date): Restart ABORTED — compile check failed (old daemon untouched)" >> "$LOG"
  exit 1
fi

# 2. Kill existing daemon
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "Killing daemon..."
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
  sleep 0.5
else
  echo "No daemon running."
fi

# 3. Remove stale socket
rm -f "$SOCK"

# 4. Relaunch
echo "Starting daemon..."
CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
  HYDRA_STATE_DIR="$HYDRA_STATE_DIR" \
  CHAT_PLATFORM="$CHAT_PLATFORM" \
  SPAWN_CWD="$SPAWN_CWD" \
  "$SCRIPT_DIR/start-daemon.sh"

# 5. Wait for socket to appear (up to 15s)
echo -n "Waiting for socket"
for i in $(seq 1 30); do
  if [ -S "$SOCK" ]; then
    echo " ready (${i}×0.5s)"
    echo "$(date): Daemon restarted successfully" >> "$LOG"
    exit 0
  fi
  echo -n "."
  sleep 0.5
done

echo " TIMEOUT — socket did not appear after 15s"
echo "$(date): Restart FAILED — socket timeout" >> "$LOG"
exit 1
