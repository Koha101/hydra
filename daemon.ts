#!/usr/bin/env bun
/**
 * Discord routing daemon.
 *
 * Replaces the MCP server role of server.ts — holds the single Discord gateway
 * connection and routes messages to/from Claude sessions via unix sockets.
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

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
  type Attachment,
  type Interaction,
} from 'discord.js'
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

// Load ~/.claude/channels/discord/.env into process.env. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.DISCORD_BOT_TOKEN
const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write(
    `discord daemon: DISCORD_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: DISCORD_BOT_TOKEN=MTIz...\n`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  process.stderr.write(`discord daemon: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`discord daemon: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Permission regex (from server.ts)
// ---------------------------------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Discord client (identical to server.ts)
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// ---------------------------------------------------------------------------
// Access control types & helpers (verbatim from server.ts)
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
    process.stderr.write(`discord daemon: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('discord daemon: static mode -- dmPolicy "pairing" downgraded to "allowlist"\n')
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
// Gate logic (verbatim from server.ts)
// ---------------------------------------------------------------------------

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200

function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

async function gate(msg: Message): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
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

  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !(await isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) return true
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch {}
  }

  const text = msg.content
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// ---------------------------------------------------------------------------
// Approval polling (verbatim from server.ts)
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
        const ch = await fetchTextChannel(dmChannelId)
        if ('send' in ch) {
          await ch.send("Paired! Say hi to Claude.")
        }
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`discord daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ---------------------------------------------------------------------------
// Chunk splitting (verbatim from server.ts)
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
// Channel helpers (verbatim from server.ts)
// ---------------------------------------------------------------------------

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) {
    throw new Error(`channel ${id} not found or not text-based`)
  }
  return ch
}

async function fetchAllowedChannel(id: string) {
  const ch = await fetchTextChannel(id)
  const access = loadAccess()
  if (ch.type === ChannelType.DM) {
    if (access.allowFrom.includes(ch.recipientId)) return ch
  } else {
    const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id
    if (key in access.groups) return ch
  }
  throw new Error(`channel ${id} is not allowlisted -- add via /discord:access`)
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`)
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? `${att.id}`
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
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
  // Also check tmux for sessions from previous daemon runs
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
}

/** sessionId -> SessionInfo */
const sessions = new Map<string, SessionInfo>()
/** threadId (Discord) -> sessionId */
const threadToSession = new Map<string, string>()

const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

function persistSessions(): void {
  try {
    const data = [...sessions.values()]
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`discord daemon: failed to persist sessions: ${err}\n`)
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
      process.stderr.write(`discord daemon: restored ${restored} session(s), pruned ${dead} dead\n`)
    }
    if (dead > 0) persistSessions()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`discord daemon: failed to load sessions: ${err}\n`)
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

/** sessionId -> BridgeConn */
const bridges = new Map<string, BridgeConn>()

function sendToBridge(bridge: BridgeConn, msg: Record<string, unknown>): void {
  try {
    bridge.socket.write(JSON.stringify(msg) + '\n')
  } catch (err) {
    process.stderr.write(`discord daemon: failed to write to bridge ${bridge.sessionId}: ${err}\n`)
  }
}

function getBridgeForSession(sessionId: string): BridgeConn | undefined {
  return bridges.get(sessionId)
}

// ---------------------------------------------------------------------------
// Spawn helper — returns structured data, used by both tool handler and intercept
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
    const ch = await fetchTextChannel(targetChannelId)
    if (ch.isThread()) {
      threadId = ch.id
    } else if (ch.type === ChannelType.DM) {
      targetChannelId = DEFAULT_SESSION_CHANNEL
    }
  } else {
    targetChannelId = DEFAULT_SESSION_CHANNEL
  }

  // Create thread if we don't have one yet
  if (!threadId) {
    const ch = await fetchTextChannel(targetChannelId!)

    if (messageId && targetChannelId === chatId) {
      try {
        const msg = await ch.messages.fetch(messageId)
        const thread = await msg.startThread({ name: threadName, autoArchiveDuration: 1440 })
        threadId = thread.id
      } catch (err) {
        process.stderr.write(`discord daemon: startThread on message failed: ${err}\n`)
      }
    }

    if (!threadId) {
      if ('send' in ch) {
        const anchor = await (ch as any).send(`Starting session **${tmuxName}**: ${topic}`)
        const thread = await anchor.startThread({ name: threadName, autoArchiveDuration: 1440 })
        noteSent(anchor.id)
        threadId = thread.id
      } else {
        throw new Error('channel does not support sending messages')
      }
    }
  }

  const escapedTopic = topic.replace(/'/g, "'\\''")
  const tmuxCmd = `tmux new-session -d -s '${tmuxName}' 'cd ~/trading && SESSION_ID=${sessionId} DAEMON_SOCK=${SOCK_PATH} CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG} claude --model "claude-opus-4-6[1m]" --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions "You are ${tmuxName}, a spawned session. Topic: ${escapedTopic}. Your Discord thread chat_id is ${threadId}. Read your memory files for context, then send a greeting to your thread using reply(chat_id=${threadId})."'`

  try {
    execSync(tmuxCmd, { stdio: 'pipe' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to spawn tmux session: ${msg}`)
  }

  const now = Date.now()
  sessions.set(sessionId, { sessionId, topic, threadId, createdAt: now, lastActive: now, tmuxName })
  threadToSession.set(threadId, sessionId)
  persistSessions()

  let url = ''
  try {
    const threadCh = await client.channels.fetch(threadId)
    if (threadCh && 'guildId' in threadCh && threadCh.guildId) {
      url = `https://discord.com/channels/${threadCh.guildId}/${threadId}`
    }
  } catch {}

  return { name: tmuxName, sessionId, threadId, url }
}

// ---------------------------------------------------------------------------
// Tool execution (mirrors server.ts CallToolRequestSchema handler)
// ---------------------------------------------------------------------------

async function executeTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{type: string; text: string}>; isError?: boolean }> {
  try {
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        const ch = await fetchAllowedChannel(chat_id)
        if (!('send' in ch)) throw new Error('channel is not sendable')

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')

        const access = loadAccess()
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
            const sent = await ch.send({
              content: chunks[i],
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo
                ? { reply: { messageReference: reply_to, failIfNotExists: false } }
                : {}),
            })
            noteSent(sent.id)
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
        const ch = await fetchAllowedChannel(args.channel as string)
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await ch.messages.fetch({ limit })
        const me = client.user?.id
        const arr = [...msgs.values()].reverse()
        const out =
          arr.length === 0
            ? '(no messages)'
            : arr
                .map(m => {
                  const who = m.author.id === me ? 'me' : m.author.username
                  const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
                  const text = m.content.replace(/[\r\n]+/g, ' \u23CE ')
                  return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
                })
                .join('\n')
        return { content: [{ type: 'text', text: out }] }
      }

      case 'react': {
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const msg = await ch.messages.fetch(args.message_id as string)
        await msg.react(args.emoji as string)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'edit_message': {
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const msg = await ch.messages.fetch(args.message_id as string)
        const edited = await msg.edit(args.text as string)
        return { content: [{ type: 'text', text: `edited (id: ${edited.id})` }] }
      }

      case 'create_thread': {
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const threadName = (args.name as string).slice(0, 100)
        const archiveDuration = (args.auto_archive_minutes as number | undefined) ?? 1440
        const messageId = args.message_id as string | undefined

        let thread
        if (messageId) {
          const msg = await ch.messages.fetch(messageId)
          thread = await msg.startThread({ name: threadName, autoArchiveDuration: archiveDuration })
        } else {
          if (!('threads' in ch)) throw new Error('channel does not support threads')
          thread = await (ch as any).threads.create({ name: threadName, autoArchiveDuration: archiveDuration })
        }

        const text = args.text as string | undefined
        const files = (args.files as string[] | undefined) ?? []
        if (text) {
          for (const f of files) {
            assertSendable(f)
            const st = statSync(f)
            if (st.size > MAX_ATTACHMENT_BYTES) {
              throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
            }
          }
          const sent = await thread.send({
            content: text,
            ...(files.length > 0 ? { files } : {}),
          })
          noteSent(sent.id)
          return { content: [{ type: 'text', text: `thread created (thread_id: ${thread.id}, message_id: ${sent.id})` }] }
        }

        return { content: [{ type: 'text', text: `thread created (thread_id: ${thread.id})` }] }
      }

      case 'download_attachment': {
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const msg = await ch.messages.fetch(args.message_id as string)
        if (msg.attachments.size === 0) {
          return { content: [{ type: 'text', text: 'message has no attachments' }] }
        }
        const lines: string[] = []
        for (const att of msg.attachments.values()) {
          const path = await downloadAttachment(att)
          const kb = (att.size / 1024).toFixed(0)
          lines.push(`  ${path}  (${safeAttName(att)}, ${att.contentType ?? 'unknown'}, ${kb}KB)`)
        }
        return {
          content: [{ type: 'text', text: `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}` }],
        }
      }

      // --- Session management tools (main session only) ---

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

async function killSession(info: SessionInfo, reason: string): Promise<void> {
  // Post goodbye message in the thread
  try {
    const ch = await fetchTextChannel(info.threadId)
    if ('send' in ch) {
      await (ch as any).send(`_${reason}_`)
    }
  } catch (err) {
    process.stderr.write(`discord daemon: failed to post session end message: ${err}\n`)
  }

  // Kill tmux session
  try {
    execSync(`tmux kill-session -t "${info.tmuxName}"`, { stdio: 'pipe' })
  } catch {
    // Already dead, ignore
  }

  // Clean up bridge connection
  const bridge = bridges.get(info.sessionId)
  if (bridge) {
    try { bridge.socket.end() } catch {}
    bridges.delete(info.sessionId)
  }

  // Remove from maps
  threadToSession.delete(info.threadId)
  sessions.delete(info.sessionId)
  persistSessions()
}

// ---------------------------------------------------------------------------
// Permission handling (mirrors server.ts)
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// Button-click handler for permission requests
client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isButton()) return
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
  if (!m) return
  const access = loadAccess()
  if (!access.allowFrom.includes(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await interaction.reply({ content: 'Details no longer available.', ephemeral: true }).catch(() => {})
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
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm:allow:${request_id}`)
        .setLabel('Allow')
        .setEmoji({ name: '\u2705' })
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm:deny:${request_id}`)
        .setLabel('Deny')
        .setEmoji({ name: '\u274C' })
        .setStyle(ButtonStyle.Danger),
    )
    await interaction.update({ content: expanded, components: [row] }).catch(() => {})
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
  await interaction
    .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
    .catch(() => {})
})

// ---------------------------------------------------------------------------
// Spawn intercept — handles spawn triggers directly without routing to byte
// ---------------------------------------------------------------------------

async function handleSpawnIntercept(msg: Message, topic: string, access: Access): Promise<void> {
  void msg.react(access.ackReaction || '👀').catch(() => {})

  try {
    const result = await doSpawnSession(topic, msg.channelId, msg.id)

    // Only reply in DMs (guild channels already have the thread visible)
    if (msg.channel.isDMBased()) {
      const reply = result.url
        ? `Spawned session **${result.name}** — ${result.url}`
        : `Spawned session **${result.name}**`
      const ch = await fetchTextChannel(msg.channelId)
      if ('send' in ch) {
        await (ch as any).send({ content: reply, reply: { messageReference: msg.id, failIfNotExists: false } })
      }
    }

    // Notify main session so byte knows
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
    process.stderr.write(`discord daemon: spawn intercept failed: ${errMsg}\n`)
    try { await msg.reply(`Spawn failed: ${errMsg}`) } catch {}
  }
}

async function handleKillIntercept(msg: Message, name: string): Promise<void> {
  // Find session by tmux name or topic
  let target: SessionInfo | undefined
  for (const s of sessions.values()) {
    if (s.tmuxName === name || s.topic.toLowerCase() === name.toLowerCase()) {
      target = s
      break
    }
  }
  if (!target) {
    try { await msg.reply(`No session found matching "${name}"`) } catch {}
    return
  }
  await killSession(target, 'session ended')
  try { await msg.reply(`Killed session **${target.tmuxName}**`) } catch {}
}

async function handleListIntercept(msg: Message): Promise<void> {
  if (sessions.size === 0) {
    try { await msg.reply('No active sessions.') } catch {}
    return
  }
  const lines = [...sessions.values()].map(s => {
    const age = Math.round((Date.now() - s.createdAt) / 60000)
    const idle = Math.round((Date.now() - s.lastActive) / 60000)
    const status = bridges.has(s.sessionId) ? 'connected' : 'disconnected'
    return `**${s.tmuxName}** — ${s.topic} (${age}m old, ${idle}m idle, ${status})`
  })
  try { await msg.reply(lines.join('\n')) } catch {}
}

// ---------------------------------------------------------------------------
// Deliver a message directly to a session (bypasses gate)
// ---------------------------------------------------------------------------

async function deliverToSession(msg: Message, targetSessionId: string, access: Access): Promise<void> {
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }
  if (access.ackReaction) {
    void msg.react(access.ackReaction).catch(() => {})
  }

  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  let threadContext: Record<string, string> = {}
  if (msg.channel.isThread()) {
    try {
      const starter = await msg.channel.fetchStarterMessage()
      if (starter) {
        threadContext = {
          thread_name: msg.channel.name,
          thread_starter_user: starter.author.username,
          thread_starter_content: starter.content.slice(0, 500),
          thread_starter_id: starter.id,
        }
      }
    } catch {}
  }

  const meta: Record<string, string> = {
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    ...threadContext,
  }

  const bridge = getBridgeForSession(targetSessionId)
  if (bridge) {
    sendToBridge(bridge, { type: 'notification', content, meta })
  } else if (targetSessionId !== 'main') {
    const mainBridge = getBridgeForSession('main')
    if (mainBridge) {
      sendToBridge(mainBridge, { type: 'notification', content, meta })
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound Discord message handling
// ---------------------------------------------------------------------------

client.on('threadDelete', thread => {
  const sessionId = threadToSession.get(thread.id)
  if (!sessionId) return
  const info = sessions.get(sessionId)
  if (!info) return
  process.stderr.write(`discord daemon: thread ${thread.id} deleted, killing session ${info.tmuxName}\n`)
  void killSession(info, 'thread deleted')
})

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch(e => process.stderr.write(`discord daemon: handleInbound failed: ${e}\n`))
})

async function handleInbound(msg: Message): Promise<void> {
  // Command intercepts run before the gate — they only need the sender to be
  // in allowFrom (skip mention requirement so commands work in any channel).
  const access = loadAccess()
  const senderId = msg.author.id
  const isAllowed = access.allowFrom.includes(senderId)

  if (isAllowed) {
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
      const name = killMatch[1].trim()
      void handleKillIntercept(msg, name)
      return
    }

    const listMatch = msg.content.match(/^(?:\/sessions|list sessions)\s*$/i)
    if (listMatch) {
      void handleListIntercept(msg)
      return
    }

    // Messages in session-mapped threads bypass the gate entirely
    if (msg.channel.isThread()) {
      const mappedSession = threadToSession.get(msg.channelId)
      if (mappedSession) {
        const info = sessions.get(mappedSession)
        if (info) {
          info.lastActive = Date.now()
          void deliverToSession(msg, mappedSession, access)
          return
        }
      }
    }
  }

  // Normal gate for everything else (checks mention, channel policy, etc.)
  const result = await gate(msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await msg.reply(
        `${lead} -- run in Claude Code:\n\n/discord:access pair ${result.code}`,
      )
    } catch (err) {
      process.stderr.write(`discord daemon: failed to send pairing code: ${err}\n`)
    }
    return
  }

  let chat_id = msg.channelId

  // Guild channels with threadReply: create a thread on the triggering
  // message so replies don't clutter the main channel.
  if (!msg.channel.isDMBased() && !msg.channel.isThread()) {
    const channelId = msg.channelId
    const policy = result.access.groups[channelId]
    if (policy?.threadReply) {
      const preview = msg.content.slice(0, 50).replace(/<@!?\d+>\s*/g, '').trim() || 'Thread'
      const archiveDuration = policy.threadArchiveMinutes ?? 1440

      if (msg.hasThread && msg.thread) {
        chat_id = msg.thread.id
      } else {
        try {
          const thread = await msg.startThread({ name: preview, autoArchiveDuration: archiveDuration })
          chat_id = thread.id
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          process.stderr.write(
            `discord daemon: startThread failed (channel type: ${msg.channel.type}): ${errMsg}\n`,
          )
          try {
            const refetched = await msg.channel.messages.fetch(msg.id)
            if (refetched.hasThread && refetched.thread) {
              chat_id = refetched.thread.id
            }
          } catch (reErr) {
            process.stderr.write(
              `discord daemon: thread race recovery fetch failed: ${reErr instanceof Error ? reErr.message : String(reErr)}\n`,
            )
          }
        }
      }
    }
  }

  // Permission-reply intercept: "yes xxxxx" / "no xxxxx"
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
    void msg.react(emoji).catch(() => {})
    return
  }

  // Typing indicator
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }

  // Ack reaction
  const gatedAccess = result.access
  if (gatedAccess.ackReaction) {
    void msg.react(gatedAccess.ackReaction).catch(() => {})
  }

  // Attachment listing
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  // Thread context
  let threadContext: Record<string, string> = {}
  if (msg.channel.isThread()) {
    try {
      const starter = await msg.channel.fetchStarterMessage()
      if (starter) {
        threadContext = {
          thread_name: msg.channel.name,
          thread_starter_user: starter.author.username,
          thread_starter_content: starter.content.slice(0, 500),
          thread_starter_id: starter.id,
        }
      }
    } catch {}
  }

  const meta: Record<string, string> = {
    chat_id,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    ...threadContext,
  }

  // Route: determine which session gets this message
  // Check if the message is in a thread that's mapped to a spawned session
  let targetSessionId = 'main'

  // If the message is in a thread, check thread mapping
  if (msg.channel.isThread()) {
    const threadId = msg.channelId
    const mappedSession = threadToSession.get(threadId)
    if (mappedSession && sessions.has(mappedSession)) {
      targetSessionId = mappedSession
      // Update last_active
      const info = sessions.get(mappedSession)!
      info.lastActive = Date.now()
    }
  }
  // Also check if the chat_id (possibly a newly created thread) is mapped
  if (targetSessionId === 'main' && chat_id !== msg.channelId) {
    const mappedSession = threadToSession.get(chat_id)
    if (mappedSession && sessions.has(mappedSession)) {
      targetSessionId = mappedSession
      const info = sessions.get(mappedSession)!
      info.lastActive = Date.now()
    }
  }

  const bridge = getBridgeForSession(targetSessionId)
  if (!bridge) {
    // No bridge connected for this session — if it's a spawned session, try main
    if (targetSessionId !== 'main') {
      const mainBridge = getBridgeForSession('main')
      if (mainBridge) {
        sendToBridge(mainBridge, { type: 'notification', content, meta })
      }
    }
    // If main isn't connected either, message is lost (same as server.ts when CC is disconnected)
    return
  }

  sendToBridge(bridge, { type: 'notification', content, meta })
}

// ---------------------------------------------------------------------------
// Unix socket server
// ---------------------------------------------------------------------------

function handleBridgeMessage(conn: BridgeConn, raw: string): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    process.stderr.write(`discord daemon: invalid JSON from bridge: ${raw.slice(0, 200)}\n`)
    return
  }

  switch (msg.type) {
    case 'register': {
      const sessionId = msg.sessionId as string
      conn.sessionId = sessionId

      // If another bridge is already registered for this sessionId, disconnect it
      const existing = bridges.get(sessionId)
      if (existing && existing.socket !== conn.socket) {
        process.stderr.write(`discord daemon: replacing bridge for session ${sessionId}\n`)
        try { existing.socket.end() } catch {}
      }

      bridges.set(sessionId, conn)
      sendToBridge(conn, { type: 'registered', sessionId })
      process.stderr.write(`discord daemon: bridge registered for session ${sessionId}\n`)
      break
    }

    case 'tool_call': {
      const { id, name, args } = msg as { id: string; name: string; args: Record<string, unknown> }

      // Session management tools are only callable by the main session
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

      // Update last_active for spawned sessions
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
      // Forward permission response — only from main session (DM users)
      const mainBridge = getBridgeForSession('main')
      if (conn === mainBridge) {
        // This is the main session relaying a permission response back.
        // The daemon doesn't need to do anything here beyond forwarding
        // which already happened via the Discord button handler or text reply.
        // But if a bridge sends it explicitly, we can store/forward as needed.
      }
      break
    }

    case 'permission_request': {
      // A bridge is forwarding a permission request to be sent to DM users.
      const { request_id, tool_name, description, input_preview } = msg
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const access = loadAccess()
      const text = `Permission: ${tool_name}`
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`perm:more:${request_id}`)
          .setLabel('See more')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`perm:allow:${request_id}`)
          .setLabel('Allow')
          .setEmoji({ name: '\u2705' })
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm:deny:${request_id}`)
          .setLabel('Deny')
          .setEmoji({ name: '\u274C' })
          .setStyle(ButtonStyle.Danger),
      )
      // Only send to DM allowlisted users (same as server.ts)
      for (const userId of access.allowFrom) {
        void (async () => {
          try {
            const user = await client.users.fetch(userId)
            await user.send({ content: text, components: [row] })
          } catch (e) {
            process.stderr.write(`discord daemon: permission_request send to ${userId} failed: ${e}\n`)
          }
        })()
      }
      break
    }

    default:
      process.stderr.write(`discord daemon: unknown message type from bridge: ${msg.type}\n`)
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
    sessionId: '', // set on register
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
      process.stderr.write(`discord daemon: bridge disconnected for session ${conn.sessionId}\n`)
      // Remove from bridge map but don't kill the session/thread
      if (bridges.get(conn.sessionId) === conn) {
        bridges.delete(conn.sessionId)
      }
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`discord daemon: bridge socket error: ${err}\n`)
    if (conn.sessionId && bridges.get(conn.sessionId) === conn) {
      bridges.delete(conn.sessionId)
    }
  })
})

socketServer.listen(SOCK_PATH, () => {
  // Lock socket file to owner
  try { chmodSync(SOCK_PATH, 0o700) } catch {}
  process.stderr.write(`discord daemon: listening on ${SOCK_PATH}\n`)
})

// ---------------------------------------------------------------------------
// Discord ready & login
// ---------------------------------------------------------------------------

client.once('ready', c => {
  process.stderr.write(`discord daemon: gateway connected as ${c.user.tag}\n`)
})

client.on('error', err => {
  process.stderr.write(`discord daemon: client error: ${err}\n`)
})

client.login(TOKEN).catch(err => {
  process.stderr.write(`discord daemon: login failed: ${err}\n`)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('discord daemon: shutting down\n')

  // Close the unix socket server
  socketServer.close()
  try { unlinkSync(SOCK_PATH) } catch {}

  // Close all bridge connections
  for (const [, bridge] of bridges) {
    try { bridge.socket.end() } catch {}
  }
  bridges.clear()

  // Disconnect Discord
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
