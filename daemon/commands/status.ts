import { statSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { gateway, STATE_DIR, PLATFORM } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { fallbackDescription, formatDuration, getContextPercent } from '../util.js'
import type { InboundMessage } from '../../gateway.js'

export const daemonStartedAt = Date.now()

// ---------------------------------------------------------------------------
// List display helpers
// ---------------------------------------------------------------------------

function listTimeBucket(lastActiveMs: number, now: number): string {
  const diffH = (now - lastActiveMs) / 3_600_000
  if (diffH < 1) return 'Past hour'
  if (diffH < 3) return 'Past 3 hours'
  const last = new Date(lastActiveMs)
  const today = new Date(now)
  const lastDay = new Date(last.getFullYear(), last.getMonth(), last.getDate())
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const daysDiff = Math.round((todayDay.getTime() - lastDay.getTime()) / 86_400_000)
  if (daysDiff === 0) return `${Math.round(diffH)} hours ago`
  if (daysDiff === 1) return 'Yesterday'
  return `${daysDiff} days ago`
}

type SessionEntry = { session: SessionInfo; latestLine?: string }

function formatSessionEntry(e: SessionEntry): string {
  const s = e.session
  const desc = s.description ?? fallbackDescription(s.topic)
  const duration = formatDuration(Date.now() - s.createdAt)
  const msgCount = s.messageCount ?? 0
  const ctx = getContextPercent(s.tmuxName)
  const badge = s.status === 'dead' ? ' ☠️' : transport.has(s.sessionId) ? '' : ' ⚠️'
  const emoji = sessionEmoji(s.tmuxName)
  const url = s.threadUrl
  const title = url ? `[**${desc}**](${url})` : `**${desc}**`
  const provenanceEmoji = s.originType === 'handoff' ? '🤝' : s.originType === 'resurrect' ? '🫀' : '🍴'
  const provenance = s.originFrom ? ` ← ${provenanceEmoji} (${s.originFrom})` : ''
  const lines = [
    `${emoji} \`${s.tmuxName}\`${badge}${provenance}`,
    `- ${title}`,
    `- ${ctx} (${msgCount} msgs · ${duration})`,
  ]
  if (e.latestLine) lines.push(`- ${e.latestLine}`)
  return lines.join('\n')
}

function buildListOutput(list: SessionEntry[], now: number): string {
  const buckets = new Map<string, SessionEntry[]>()
  for (const e of list) {
    const bucket = listTimeBucket(e.session.lastActive, now)
    const arr = buckets.get(bucket) ?? []
    arr.push(e)
    buckets.set(bucket, arr)
  }
  const sections: string[] = []
  for (const [label, items] of buckets) {
    sections.push(`### ${label}\n\n${items.map(formatSessionEntry).join('\n\n')}`)
  }
  return sections.join('\n')
}

// ---------------------------------------------------------------------------
// Auto-refresh list machinery
// ---------------------------------------------------------------------------

const LIST_MSGS_FILE = join(STATE_DIR, 'list-messages.json')
const MAX_LIST_MSGS = 5
let lastListMsgs: Array<{ channelId: string; messageId: string }> = []

function persistListMsgs(): void {
  try {
    writeFileSync(LIST_MSGS_FILE, JSON.stringify(lastListMsgs) + '\n', { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`daemon: failed to persist list-messages: ${err}\n`)
  }
}

function loadPersistedListMsgs(): void {
  try {
    const raw = readFileSync(LIST_MSGS_FILE, 'utf8')
    lastListMsgs = JSON.parse(raw) as Array<{ channelId: string; messageId: string }>
    if (lastListMsgs.length > 0) {
      process.stderr.write(`daemon: restored ${lastListMsgs.length} list message(s)\n`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`daemon: failed to load list-messages: ${err}\n`)
    }
  }
}

loadPersistedListMsgs()

// Debounced refresh: coalesces rapid lifecycle events into a single edit pass
let refreshTimer: ReturnType<typeof setTimeout> | null = null

export function debouncedRefreshListDisplay(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshListDisplay()
  }, 500)
}

async function refreshListDisplay(): Promise<void> {
  if (lastListMsgs.length === 0) return
  const now = Date.now()
  const live = registry.liveSessions()
  const all = live.sort((a, b) => b.lastActive - a.lastActive)

  let output: string
  if (live.length === 0) {
    output = 'No active sessions.'
  } else {
    const entries: SessionEntry[] = all.map(s => ({ session: s }))
    const latestInfos = await Promise.all(entries.map(async (e): Promise<string | undefined> => {
      try {
        const msgs = await gateway.fetchMessages(e.session.threadId, 1)
        if (msgs.length === 0) return undefined
        const m = msgs[0]
        const who = m.authorId === gateway.botId ? `<@${gateway.botId}>` : 'you'
        const msgUrl = gateway.getMessageUrl(e.session.threadId, m.id)
        return msgUrl ? `[📩 latest](${msgUrl}) — by ${who}` : `📩 latest — by ${who}`
      } catch { return undefined }
    }))
    const enriched = entries.map((e, i) => ({ ...e, latestLine: latestInfos[i] }))
    output = buildListOutput(enriched, now)
  }

  let changed = false
  for (let i = lastListMsgs.length - 1; i >= 0; i--) {
    const lm = lastListMsgs[i]
    try {
      await gateway.edit(lm.channelId, lm.messageId, output)
    } catch {
      // Edit failed (message deleted, channel archived, etc.) — remove stale entry
      lastListMsgs.splice(i, 1)
      changed = true
    }
  }
  if (changed) persistListMsgs()
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export async function handleListIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📊').catch(() => {})
  const live = registry.liveSessions()
  if (live.length === 0) {
    try { await gateway.send(msg.channelId, 'No active sessions.', { replyTo: msg.id }) } catch {}
    return
  }

  const now = Date.now()
  const all = live.sort((a, b) => b.lastActive - a.lastActive)

  // Backfill threadUrl for sessions that predate the caching feature
  await Promise.all(all.map(async s => {
    if (!s.threadUrl) {
      try {
        const url = await gateway.getThreadUrl(s.threadId)
        if (url) { s.threadUrl = url; registry.persist() }
      } catch {}
    }
  }))

  const entries: SessionEntry[] = all.map(s => ({ session: s }))

  // Phase 1: post immediately without latest-message info, grouped by time
  let sentMsg: { id: string } | undefined
  try {
    sentMsg = await gateway.send(msg.channelId, buildListOutput(entries, now), { replyTo: msg.id, unfurl: false })
  } catch { return }

  // Track for auto-refresh on lifecycle events (FILO — most recent first)
  if (sentMsg) {
    lastListMsgs.unshift({ channelId: msg.channelId, messageId: sentMsg.id })
    if (lastListMsgs.length > MAX_LIST_MSGS) lastListMsgs.pop()
    persistListMsgs()
  }

  // Phase 2: fetch latest message per thread in parallel, then edit
  const latestInfos = await Promise.all(entries.map(async (e): Promise<string | undefined> => {
    try {
      const msgs = await gateway.fetchMessages(e.session.threadId, 1)
      if (msgs.length === 0) return undefined
      const m = msgs[0]
      const who = m.authorId === gateway.botId ? `<@${gateway.botId}>` : 'you'
      const msgUrl = gateway.getMessageUrl(e.session.threadId, m.id)
      return msgUrl ? `[📩 latest](${msgUrl}) — by ${who}` : `📩 latest — by ${who}`
    } catch { return undefined }
  }))

  const enriched = entries.map((e, i) => ({ ...e, latestLine: latestInfos[i] }))
  const richText = buildListOutput(enriched, now)
  if (sentMsg) {
    try { await gateway.edit(msg.channelId, sentMsg.id, richText) } catch {}
  }
}

export async function handleUsageIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  try {
    execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
  } catch {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '📈').catch(() => {})
  const ctx = getContextPercent(info.tmuxName)
  const duration = formatDuration(Date.now() - info.createdAt)
  const msgs = info.messageCount ?? 0
  const status = transport.has(info.sessionId) ? 'connected' : 'disconnected'
  const desc = info.description ?? fallbackDescription(info.topic)

  const forkCount = [...registry.values()].filter(s => s.originType === 'fork' && s.originFrom === info.tmuxName).length

  const e = sessionEmoji(info.tmuxName)
  const lines = [
    `${e} \`${info.tmuxName}\` — ${desc}`,
    `    ◦ ${ctx} · ${msgs} msgs · ${duration} · ${status}`,
  ]
  if (forkCount > 0) lines.push(`    ◦ ${forkCount} fork${forkCount > 1 ? 's' : ''}`)
  if (info.originType === 'handoff' && info.originFrom) {
    const pe = sessionEmoji(info.originFrom)
    lines.push(`    ◦ 🤝 handed off from ${pe} \`${info.originFrom}\``)
  } else if (info.originType === 'fork' && info.originFrom) {
    const pe = sessionEmoji(info.originFrom)
    lines.push(`    ◦ 🍴 forked from ${pe} \`${info.originFrom}\``)
  }

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}

export async function handleHealthIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '💚').catch(() => {})
  const uptimeMin = Math.round((Date.now() - daemonStartedAt) / 60000)
  const liveSessions = registry.liveSessions()
  const deadSessions = registry.deadSessions()
  const connected = liveSessions.filter(s => transport.has(s.sessionId))
  const disconnected = liveSessions.filter(s => !transport.has(s.sessionId))
  const queuedMsgCount = [...transport.messageQueues.values()].reduce((sum, q) => sum + q.length, 0)

  let heartbeatAge = 'n/a'
  try {
    const hb = statSync(join(STATE_DIR, 'daemon.alive'))
    heartbeatAge = `${Math.round((Date.now() - hb.mtimeMs) / 1000)}s ago`
  } catch {}

  const lines = [
    `**Daemon Health**`,
    `• Uptime: ${uptimeMin}m`,
    `• Gateway: ${PLATFORM}`,
    `• Heartbeat: ${heartbeatAge}`,
    `• Sessions: ${connected.length} connected${disconnected.length > 0 ? `, ${disconnected.length} disconnected` : ''}${deadSessions.length > 0 ? `, ${deadSessions.length} dead` : ''}`,
    `• Queued messages: ${queuedMsgCount}`,
  ]

  if (disconnected.length > 0) {
    lines.push(`• ⚠️ Disconnected: ${disconnected.map(s => s.tmuxName).join(', ')}`)
  }
  if (deadSessions.length > 0) {
    lines.push(`• ☠️ Dead (recoverable): ${deadSessions.map(s => s.tmuxName).join(', ')}`)
  }

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}
