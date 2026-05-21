#!/bin/bash
# Start the Discord routing daemon in a tmux session.
# The daemon holds the single Discord gateway connection and routes
# messages between Discord and Claude sessions via unix sockets.
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

echo "$(date): Discord daemon started in tmux session '$SESSION'" >> ~/discord-daemon.log
echo "Discord daemon started. Attach with: tmux attach -t $SESSION"
