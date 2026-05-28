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
#   DISCORD_STATE_DIR — state dir (socket, access.json, sessions)
#   CLAUDE_CONFIG_DIR — config dir for spawned Claude sessions
SESSION="discord-daemon"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"

if [ -z "$SPAWN_CWD" ]; then
  echo "ERROR: SPAWN_CWD is required. Set it to the working directory for spawned sessions."
  echo "  Example: SPAWN_CWD=~/trading ./start-daemon.sh"
  exit 1
fi

# Kill existing daemon session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Remove stale socket
rm -f "$STATE_DIR/daemon.sock"

# Start daemon
tmux new-session -d -s "$SESSION" \
  "cd '$SCRIPT_DIR' && SPAWN_CWD='$SPAWN_CWD' bun run daemon.ts 2>&1 | tee -a ~/discord-daemon.log"

echo "$(date): Daemon started in tmux session '$SESSION' (SPAWN_CWD=$SPAWN_CWD)" >> ~/discord-daemon.log
echo "Daemon started. Attach with: tmux attach -t $SESSION"
