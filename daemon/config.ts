import {
  readFileSync,
  chmodSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import type { ChatGateway } from '../gateway.js'

// ---------------------------------------------------------------------------
// Paths & env
// ---------------------------------------------------------------------------

export const STATE_DIR = process.env.HYDRA_STATE_DIR
  ?? process.env.DISCORD_STATE_DIR
  ?? join(homedir(), '.claude', 'channels', process.env.CHAT_PLATFORM ?? 'discord')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const SOCK_PATH = join(STATE_DIR, 'daemon.sock')
export const INBOX_DIR = join(STATE_DIR, 'inbox')

export const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude-personal')
export const DEFAULT_SESSION_CHANNEL = process.env.DEFAULT_SESSION_CHANNEL ?? '1506825982127112252'

const LOCAL_ENV_FILE = join(import.meta.dir, '..', '.env')
for (const envFile of [LOCAL_ENV_FILE, ENV_FILE]) {
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export const PLATFORM = (process.env.CHAT_PLATFORM ?? 'discord') as 'discord' | 'slack'

let TOKEN: string | undefined
let SLACK_APP_TOKEN: string | undefined

if (PLATFORM === 'slack') {
  TOKEN = process.env.SLACK_BOT_TOKEN
  SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
  if (!TOKEN || !SLACK_APP_TOKEN) {
    process.stderr.write(
      `daemon: SLACK_BOT_TOKEN and SLACK_APP_TOKEN required for slack platform\n` +
      `  set in ${ENV_FILE}\n`,
    )
    process.exit(1)
  }
} else {
  TOKEN = process.env.DISCORD_BOT_TOKEN
  if (!TOKEN) {
    process.stderr.write(
      `daemon: DISCORD_BOT_TOKEN required for discord platform\n` +
      `  set in ${ENV_FILE}\n`,
    )
    process.exit(1)
  }
}

export { TOKEN, SLACK_APP_TOKEN }

export const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

// ---------------------------------------------------------------------------
// Permission regex
// ---------------------------------------------------------------------------

export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  process.stderr.write(`daemon: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`daemon: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Gateway (created here, wired by daemon.ts orchestrator)
// ---------------------------------------------------------------------------

export const heartbeatPath = join(STATE_DIR, 'daemon.alive')

export let gateway: ChatGateway

if (PLATFORM === 'slack') {
  const { SlackGateway } = await import('../slack-gateway.js')
  gateway = new SlackGateway(SLACK_APP_TOKEN!, { heartbeatPath })
} else {
  const { DiscordGateway } = await import('../discord-gateway.js')
  // DiscordGateway owns its heartbeat via GatewayHealth — written only while the
  // socket is actually connected, so a wedged transport goes stale for the watchdog.
  gateway = new DiscordGateway({ heartbeatPath })
}
