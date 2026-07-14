# Hydra

Multi-platform chat bridge for Claude Code and Codex. Connect Discord, Slack, or both while keeping Claude as the default and spawning Codex sessions on demand.

## Architecture

```
┌─────────────┐     ┌─────────────┐
│  Discord    │     │   Slack     │
│  Gateway    │     │  Gateway    │
│ (discord.js)│     │(@slack/bolt)│
└──────┬──────┘     └──────┬──────┘
       │                   │
       └────────┬──────────┘
                │
       ┌────────▼────────┐
       │     Daemon      │     Single process per platform.
       │  (daemon.ts)    │     Holds gateway connection,
       │                 │     routes messages, manages
       │  unix socket    │     sessions and access control.
       └────────┬────────┘
                │  newline-delimited JSON
       ┌────────▼────────┐
       │    Bridge       │     Thin MCP relay. One per
       │  (bridge.ts)    │     Claude session. Platform-
       │                 │     agnostic — doesn't import
       │  stdio ↔ socket │     any chat SDK.
       └────────┬────────┘
                │  MCP (Claude) / CLI (Codex)
       ┌────────▼────────┐
       │ Claude / Codex  │     Claude uses the MCP channel bridge;
       │                 │     Codex uses a persistent CLI sidecar.
       └─────────────────┘
```

**Key design decisions:**
- **One gateway connection per platform.** Prevents token race conditions (Discord) and simplifies state.
- **Daemon ↔ Bridge separation.** The daemon is long-lived; Claude sessions come and go. The bridge reconnects automatically.
- **Platform selection via env var.** Set `CHAT_PLATFORM=discord` or `CHAT_PLATFORM=slack`. Default: `discord`.
- **Simultaneous platforms.** Run two daemons on different state dirs for Discord + Slack at the same time.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
- [Codex CLI](https://developers.openai.com/codex/cli/) (optional provider) — install it and run `codex login`

## Quick Start

```bash
# Install dependencies
bun install

# Create .env with your bot token
mkdir -p ~/.claude/channels/discord
cat > ~/.claude/channels/discord/.env << 'EOF'
DISCORD_BOT_TOKEN=your-token-here
EOF

# Install watchdog + verify setup
bun cli/hydra.ts install discord --cwd ~/your/project

# Start
bun cli/hydra.ts up discord
```

## Platform Setup

- **[Discord Setup](docs/discord.md)** — bot creation, token, permissions, pairing
- **[Slack Setup](docs/slack.md)** — app manifest, Socket Mode, tokens

## CLI Reference

All operations go through the `hydra` CLI (`bun cli/hydra.ts` or alias to `hydra`).

### Setup

```bash
hydra install <platform>       # Generate launchd watchdog, run preflight
hydra uninstall <platform>     # Remove launchd watchdog
hydra preflight <platform>     # Verify deployment is ready
```

### Lifecycle

```bash
hydra up <platform>            # Start daemon + byte
hydra down <platform>          # Stop byte + daemon
hydra restart <platform>       # Restart daemon (picks up code changes)
```

### Session Management

```bash
hydra spawn <prompt>           # Spawn a new session
hydra spawn --provider codex --initiator <name> --idempotency-key <key> <prompt>
hydra list                     # List active sessions
hydra status <name>            # Session details
hydra kill <name>              # Kill a session
hydra peek [name]              # View live sessions (chooser or direct attach)
hydra health                   # Daemon diagnostics
hydra clear-key <key>          # Clear a stuck idempotency key
```

### Options

```
--daemon <name>                Target a specific daemon (when multiple running)
--json                         Output raw JSON
```

## Configuration

### Bot tokens

Set in `~/.claude/channels/<platform>/.env`:

```bash
# Discord
DISCORD_BOT_TOKEN=MTIz...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### Access control

`access.json` controls who can message the bot. Lives in the state dir (`~/.claude/channels/discord/` by default).

```jsonc
{
  "dmPolicy": "pairing",          // pairing | allowlist | disabled
  "allowFrom": ["user-id-here"],  // platform user IDs
  "groups": {                      // channel-level policies
    "channel-id": {
      "requireMention": true,
      "allowFrom": [],
      "threadReply": true
    }
  },
  "ackReaction": "👀",
  "replyToMode": "first",         // first | all | off
  "textChunkLimit": 2000,
  "chunkMode": "newline"           // newline | length
}
```

See [ACCESS.md](./ACCESS.md) for full reference.

### Running both platforms simultaneously

```bash
# Install both
hydra install discord
hydra install slack

# Start both
hydra up discord
hydra up slack
```

Each platform gets its own daemon, state dir, and watchdog. Use different `CLAUDE_CONFIG_DIR` values for separate logins.

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a message. Takes `chat_id` + `text`, optionally `reply_to` for threading and `files` for attachments (max 10, 25MB each). Auto-chunks long messages. |
| `react` | Add emoji reaction to a message. |
| `edit_message` | Edit a previously sent message. |
| `fetch_messages` | Pull recent history (up to 100). |
| `download_attachment` | Download attachments from a message to local inbox. |
| `create_thread` | Create a thread on a message or standalone. |
| `spawn_session` | Spawn a new Claude or Codex session for a topic (main session only). |
| `list_sessions` | List active spawned sessions (main session only). |
| `kill_session` | Kill a spawned session (main session only). |

## Sessions

Spawn isolated Claude or Codex sessions from chat:

| Command | Action |
|---------|--------|
| `/spawn` | Create a session with `topic`, optional `provider`, and optional `model` fields |
| `spawn <provider> [model]: <topic>` | Text form; provider is `claude` or `codex` |
| `spawn: <topic>` | Claude shorthand that creates a new session with a thread |
| `kill: <name>` | Kill a session by name |
| `/sessions` | List active sessions |
| `/model <id>` | Change the active Claude or Codex model |
| `/effort <level>` | Change Claude or Codex reasoning effort |
| `/context` | Show Claude context details or Codex's latest available usage |
| `/clear` | Reset the active Claude or Codex conversation context |
| `/ultracode on|off` | Toggle Claude ultracode; for Codex, set effort to `ultra` or `default` |
| `/provider claude|codex` | Hand off a live thread to the other provider |
| `/fork` / `fork: <focus>` | Fork the current Claude or Codex conversation into a separate Hydra thread |
| `listen` / `pause` | Toggle auto-routing in a session thread |
| `help` / `commands` | Show all available commands |

Sessions get cute names (spark, pixel, nova...) and run in their own tmux sessions. State persists across daemon restarts.

Codex sessions reuse your local Codex CLI login and preserve their Codex conversation ID for `resume`/recovery. Set `CODEX_MODEL` in the platform `.env` only if you want to override the Codex CLI's configured default model.

The Discord `/spawn` command exposes `topic`, `provider`, and `model`; `provider` defaults to Claude and `model` is optional. For example, choose `provider: codex` to start a Codex session, or use the text form `spawn codex gpt-5.6-sol: inspect this repository`.

Inside a live session thread, `/provider codex` or `/provider claude` keeps the same Discord thread and working directory. Hydra resumes that provider's most recent conversation from the thread when one exists and supplies the messages posted while it was inactive; the first switch to a provider starts a new conversation with recent thread history. Active build/review/design protocols must be cancelled before switching.

`/fork` works for both providers and leaves the parent session unchanged. Claude uses its native fork-session flow; Codex uses its persisted conversation through the Codex app-server `thread/fork` method, then resumes the returned fork ID in a new Hydra thread. Add an optional focus with `/fork: investigate the parser` or the Discord slash command's `focus` field.

Inside a Codex thread, `/model <model-id>` and `/effort <level>` update that session starting with its next turn. Use `default` to remove the per-session override and return to the Codex CLI configuration. Documented Codex effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; availability depends on the selected model.

For Codex, `/context` reports the last completed turn's context usage and remaining capacity, while `/clear` drops the saved Codex conversation ID so the next Discord message starts a fresh conversation and reloads workspace instructions and memory. `/clear` is rejected while a Codex turn is still running.

Codex inherits `SPAWN_CWD` like Claude. Configure Codex with `project_doc_fallback_filenames = ["CLAUDE.md"]`; Hydra also includes the workspace `CLAUDE.md` and its Claude Code `memory/MEMORY.md` index on the first Codex turn. Override discovery with `CODEX_CLAUDE_INSTRUCTIONS_FILE` or `CODEX_CLAUDE_MEMORY_FILE` when needed.

## Troubleshooting

Symptoms first — each maps to one root cause. See [docs/ONBOARDING_TIPS.md](./docs/ONBOARDING_TIPS.md) for a full first-machine checklist.

**Bot is online but a spawned thread stays empty, or `spawn:` does nothing.**
Command interception (`spawn:`, `kill:`, `/sessions`, `/health`) fires only for senders in the **top-level** `access.json` `allowFrom` — separate from a channel group's `allowFrom`. A group lets *replies* through; *commands* need you in the global allowlist. → `/discord:access allow <your-snowflake>`. (The daemon logs `command-shaped message from non-allowlisted sender …` when this happens.)

**Byte or spawned session hangs on a theme picker, login, or "trust this folder" screen.**
The byte is a second, headless Claude in tmux using `CLAUDE_CONFIG_DIR` (default `~/.claude`), so it reads **`$CLAUDE_CONFIG_DIR/.claude.json`** — not `~/.claude.json`. A fresh config dir triggers first-run gates that block a detached session. → Complete them once via `tmux attach -t <platform>-byte`, or pre-seed `theme`, `hasCompletedOnboarding`, `bypassPermissionsModeAccepted`, and per-project `hasTrustDialogAccepted`. `hydra preflight` now flags this.

**Bot connects but never sees inbound (looks healthy, ignores everyone).**
→ Enable **Message Content Intent** (Developer Portal → Bot → Privileged Gateway Intents), or the bot receives empty message content.

**Byte dies instantly, or spawns fail to launch.**
→ Check `SPAWN_CWD` points at a directory that exists. Inspect `~/hydra-<platform>-byte.log` and `~/hydra-<platform>-daemon.log`.

**`usage` shows `?` instead of context percentage.**
Claude Code doesn't display context % in the status bar by default. Add a `statusLine` hook to `$CLAUDE_CONFIG_DIR/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "refreshInterval": 5
  }
}
```
Where `~/.claude/statusline.sh` extracts the percentage from the JSON passed on stdin:
```bash
#!/bin/bash
input=$(cat)
pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
echo "ctx: ${pct}%"
```
The hook receives `context_window.used_percentage`, `model.id`, `cost.total_cost_usd`, and more. Restart the byte to pick up the change.

**Verify inbound end-to-end:** `grep -E "main bridge connected|running tmux new-session" ~/hydra-<platform>-daemon.log`

## Files

| File | Purpose |
|------|---------|
| `gateway.ts` | ChatGateway interface and shared types |
| `discord-gateway.ts` | Discord implementation (discord.js) |
| `slack-gateway.ts` | Slack implementation (@slack/bolt Socket Mode) |
| `daemon.ts` | Platform-agnostic message router and session manager |
| `bridge.ts` | MCP relay between Claude and daemon (unix socket ↔ stdio) |
| `cli/hydra.ts` | CLI entry point — routes commands |
| `cli/helpers.ts` | Config resolution, tmux wrappers, socket comms, compile check |
| `cli/lifecycle.ts` | Lifecycle commands: up/down/restart/watchdog/preflight/install |
| `cli/peek.ts` | View live sessions via tmux linked windows with filtered chooser |

Logs land at `~/hydra-<platform>-daemon.log` and `~/hydra-<platform>-byte.log`.
