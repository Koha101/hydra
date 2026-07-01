/**
 * Dashboard — auto-updating session overview in Slack's App Home tab.
 */

import { gateway, PLATFORM } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { transport } from './bridge-transport.js'
import { formatDuration, tmuxHasSession } from './util.js'
import { loadAccess } from './access.js'

const DEBOUNCE_MS = 2000
const PERIODIC_REFRESH_MS = 5 * 60 * 1000
const MAX_SESSION_BLOCKS = 45
let debounceTimer: ReturnType<typeof setTimeout> | null = null

type SessionRow = {
  name: string
  emoji: string
  desc: string
  age: string
  connected: boolean
  paused: boolean
  url: string
}

function getActiveSessions(): SessionRow[] {
  const all = [...registry.values()]
  const now = Date.now()

  all.sort((a, b) => b.lastActive - a.lastActive)

  const rows: SessionRow[] = []
  for (const s of all) {
    if (!tmuxHasSession(s.tmuxName)) continue
    const desc = s.description || s.topic?.slice(0, 50) || s.tmuxName
    const url = s.lastReplyId
      ? gateway.getMessageUrl(s.threadId, s.lastReplyId) || s.threadUrl || ''
      : s.threadUrl ?? ''
    rows.push({
      name: s.tmuxName,
      emoji: sessionEmoji(s.tmuxName),
      desc: desc.length > 45 ? desc.slice(0, 42) + '...' : desc,
      age: formatDuration(now - s.createdAt),
      connected: transport.has(s.sessionId),
      paused: !!s.paused,
      url,
    })
  }

  return rows
}

function buildHomeBlocks(sessions: SessionRow[]): any[] {
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Active Sessions (${sessions.length})` },
    },
  ]

  if (sessions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No sessions running._' },
    })
  } else {
    const shown = sessions.slice(0, MAX_SESSION_BLOCKS)
    for (const s of shown) {
      let status: string
      if (s.paused) status = '⏸️'
      else if (!s.connected) status = '🔄'
      else status = '🚀'

      const link = s.url ? `<${s.url}|${s.name}>` : s.name
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${status} *${link}* ${s.emoji} — ${s.desc} · _${s.age}_`,
        },
      })
    }
    if (sessions.length > MAX_SESSION_BLOCKS) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_+${sessions.length - MAX_SESSION_BLOCKS} more not shown_` }],
      })
    }
  }

  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `<!date^${Math.floor(Date.now() / 1000)}^Updated {time}|Updated just now>`,
    }],
  })

  return blocks
}

async function doUpdate(): Promise<void> {
  if (PLATFORM !== 'slack') return
  if (!('publishHomeTab' in gateway)) return

  const access = loadAccess()
  if (!access.allowFrom.length) return

  const userId = access.allowFrom[0]
  const sessions = getActiveSessions()
  const blocks = buildHomeBlocks(sessions)

  try {
    await (gateway as any).publishHomeTab(userId, blocks)
  } catch (err) {
    process.stderr.write(`dashboard: home tab publish failed for ${userId}: ${err}\n`)
  }
}

export function refreshDashboard(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    doUpdate().catch(err => {
      process.stderr.write(`dashboard: update failed: ${err}\n`)
    })
  }, DEBOUNCE_MS)
}

export function refreshDashboardNow(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  doUpdate().catch(err => {
    process.stderr.write(`dashboard: update failed: ${err}\n`)
  })
}

// Periodic fallback refresh — keeps dashboard fresh even when no session changes occur
setInterval(() => {
  doUpdate().catch(err => {
    process.stderr.write(`dashboard: periodic refresh failed: ${err}\n`)
  })
}, PERIODIC_REFRESH_MS)
