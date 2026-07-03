#!/bin/bash
echo "DEPRECATED: use 'hydra watchdog <platform>' instead (bun cli/hydra.ts watchdog discord)" >&2
echo "Run 'hydra install <platform>' to update your launchd plist." >&2
# Hydra daemon watchdog — checks heartbeat freshness and restarts if stale.
# Run via a system scheduler (e.g. launchd) every ~120s.
#
# The in-daemon self-heal handles most staleness by reconnecting the
# chat platform WebSocket. This watchdog is the defense-in-depth layer:
# it catches process crashes, self-heal failures, and any other mode
# where the daemon is gone or permanently stuck.
#
# Required env (set by the scheduler or source from a config file):
#   CHAT_PLATFORM    — discord or slack
#   SPAWN_CWD        — working directory for spawned sessions

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env-setup.sh"

HYDRA_DIR="$SCRIPT_DIR"
HYDRA_STATE_DIR="$STATE_DIR"
: "${SPAWN_CWD:=$HOME}"
: "${TMUX_SESSION:=${CHAT_PLATFORM}-daemon}"

HEARTBEAT="$STATE_DIR/daemon.alive"
STALE_SECONDS=300
LOG="${HYDRA_WATCHDOG_LOG:-$HOME/hydra-watchdog.log}"
NOW=$(date +%s)

# Platform-specific health check URL
if [ "$CHAT_PLATFORM" = "slack" ]; then
  HEALTH_URL="https://slack.com/api/api.test"
else
  HEALTH_URL="https://discord.com/api/v10/gateway"
fi

restart_daemon() {
  cd "$HYDRA_DIR"
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" \
    HYDRA_STATE_DIR="$HYDRA_STATE_DIR" \
    CHAT_PLATFORM="$CHAT_PLATFORM" \
    SPAWN_CWD="$SPAWN_CWD" ./start-daemon.sh
}

# Bail if tmux isn't reachable (prevents phantom "session missing" restarts)
if ! command -v tmux &>/dev/null; then
  echo "$(date): ERROR: tmux not found in PATH ($PATH)" >> "$LOG"
  exit 1
fi

# Check if daemon tmux session exists at all
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "$(date): Daemon tmux session missing, starting" >> "$LOG"
  restart_daemon
  exit 0
fi

# If heartbeat file doesn't exist, check how long the tmux session has been up.
# A freshly started daemon needs a few seconds to connect and write its first heartbeat.
# If the session has been up for longer than STALE_SECONDS with no heartbeat, it crashed
# during startup and the tmux session is a dead shell — restart.
if [ ! -f "$HEARTBEAT" ]; then
  CREATED=$(tmux display-message -t "$TMUX_SESSION" -p '#{session_created}' 2>/dev/null || echo "$NOW")
  AGE=$((NOW - CREATED))
  if [ "$AGE" -gt "$STALE_SECONDS" ]; then
    echo "$(date): No heartbeat after ${AGE}s, restarting daemon" >> "$LOG"
    restart_daemon
  fi
  exit 0
fi

# Check freshness via mtime
MTIME=$(stat -f %m "$HEARTBEAT" 2>/dev/null || echo 0)
ELAPSED=$((NOW - MTIME))

if [ "$ELAPSED" -gt "$STALE_SECONDS" ]; then
  # Don't restart if the network is down — the daemon can't connect anyway,
  # and restarting just creates a restart storm. Let the in-process self-heal
  # recover when connectivity returns.
  if ! curl -sS --max-time 5 "$HEALTH_URL" &>/dev/null; then
    exit 0
  fi
  echo "$(date): Heartbeat stale (${ELAPSED}s > ${STALE_SECONDS}s), restarting daemon" >> "$LOG"
  restart_daemon
fi

# Bot session health check — revive the byte if dead while the daemon is alive.
: "${BOT_TMUX_SESSION:=${CHAT_PLATFORM}-byte}"
if ! tmux has-session -t "$BOT_TMUX_SESSION" 2>/dev/null; then
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "$(date): Bot session '$BOT_TMUX_SESSION' missing (daemon alive), reviving" >> "$LOG"
    cd "$HYDRA_DIR"
    BYTE_SESSION_NAME="$BOT_TMUX_SESSION" BYTE_CWD="${SPAWN_CWD}" ./start-byte.sh
  fi
fi
