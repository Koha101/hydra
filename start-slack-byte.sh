#!/bin/bash
# Start Slack Byte (Claude Code Slack bot) using the daemon+bridge architecture.
# Requires the Slack daemon to be running first.
SESSION="${BYTE_SESSION_NAME:-slack-byte}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCK="${DAEMON_SOCK:-$HOME/.claude/channels/slack/daemon.sock}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DM_CHANNEL="${BYTE_CHANNEL:-D0B6KKFNH4N}"
CWD="${BYTE_CWD:-$HOME/angellist}"

# Check daemon is running
if [ ! -S "$SOCK" ]; then
  echo "ERROR: Slack daemon socket not found at $SOCK"
  echo "Start the Slack daemon first:"
  echo "  DISCORD_STATE_DIR=\$HOME/.claude/channels/slack CHAT_PLATFORM=slack $SCRIPT_DIR/start-daemon.sh"
  exit 1
fi

# Kill existing slack-byte session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 2

# Copy bridge.ts into the plugin cache
SRC="$SCRIPT_DIR/bridge.ts"
DEST="$CONFIG_DIR/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts"
if [ ! -f "$SRC" ]; then
  echo "ERROR: bridge.ts missing at $SRC" >&2
  exit 1
fi
if [ ! -d "$(dirname "$DEST")" ]; then
  echo "ERROR: plugin cache dir missing at $(dirname "$DEST")" >&2
  exit 1
fi
cp "$SRC" "$DEST" || { echo "ERROR: failed to copy bridge.ts into plugin cache" >&2; exit 1; }
echo "$(date): synced bridge.ts into plugin cache" >> ~/slack-byte-restarts.log

# Start slack-byte
tmux new-session -d -s "$SESSION" \
  "cd '$CWD' && export DAEMON_SOCK='$SOCK' && export CLAUDE_CONFIG_DIR=$CONFIG_DIR && caffeinate -i claude --model 'claude-opus-4-6[1m]' --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions \
  \"You just restarted with a fresh context. You are Byte running on Slack. Read your memory files, then send a greeting to Slack DM ${DM_CHANNEL} using reply(chat_id=${DM_CHANNEL}).\""

echo "$(date): Slack Byte started (daemon+bridge)" >> ~/slack-byte-restarts.log
echo "Slack Byte started. Attach with: tmux attach -t $SESSION"
