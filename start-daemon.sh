#!/bin/bash
# Start the chat routing daemon in a tmux session.
# The daemon holds a single gateway connection (Discord or Slack) and routes
# messages between the chat platform and Claude sessions via unix sockets.
#
# Platform selection: set CHAT_PLATFORM=slack in ~/.claude/channels/discord/.env
# Default: discord
SESSION="discord-daemon"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Kill existing daemon session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Remove stale socket
rm -f ~/.claude/channels/discord/daemon.sock

# Start daemon
tmux new-session -d -s "$SESSION" \
  "cd '$SCRIPT_DIR' && bun run daemon.ts 2>&1 | tee -a ~/discord-daemon.log"

echo "$(date): Daemon started in tmux session '$SESSION'" >> ~/discord-daemon.log
echo "Daemon started. Attach with: tmux attach -t $SESSION"
