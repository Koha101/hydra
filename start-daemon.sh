#!/bin/bash
# Start the chat routing daemon in a tmux session.
# The daemon holds a single gateway connection (Discord or Slack) and routes
# messages between the chat platform and Claude sessions via unix sockets.
#
# Required env vars (set before calling, or in .env):
#   SPAWN_CWD — working directory for spawned sessions
#
# Optional env vars:
#   CHAT_PLATFORM — discord (default) or slack
#   HYDRA_STATE_DIR — state dir (socket, access.json, sessions)
#   CLAUDE_CONFIG_DIR — config dir for spawned Claude sessions
export PATH="$HOME/.npm-global/bin:$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${HYDRA_STATE_DIR:-${DISCORD_STATE_DIR:-$HOME/.claude/channels/${CHAT_PLATFORM:-discord}}}"

# Source .env from state dir for persistent config (SPAWN_CWD, CLAUDE_CONFIG_DIR, etc.)
[ -f "$STATE_DIR/.env" ] && set -a && . "$STATE_DIR/.env" && set +a

SESSION="${CHAT_PLATFORM:-discord}-daemon"
LOG="${HYDRA_LOG:-$HOME/hydra-daemon.log}"

if [ -z "$SPAWN_CWD" ]; then
  echo "ERROR: SPAWN_CWD is required. Set it to the working directory for spawned sessions."
  echo "  Example: SPAWN_CWD=~/trading ./start-daemon.sh"
  exit 1
fi

# ---------------------------------------------------------------------------
# Runtime isolation — the daemon runs from a dedicated copy of the repo so
# development activity (branch switches, half-finished edits) in the main
# working tree can never land under a running daemon process.
#
# SCRIPT_DIR (the dev repo)  → source of truth, compile-checked here
# RUNTIME_DIR (state-dir copy) → where the daemon actually executes
# HYDRA_SOURCE_DIR env var     → passed to the daemon so it can locate
#                                 the restart script in the real repo
# ---------------------------------------------------------------------------
RUNTIME_DIR="$STATE_DIR/daemon-runtime"

# Compile gate — never cold-start onto a tree that doesn't load.
# `bun run` is lazy: parse/export errors surface only when a module is imported,
# so a broken merge to the running branch sits undetected until a restart, then
# crash-loops forever (watchdog kills + relaunches a process that dies on boot).
# Build the entries first; if it fails, refuse to start and leave any running
# daemon UNTOUCHED — a broken tree must never replace a working process.
source "$SCRIPT_DIR/compile-check.sh"
COMPILE_OUT=$(_compile_check "$SCRIPT_DIR")
COMPILE_RC=$?
if [ "$COMPILE_RC" -ne 0 ]; then
  {
    echo "$(date): COMPILE FAILED — refusing to start daemon; leaving any running session untouched."
    echo "----- build error -----"
    printf '%s' "$COMPILE_OUT"
  } | tee -a "$LOG"
  exit 1
fi

# Sync source into runtime directory. rsync is atomic-enough here: the daemon
# is dead (killed below) so nothing reads mid-sync. --delete ensures stale
# files from removed modules don't linger.
mkdir -p "$RUNTIME_DIR"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'tmp' \
  --exclude 'diagrams' \
  --exclude 'docs' \
  --exclude '.planning' \
  "$SCRIPT_DIR/" "$RUNTIME_DIR/"
echo "$(date): Synced source to runtime dir ($RUNTIME_DIR)" >> "$LOG"

# Kill existing daemon session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Remove stale socket
rm -f "$STATE_DIR/daemon.sock"

# Start daemon.
# Forward env EXPLICITLY into the tmux command. tmux does NOT reliably inherit arbitrary
# vars into new sessions — its server global env is frozen at first launch — so relying on
# inheritance silently dropped CLAUDE_CONFIG_DIR and broke spawned-session bridges.
# PATH must also be forwarded so bun/claude are reachable when launched via launchd.
# HYDRA_SOURCE_DIR points the daemon back to the dev repo for restart scripts.
ENVS="PATH='$PATH' HYDRA_STATE_DIR='$STATE_DIR' SPAWN_CWD='$SPAWN_CWD' HYDRA_SOURCE_DIR='$SCRIPT_DIR'"
[ -n "$CHAT_PLATFORM" ] && ENVS="$ENVS CHAT_PLATFORM='$CHAT_PLATFORM'"
[ -n "$CLAUDE_CONFIG_DIR" ] && ENVS="$ENVS CLAUDE_CONFIG_DIR='$CLAUDE_CONFIG_DIR'"
tmux new-session -d -s "$SESSION" \
  "cd '$RUNTIME_DIR' && $ENVS bun run daemon.ts 2>&1 | tee -a $LOG"

echo "$(date): Daemon started in tmux session '$SESSION' (SPAWN_CWD=$SPAWN_CWD, runtime=$RUNTIME_DIR)" >> $LOG
echo "Daemon started. Attach with: tmux attach -t $SESSION"
