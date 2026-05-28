#!/usr/bin/env bun
/**
 * Chat routing daemon.
 *
 * Platform-agnostic message router that holds a single chat gateway connection
 * (Discord or Slack) and routes messages to/from Claude sessions via unix sockets.
 *
 * Platform selection: set CHAT_PLATFORM=discord (default) or CHAT_PLATFORM=slack
 *
 * Protocol: newline-delimited JSON over unix socket at
 *   ~/.claude/channels/discord/daemon.sock
 *
 * Bridge -> Daemon:
 *   {type: "register", sessionId: "main" | "<uuid>"}
 *   {type: "tool_call", id: "<unique>", name: "reply"|"react"|..., args: {...}}
 *   {type: "permission_response", request_id: "...", behavior: "allow"|"deny"}
 *
 * Daemon -> Bridge:
 *   {type: "registered", sessionId: "..."}
 *   {type: "tool_result", id: "<unique>", content: [...], isError?: true}
 *   {type: "notification", content: "...", meta: {...}}
 *   {type: "permission_request", request_id: "...", tool_name: "...", description: "...", input_preview: "..."}
 */

import { randomBytes, randomUUID } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  realpathSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { createServer, type Socket } from 'net'
import { execSync } from 'child_process'

import type { ChatGateway, InboundMessage, ButtonDef } from './gateway.js'

// ---------------------------------------------------------------------------
// Config & env
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const SOCK_PATH = join(STATE_DIR, 'daemon.sock')
const INBOX_DIR = join(STATE_DIR, 'inbox')

const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude-personal')
const DEFAULT_SESSION_CHANNEL = process.env.DEFAULT_SESSION_CHANNEL ?? '1506825982127112252'

// Load .env files into process.env. Real env wins, local .env takes priority over state dir .env.
const LOCAL_ENV_FILE = join(import.meta.dir, '.env')
for (const envFile of [LOCAL_ENV_FILE, ENV_FILE]) {
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

// Platform selection
const PLATFORM = (process.env.CHAT_PLATFORM ?? 'discord') as 'discord' | 'slack'

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

const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

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
// Permission regex
// ---------------------------------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Gateway instantiation
// ---------------------------------------------------------------------------

let gateway: ChatGateway

if (PLATFORM === 'slack') {
  const { SlackGateway } = await import('./slack-gateway.js')
  gateway = new SlackGateway(SLACK_APP_TOKEN!)
} else {
  const { DiscordGateway } = await import('./discord-gateway.js')
  gateway = new DiscordGateway()
}

// ---------------------------------------------------------------------------
// Access control types & helpers
// ---------------------------------------------------------------------------

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  threadReply?: boolean
  threadArchiveMinutes?: 60 | 1440 | 4320 | 10080
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`daemon: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('daemon: static mode -- dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Gate logic
// ---------------------------------------------------------------------------

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

async function gate(msg: InboundMessage): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.authorId

  if (msg.isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  // Guild/channel message
  const channelId = msg.isThread
    ? msg.parentChannelId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !(await gateway.isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

// ---------------------------------------------------------------------------
// Approval polling
// ---------------------------------------------------------------------------

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }
    void (async () => {
      try {
        await gateway.send(dmChannelId, "Paired! Say hi to Claude.")
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ---------------------------------------------------------------------------
// Chunk splitting
// ---------------------------------------------------------------------------

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---------------------------------------------------------------------------
// Cute session names
// ---------------------------------------------------------------------------

const SESSION_NAMES = [
  'spark', 'pixel', 'nova', 'drift', 'flint', 'ember', 'bloom', 'atlas',
  'qubit', 'prism', 'orbit', 'comet', 'patch', 'glyph', 'pulse', 'scout',
  'cedar', 'dusk', 'fern', 'haze', 'jade', 'lark', 'moss', 'pine',
  'reef', 'sage', 'tide', 'vale', 'wren', 'zinc', 'bolt', 'crisp',
]

function pickSessionName(): string {
  const used = new Set([...sessions.values()].map(s => s.tmuxName))
  try {
    const tmuxOut = execSync('tmux ls -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' })
    for (const line of tmuxOut.split('\n')) {
      if (line.trim()) used.add(line.trim())
    }
  } catch {}
  for (const name of SESSION_NAMES) {
    if (!used.has(name)) return name
  }
  return `session-${randomBytes(3).toString('hex')}`
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

type SessionInfo = {
  sessionId: string
  topic: string
  threadId: string
  createdAt: number
  lastActive: number
  tmuxName: string
  listening: boolean
}

const sessions = new Map<string, SessionInfo>()
const threadToSession = new Map<string, string>()

const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

function persistSessions(): void {
  try {
    const data = [...sessions.values()]
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`daemon: failed to persist sessions: ${err}\n`)
  }
}

function loadPersistedSessions(): void {
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf8')
    const data = JSON.parse(raw) as SessionInfo[]
    let restored = 0
    let dead = 0
    for (const info of data) {
      try {
        execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
      } catch {
        dead++
        continue
      }
      sessions.set(info.sessionId, info)
      threadToSession.set(info.threadId, info.sessionId)
      restored++
    }
    if (restored > 0 || dead > 0) {
      process.stderr.write(`daemon: restored ${restored} session(s), pruned ${dead} dead\n`)
    }
    if (dead > 0) persistSessions()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`daemon: failed to load sessions: ${err}\n`)
    }
  }
}

loadPersistedSessions()

// ---------------------------------------------------------------------------
// Bridge connection registry
// ---------------------------------------------------------------------------

type BridgeConn = {
  sessionId: string
  socket: Socket
  buf: string
}

const bridges = new Map<string, BridgeConn>()
const messageQueues = new Map<string, Array<Record<string, unknown>>>()
const MAX_QUEUE_SIZE = 50

function sendToBridge(bridge: BridgeConn, msg: Record<string, unknown>): void {
  try {
    bridge.socket.write(JSON.stringify(msg) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: failed to write to bridge ${bridge.sessionId}: ${err}\n`)
  }
}

function sendOrQueue(sessionId: string, msg: Record<string, unknown>): void {
  const bridge = bridges.get(sessionId)
  if (bridge) {
    sendToBridge(bridge, msg)
  } else {
    let queue = messageQueues.get(sessionId)
    if (!queue) {
      queue = []
      messageQueues.set(sessionId, queue)
    }
    if (queue.length < MAX_QUEUE_SIZE) {
      queue.push(msg)
    }
  }
}

function flushQueue(sessionId: string): void {
  const queue = messageQueues.get(sessionId)
  if (!queue || queue.length === 0) return
  const bridge = bridges.get(sessionId)
  if (!bridge) return
  process.stderr.write(`daemon: flushing ${queue.length} queued message(s) for ${sessionId}\n`)
  for (const msg of queue) {
    sendToBridge(bridge, msg)
  }
  messageQueues.delete(sessionId)
}

function getBridgeForSession(sessionId: string): BridgeConn | undefined {
  return bridges.get(sessionId)
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

type SpawnResult = { name: string; sessionId: string; threadId: string; url: string }

async function doSpawnSession(topic: string, chatId?: string, messageId?: string): Promise<SpawnResult> {
  let threadId: string | undefined

  const sessionId = randomUUID()
  const tmuxName = pickSessionName()
  const threadName = `${tmuxName}: ${topic}`.slice(0, 100)

  // Determine where to create the thread
  let targetChannelId = chatId
  if (targetChannelId) {
    try {
      const ch = await gateway.fetchChannel(targetChannelId)
      if (ch.isThread) {
        threadId = ch.id
      } else if (ch.isDM && gateway.platform === 'discord') {
        // Discord DMs don't support threads — redirect to a guild channel.
        // Slack DMs support threads natively, so keep the DM as target.
        targetChannelId = DEFAULT_SESSION_CHANNEL
      }
    } catch {
      targetChannelId = DEFAULT_SESSION_CHANNEL
    }
  } else {
    targetChannelId = DEFAULT_SESSION_CHANNEL
  }

  // Create thread if we don't have one yet
  if (!threadId) {
    if (messageId && targetChannelId === chatId) {
      try {
        const thread = await gateway.createThread(targetChannelId!, threadName, {
          messageId,
          archiveDuration: 1440,
        })
        threadId = thread.id
      } catch (err) {
        process.stderr.write(`daemon: createThread on message failed: ${err}\n`)
      }
    }

    if (!threadId) {
      // Post an anchor message and thread on it
      const anchor = await gateway.send(targetChannelId!, `Starting session **${tmuxName}**: ${topic}`)
      const thread = await gateway.createThread(targetChannelId!, threadName, {
        messageId: anchor.id,
        archiveDuration: 1440,
      })
      threadId = thread.id
    }
  }

  const escapedTopic = topic.replace(/'/g, "'\\''")
  const channelFlag = `plugin:discord@claude-plugins-official`
  const tmuxCmd = `tmux new-session -d -s '${tmuxName}' 'cd ~/trading && SESSION_ID=${sessionId} DAEMON_SOCK=${SOCK_PATH} CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG} claude --model "claude-opus-4-6[1m]" --channels ${channelFlag} --dangerously-skip-permissions "You are ${tmuxName}, a spawned session. Topic: ${escapedTopic}. Your Discord thread chat_id is ${threadId}. Read your memory files for context, then send a greeting to your thread using reply(chat_id=${threadId})."'`

  try {
    execSync(tmuxCmd, { stdio: 'pipe' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to spawn tmux session: ${msg}`)
  }

  const now = Date.now()
  sessions.set(sessionId, { sessionId, topic, threadId: threadId!, createdAt: now, lastActive: now, tmuxName, listening: false })
  threadToSession.set(threadId!, sessionId)
  persistSessions()

  const url = await gateway.getThreadUrl(threadId!)

  return { name: tmuxName, sessionId, threadId: threadId!, url }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{type: string; text: string}>; isError?: boolean }> {
  try {
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        // Validate channel is allowed
        const ch = await gateway.fetchChannel(chat_id)
        const access = loadAccess()
        if (ch.isDM) {
          if (!access.allowFrom.includes(ch.recipientId)) {
            throw new Error(`channel ${chat_id} is not allowlisted`)
          }
        } else {
          const key = ch.isThread ? ch.parentId ?? ch.id : ch.id
          if (!(key in access.groups)) {
            throw new Error(`channel ${chat_id} is not allowlisted`)
          }
        }

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('max 10 attachments per message')

        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo =
              reply_to != null &&
              replyMode !== 'off' &&
              (replyMode === 'all' || i === 0)
            const sent = await gateway.send(chat_id, chunks[i], {
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo ? { replyTo: reply_to } : {}),
            })
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }

      case 'fetch_messages': {
        const channelId = args.channel as string
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await gateway.fetchMessages(channelId, limit)
        const botId = gateway.botId
        const out =
          msgs.length === 0
            ? '(no messages)'
            : msgs
                .map(m => {
                  const who = m.authorId === botId ? 'me' : m.authorUsername
                  const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : ''
                  const text = m.content.replace(/[\r\n]+/g, ' \u23CE ')
                  return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
                })
                .join('\n')
        return { content: [{ type: 'text', text: out }] }
      }

      case 'react': {
        await gateway.react(args.chat_id as string, args.message_id as string, args.emoji as string)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'edit_message': {
        const edited = await gateway.edit(args.chat_id as string, args.message_id as string, args.text as string)
        return { content: [{ type: 'text', text: `edited (id: ${edited})` }] }
      }

      case 'create_thread': {
        const threadName = (args.name as string).slice(0, 100)
        const thread = await gateway.createThread(args.chat_id as string, threadName, {
          messageId: args.message_id as string | undefined,
          archiveDuration: (args.auto_archive_minutes as number | undefined) ?? 1440,
          text: args.text as string | undefined,
          files: (args.files as string[] | undefined),
        })
        const hasText = args.text as string | undefined
        return {
          content: [{
            type: 'text',
            text: hasText
              ? `thread created (thread_id: ${thread.id})`
              : `thread created (thread_id: ${thread.id})`,
          }],
        }
      }

      case 'download_attachment': {
        const results = await gateway.downloadAttachments(
          args.chat_id as string,
          args.message_id as string,
          INBOX_DIR,
        )
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'message has no attachments' }] }
        }
        const lines = results.map(r => `  ${r.path}  (${r.name}, ${r.contentType}, ${r.sizeKB}KB)`)
        return {
          content: [{ type: 'text', text: `downloaded ${results.length} attachment(s):\n${lines.join('\n')}` }],
        }
      }

      // --- Session management tools ---

      case 'spawn_session': {
        const result = await doSpawnSession(args.topic as string, args.chat_id as string | undefined, args.message_id as string | undefined)
        return { content: [{ type: 'text', text: `session spawned (name: ${result.name}, session_id: ${result.sessionId}, thread_id: ${result.threadId}${result.url ? `, url: ${result.url}` : ''})` }] }
      }

      case 'list_sessions': {
        const list = [...sessions.values()].map(s => ({
          name: s.tmuxName,
          session_id: s.sessionId,
          topic: s.topic,
          thread_id: s.threadId,
          created_at: new Date(s.createdAt).toISOString(),
          last_active: new Date(s.lastActive).toISOString(),
          status: bridges.has(s.sessionId) ? 'connected' : 'disconnected',
        }))
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
      }

      case 'kill_session': {
        const sessionId = args.session_id as string | undefined
        const threadId = args.thread_id as string | undefined

        let targetId: string | undefined
        if (sessionId) {
          targetId = sessionId
        } else if (threadId) {
          targetId = threadToSession.get(threadId)
        }

        if (!targetId || !sessions.has(targetId)) {
          throw new Error('session not found')
        }

        const info = sessions.get(targetId)!
        await killSession(info, 'session ended')
        return { content: [{ type: 'text', text: `killed session ${targetId}` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const killsInProgress = new Set<string>()

async function killSession(info: SessionInfo, reason: string): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  try {
    try {
      await gateway.send(info.threadId, `_${reason}_`)
    } catch (err) {
      process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
    }

    const tmuxName = info.tmuxName
    try {
      execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
    } catch {}

    const bridge = bridges.get(info.sessionId)
    if (bridge) {
      try { bridge.socket.end() } catch {}
      bridges.delete(info.sessionId)
    }

    threadToSession.delete(info.threadId)
    sessions.delete(info.sessionId)
    persistSessions()

    setTimeout(() => {
      try {
        execSync(`tmux has-session -t "${tmuxName}"`, { stdio: 'pipe' })
        execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
        process.stderr.write(`daemon: deferred kill caught lingering tmux session "${tmuxName}"\n`)
      } catch {}
      killsInProgress.delete(info.sessionId)
    }, 3000)
  } catch (err) {
    killsInProgress.delete(info.sessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Permission handling
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

gateway.onButtonClick(click => {
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(click.customId)
  if (!m) return

  const access = loadAccess()
  if (!access.allowFrom.includes(click.userId)) {
    void click.respond('Not authorized.')
    return
  }

  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      void click.respond('Details no longer available.')
      return
    }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
    } catch {
      prettyInput = input_preview
    }
    const expanded =
      `Permission: ${tool_name}\n\n` +
      `tool_name: ${tool_name}\n` +
      `description: ${description}\n` +
      `input_preview:\n${prettyInput}`
    const buttons: ButtonDef[] = [
      { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '\u2705' },
      { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '\u274C' },
    ]
    void click.respond(expanded, buttons)
    return
  }

  // Forward to main session bridge
  const mainBridge = getBridgeForSession('main')
  if (mainBridge) {
    sendToBridge(mainBridge, {
      type: 'permission_response',
      request_id,
      behavior,
    })
  }
  pendingPermissions.delete(request_id)
  const label = behavior === 'allow' ? 'Allowed' : 'Denied'
  void click.clearButtons(`${click.messageContent}\n\n${label}`)
})

// ---------------------------------------------------------------------------
// Spawn / kill / list intercepts
// ---------------------------------------------------------------------------

async function handleSpawnIntercept(msg: InboundMessage, topic: string, access: Access): Promise<void> {
  void gateway.react(msg.channelId, msg.id, access.ackReaction || '👀').catch(() => {})

  try {
    const result = await doSpawnSession(topic, msg.channelId, msg.id)

    if (msg.isDM) {
      // Slack DMs support threads natively — the session thread is already visible,
      // so skip the URL. Discord DMs redirect to a guild channel, so the URL helps.
      const reply = (result.url && gateway.platform === 'discord')
        ? `Spawned session **${result.name}** — ${result.url}`
        : `Spawned session **${result.name}**`
      await gateway.send(msg.channelId, reply, { replyTo: msg.id })
    }

    const mainBridge = getBridgeForSession('main')
    if (mainBridge) {
      sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] Spawned session **${result.name}** for topic: ${topic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn intercept failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Spawn failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}

async function handleKillIntercept(msg: InboundMessage, name: string): Promise<void> {
  let target: SessionInfo | undefined
  for (const s of sessions.values()) {
    if (s.tmuxName === name || s.topic.toLowerCase() === name.toLowerCase()) {
      target = s
      break
    }
  }
  if (!target) {
    try { await gateway.send(msg.channelId, `No session found matching "${name}"`, { replyTo: msg.id }) } catch {}
    return
  }
  await killSession(target, 'session ended')
  try { await gateway.send(msg.channelId, `Killed session **${target.tmuxName}**`, { replyTo: msg.id }) } catch {}
}

async function handleListIntercept(msg: InboundMessage): Promise<void> {
  if (sessions.size === 0) {
    try { await gateway.send(msg.channelId, 'No active sessions.', { replyTo: msg.id }) } catch {}
    return
  }
  const lines = [...sessions.values()].map(s => {
    const age = Math.round((Date.now() - s.createdAt) / 60000)
    const idle = Math.round((Date.now() - s.lastActive) / 60000)
    const status = bridges.has(s.sessionId) ? 'connected' : 'disconnected'
    return `**${s.tmuxName}** — ${s.topic} (${age}m old, ${idle}m idle, ${status})`
  })
  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Deliver a message to a session
// ---------------------------------------------------------------------------

async function deliverToSession(msg: InboundMessage, targetSessionId: string, access: Access): Promise<void> {
  void gateway.typing(msg.channelId).catch(() => {})
  if (access.ackReaction) {
    void gateway.react(msg.channelId, msg.id, access.ackReaction).catch(() => {})
  }

  const atts: string[] = msg.attachments.map(att => {
    const kb = (att.size / 1024).toFixed(0)
    return `${att.name} (${att.contentType ?? 'unknown'}, ${kb}KB)`
  })
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  let threadContext: Record<string, string> = {}
  if (msg.isThread) {
    const starter = await (gateway as any).getThreadStarterInfo?.(msg.channelId)
    if (starter) {
      threadContext = {
        thread_name: starter.threadName,
        thread_starter_user: starter.starterUser,
        thread_starter_content: starter.starterContent,
        thread_starter_id: starter.starterId,
      }
    }
  }

  const meta: Record<string, string> = {
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.authorUsername,
    user_id: msg.authorId,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    ...threadContext,
  }

  sendOrQueue(targetSessionId, { type: 'notification', content, meta })
}

// ---------------------------------------------------------------------------
// Inbound message handling
// ---------------------------------------------------------------------------

gateway.onThreadDelete(threadId => {
  const sessionId = threadToSession.get(threadId)
  if (!sessionId) return
  const info = sessions.get(sessionId)
  if (!info) return
  process.stderr.write(`daemon: thread ${threadId} deleted, killing session ${info.tmuxName}\n`)
  void killSession(info, 'thread deleted')
})

gateway.onMessageDelete((messageId, threadId) => {
  if (!threadId) return
  const sessionId = threadToSession.get(threadId)
  if (!sessionId) return
  const info = sessions.get(sessionId)
  if (!info) return
  process.stderr.write(`daemon: anchor message deleted, killing session ${info.tmuxName}\n`)
  void killSession(info, 'anchor message deleted')
})

gateway.onMessage(async (msg: InboundMessage) => {
  if (msg.isBot) return

  const access = loadAccess()
  const senderId = msg.authorId
  const isAllowed = access.allowFrom.includes(senderId)

  if (isAllowed) {
    // Command intercepts
    const spawnMatch = msg.content.match(/^(?:new session:|spawn:|\/spawn)\s*(.+)/i)
    if (spawnMatch) {
      const topic = spawnMatch[1].trim()
      if (topic) {
        void handleSpawnIntercept(msg, topic, access)
        return
      }
    }

    const killMatch = msg.content.match(/^(?:kill session:|kill:|\/kill)\s*(.+)/i)
    if (killMatch) {
      void handleKillIntercept(msg, killMatch[1].trim())
      return
    }

    const listMatch = msg.content.match(/^(?:\/sessions|list sessions)\s*$/i)
    if (listMatch) {
      void handleListIntercept(msg)
      return
    }

    // Session thread routing
    if (msg.isThread) {
      const mappedSession = threadToSession.get(msg.channelId)
      if (mappedSession) {
        const info = sessions.get(mappedSession)
        if (info) {
          const listenMatch = msg.content.match(/^(listen|pause)\s*$/i)
          if (listenMatch) {
            info.listening = listenMatch[1].toLowerCase() === 'listen'
            persistSessions()
            void gateway.react(msg.channelId, msg.id, info.listening ? '👂' : '⏸️').catch(() => {})
            return
          }

          const shouldRoute =
            info.listening ||
            msg.content.toLowerCase().startsWith(info.tmuxName) ||
            (msg.referenceMessageId && gateway.wasSentByUs(msg.referenceMessageId))

          if (shouldRoute) {
            info.lastActive = Date.now()
            void deliverToSession(msg, mappedSession, access)
            return
          }

          // Fallback: check if replying to bot message via gateway
          if (msg.referenceMessageId) {
            const mentioned = await gateway.isMentioned(msg)
            if (mentioned) {
              info.lastActive = Date.now()
              void deliverToSession(msg, mappedSession, access)
              return
            }
          }

          return
        }
      }
    }
  }

  // Normal gate
  const result = await gate(msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await gateway.send(msg.channelId, `${lead} -- run in Claude Code:\n\n/discord:access pair ${result.code}`, { replyTo: msg.id })
    } catch (err) {
      process.stderr.write(`daemon: failed to send pairing code: ${err}\n`)
    }
    return
  }

  let chat_id = msg.channelId

  // Thread creation for threadReply policy
  if (!msg.isDM && !msg.isThread) {
    const channelId = msg.channelId
    const policy = result.access.groups[channelId]
    if (policy?.threadReply) {
      const preview = msg.content.slice(0, 50).replace(/<@!?\d+>\s*/g, '').trim() || 'Thread'
      const archiveDuration = policy.threadArchiveMinutes ?? 1440

      if (msg.hasExistingThread && msg.existingThreadId) {
        chat_id = msg.existingThreadId
      } else {
        const threadId = await (gateway as any).startThreadOnMessage?.(msg, preview, archiveDuration)
        if (threadId) {
          chat_id = threadId
        }
      }
    }
  }

  // Permission-reply intercept
  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    const mainBridge = getBridgeForSession('main')
    if (mainBridge) {
      sendToBridge(mainBridge, {
        type: 'permission_response',
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      })
    }
    const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '\u2705' : '\u274C'
    void gateway.react(msg.channelId, msg.id, emoji).catch(() => {})
    return
  }

  // Typing indicator
  void gateway.typing(msg.channelId).catch(() => {})

  // Ack reaction
  if (result.access.ackReaction) {
    void gateway.react(msg.channelId, msg.id, result.access.ackReaction).catch(() => {})
  }

  // Build notification
  const atts: string[] = msg.attachments.map(att => {
    const kb = (att.size / 1024).toFixed(0)
    return `${att.name} (${att.contentType ?? 'unknown'}, ${kb}KB)`
  })
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  let threadContext: Record<string, string> = {}
  if (msg.isThread) {
    const starter = await (gateway as any).getThreadStarterInfo?.(msg.channelId)
    if (starter) {
      threadContext = {
        thread_name: starter.threadName,
        thread_starter_user: starter.starterUser,
        thread_starter_content: starter.starterContent,
        thread_starter_id: starter.starterId,
      }
    }
  }

  const meta: Record<string, string> = {
    chat_id,
    message_id: msg.id,
    user: msg.authorUsername,
    user_id: msg.authorId,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    ...threadContext,
  }

  // Route to session
  let targetSessionId = 'main'

  if (msg.isThread) {
    const threadId = msg.channelId
    const mappedSession = threadToSession.get(threadId)
    if (mappedSession && sessions.has(mappedSession)) {
      targetSessionId = mappedSession
      const info = sessions.get(mappedSession)!
      info.lastActive = Date.now()
    }
  }
  if (targetSessionId === 'main' && chat_id !== msg.channelId) {
    const mappedSession = threadToSession.get(chat_id)
    if (mappedSession && sessions.has(mappedSession)) {
      targetSessionId = mappedSession
      const info = sessions.get(mappedSession)!
      info.lastActive = Date.now()
    }
  }

  sendOrQueue(targetSessionId, { type: 'notification', content, meta })
})

// ---------------------------------------------------------------------------
// Unix socket server
// ---------------------------------------------------------------------------

function handleBridgeMessage(conn: BridgeConn, raw: string): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    process.stderr.write(`daemon: invalid JSON from bridge: ${raw.slice(0, 200)}\n`)
    return
  }

  switch (msg.type) {
    case 'register': {
      const sessionId = msg.sessionId as string
      conn.sessionId = sessionId

      const existing = bridges.get(sessionId)
      if (existing && existing.socket !== conn.socket) {
        process.stderr.write(`daemon: replacing bridge for session ${sessionId}\n`)
        try { existing.socket.end() } catch {}
      }

      bridges.set(sessionId, conn)
      sendToBridge(conn, { type: 'registered', sessionId })
      flushQueue(sessionId)
      process.stderr.write(`daemon: bridge registered for session ${sessionId}\n`)
      break
    }

    case 'tool_call': {
      const { id, name, args } = msg as { id: string; name: string; args: Record<string, unknown> }

      if (['spawn_session', 'list_sessions', 'kill_session'].includes(name)) {
        if (conn.sessionId !== 'main') {
          sendToBridge(conn, {
            type: 'tool_result',
            id,
            content: [{ type: 'text', text: `${name} is only available to the main session` }],
            isError: true,
          })
          return
        }
      }

      if (conn.sessionId !== 'main') {
        const info = sessions.get(conn.sessionId)
        if (info) info.lastActive = Date.now()
      }

      void executeTool(name, args).then(result => {
        sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        })
      }).catch(err => {
        sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: [{ type: 'text', text: `internal error: ${err}` }],
          isError: true,
        })
      })
      break
    }

    case 'permission_response': {
      break
    }

    case 'permission_request': {
      const { request_id, tool_name, description, input_preview } = msg
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const access = loadAccess()
      const text = `Permission: ${tool_name}`
      const buttons: ButtonDef[] = [
        { id: `perm:more:${request_id}`, label: 'See more', style: 'secondary' },
        { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '\u2705' },
        { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '\u274C' },
      ]
      for (const userId of access.allowFrom) {
        void gateway.sendDM(userId, text, buttons).catch(e => {
          process.stderr.write(`daemon: permission_request send to ${userId} failed: ${e}\n`)
        })
      }
      break
    }

    default:
      process.stderr.write(`daemon: unknown message type from bridge: ${msg.type}\n`)
  }
}

// Unlink stale socket file on startup
try {
  if (existsSync(SOCK_PATH)) {
    unlinkSync(SOCK_PATH)
  }
} catch {}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

const socketServer = createServer((socket: Socket) => {
  const conn: BridgeConn = {
    sessionId: '',
    socket,
    buf: '',
  }

  socket.on('data', (data: Buffer) => {
    conn.buf += data.toString()
    let nl: number
    while ((nl = conn.buf.indexOf('\n')) !== -1) {
      const line = conn.buf.slice(0, nl).trim()
      conn.buf = conn.buf.slice(nl + 1)
      if (line) handleBridgeMessage(conn, line)
    }
  })

  socket.on('end', () => {
    if (conn.sessionId) {
      process.stderr.write(`daemon: bridge disconnected for session ${conn.sessionId}\n`)
      if (bridges.get(conn.sessionId) === conn) {
        bridges.delete(conn.sessionId)
      }
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`daemon: bridge socket error: ${err}\n`)
    if (conn.sessionId && bridges.get(conn.sessionId) === conn) {
      bridges.delete(conn.sessionId)
    }
  })
})

socketServer.listen(SOCK_PATH, () => {
  try { chmodSync(SOCK_PATH, 0o700) } catch {}
  process.stderr.write(`daemon: listening on ${SOCK_PATH}\n`)
})

// ---------------------------------------------------------------------------
// Gateway start & graceful shutdown
// ---------------------------------------------------------------------------

await gateway.start(TOKEN!)
process.stderr.write(`daemon: ${PLATFORM} gateway started\n`)

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('daemon: shutting down\n')

  socketServer.close()
  try { unlinkSync(SOCK_PATH) } catch {}

  for (const [, bridge] of bridges) {
    try { bridge.socket.end() } catch {}
  }
  bridges.clear()

  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(gateway.stop()).finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
