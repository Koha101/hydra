# Slack Setup

## 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**.

Select your workspace and paste this manifest:

```yaml
display_information:
  name: Byte
  description: Claude Code chat bridge
  background_color: "#2c2c2c"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Byte
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## 2. Generate tokens

**App-level token** (for Socket Mode):
- Go to **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**
- Name: `socket-mode`, Scope: `connections:write`
- Copy the `xapp-...` token

**Bot token:**
- Go to **OAuth & Permissions** → **Bot User OAuth Token**
- Copy the `xoxb-...` token

## 3. Install to workspace

Go to **Install App** → **Install to Workspace** → Authorize.

If your workspace has org-level restrictions, you may need an admin to approve the scopes.

## 4. Configure

```bash
# In ~/trading/discord-bot-custom/.env
CHAT_PLATFORM=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Create an access.json with your Slack user ID:

```bash
# In ~/.claude/channels/slack/access.json (or your DISCORD_STATE_DIR)
{
  "dmPolicy": "allowlist",
  "allowFrom": ["U084P1E92NP"],
  "groups": {},
  "pending": {}
}
```

## 5. Start

```bash
# If running alongside Discord, use a separate state dir:
DISCORD_STATE_DIR=~/.claude/channels/slack ./start-daemon.sh

# Or set CHAT_PLATFORM in .env and use the default:
./start-daemon.sh
./start-byte-v2.sh
```

## 6. Message the bot

DM Byte in Slack, or @mention it in a channel that's in your `groups` config.

## Slack-specific behavior

- **Socket Mode:** Uses a persistent WebSocket (like Discord's gateway) — no public endpoint needed.
- **Threads:** Slack DMs support threads natively, so `spawn:` works directly in DMs (unlike Discord which redirects to a guild channel).
- **No typing indicator:** Slack doesn't expose a typing API for bots.
- **Reactions:** Unicode emoji are auto-converted to Slack names (e.g. `👀` → `eyes`).
- **File uploads:** Uses `files.uploadV2` — slightly slower than Discord's inline attachment model.
- **Multiple connections OK:** Slack allows multiple Socket Mode connections per app token, so the gateway race condition that plagues Discord doesn't exist.

## User IDs

Slack user IDs look like `U084P1E92NP`. Find yours:
- Click your profile picture → **Profile** → **⋮** menu → **Copy member ID**
- Or: in any message, click a username → the URL contains the user ID

## Channel IDs

Channel IDs start with `C` (public), `G` (private), or `D` (DM). Find them:
- Right-click a channel → **View channel details** → ID at the bottom
- Or: the URL when viewing a channel contains it
