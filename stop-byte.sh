#!/bin/bash
# Stop a platform's byte session and kill orphaned claude processes.
# Mirrors the cleanup section from start-byte-v2.sh / start-slack-byte.sh.
#
# Required env:
#   CHAT_PLATFORM — discord or slack
#
# Optional env:
#   BYTE_SESSION_NAME — tmux session name (default: ${CHAT_PLATFORM}-byte)
#   DAEMON_SOCK — daemon socket path (for orphan filtering)

: "${CHAT_PLATFORM:?error: CHAT_PLATFORM is required}"

SESSION="${BYTE_SESSION_NAME:-${CHAT_PLATFORM}-byte}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCK="${DAEMON_SOCK:-$HOME/.claude/channels/${CHAT_PLATFORM}/daemon.sock}"
LOG="${BYTE_LOG:-$HOME/${CHAT_PLATFORM}-byte-restarts.log}"

tmux kill-session -t "$SESSION" 2>/dev/null

source "$SCRIPT_DIR/kill-orphan-bytes.sh"
_kill_orphan_bytes "killing" ""
sleep 2
_kill_orphan_bytes "force-killing surviving" "-9"

echo "$(date): ${CHAT_PLATFORM} byte stopped" >> "$LOG"
echo "${CHAT_PLATFORM} byte stopped."
