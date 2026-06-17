import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { gateway, STATE_DIR } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { doSpawnSession, killSession, tryResume, tryRespawn } from '../session-lifecycle.js'
import { debouncedRefreshListDisplay } from './status.js'
import type { InboundMessage } from '../../gateway.js'
import type { Access } from '../access.js'

const RESTART_PENDING_FILE = join(STATE_DIR, 'restart-pending.json')

export async function handleSpawnIntercept(msg: InboundMessage, topic: string, access: Access): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🚀').catch(() => {})

  // If spawn is typed in a thread with a dead session, target that thread so it gets reused
  let chatId = msg.channelId
  if (msg.isThread && msg.existingThreadId) {
    const staleId = registry.getByThread(msg.existingThreadId)
    if (staleId && registry.has(staleId)) {
      const staleInfo = registry.get(staleId)!
      let tmuxAlive = false
      try { execSync(`tmux has-session -t '${staleInfo.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}
      if (tmuxAlive) {
        try { await gateway.send(msg.channelId, `Thread already has a live session (**${staleInfo.tmuxName}**). Spawning in a new thread instead.`, { replyTo: msg.id }) } catch {}
      } else {
        chatId = msg.existingThreadId
      }
    }
  }

  try {
    const result = await doSpawnSession(topic, chatId, msg.id)

    if (msg.isDM) {
      const e = sessionEmoji(result.name)
      const base = (result.url && !gateway.canThreadInDM)
        ? `Spawned ${e} \`${result.name}\` — ${result.url}`
        : `Spawned ${e} \`${result.name}\``
      const reply = `${base}\nView in any terminal: \`tmux attach -t ${result.name}\``
      await gateway.send(msg.channelId, reply, { replyTo: msg.id })
    }

    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] Spawned ${sessionEmoji(result.name)} \`${result.name}\` for topic: ${topic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }

    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn intercept failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Spawn failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}

export async function handleKillIntercept(msg: InboundMessage, name: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  let target: ReturnType<typeof registry.get>
  for (const s of registry.values()) {
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
  debouncedRefreshListDisplay()
}

export async function handleRestartIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔄').catch(() => {})

  const restartScript = join(import.meta.dir, '..', '..', 'restart-daemon.sh')
  try {
    await gateway.send(msg.channelId, `🔄 Restarting daemon — back in a moment...`, { replyTo: msg.id })
  } catch {}

  try {
    const restartChatId = msg.isThread && msg.existingThreadId ? msg.existingThreadId : msg.channelId
    writeFileSync(RESTART_PENDING_FILE, JSON.stringify({ chatId: restartChatId, messageId: msg.id, ts: Date.now() }) + '\n')
  } catch {}

  let restartFailed = false
  try {
    execSync(`nohup bash "${restartScript}" > /dev/null 2>&1 &`, {
      stdio: 'pipe',
      timeout: 10_000,
      shell: '/bin/bash',
      env: { ...process.env, PATH: `${homedir()}/.asdf/shims:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    })
  } catch (err) {
    restartFailed = true
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: restart failed: ${errMsg}\n`)
  }
  if (restartFailed) {
    try { unlinkSync(RESTART_PENDING_FILE) } catch {}
    try {
      await gateway.send(msg.channelId, `❌ Restart failed — daemon is still running on old code.`, { replyTo: msg.id })
    } catch {}
  }
}

export async function announceRestartComplete(): Promise<void> {
  try {
    const raw = readFileSync(RESTART_PENDING_FILE, 'utf8')
    const { chatId, messageId, ts } = JSON.parse(raw) as { chatId: string; messageId: string; ts: number }
    unlinkSync(RESTART_PENDING_FILE)
    const elapsedSec = Math.round((Date.now() - ts) / 1000)
    await gateway.send(chatId, `✨ Back online — restart took ${elapsedSec}s.`, { replyTo: messageId })
  } catch {}
}

export async function handleReconnectIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔌').catch(() => {})
  if (!gateway.forceReconnect) {
    try { await gateway.send(msg.channelId, `Reconnect not supported on this platform.`, { replyTo: msg.id }) } catch {}
    return
  }
  const result = await gateway.forceReconnect()
  const emoji = result.ok ? '✅' : '❌'
  try { await gateway.send(msg.channelId, `${emoji} ${result.message}`, { replyTo: msg.id }) } catch {}
}

export async function handleCommandsIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📋').catch(() => {})
  const text = [
    '**Bridge Commands**',
    '',
    '**Global (work from anywhere):**',
    '• 🚀 `spawn: <topic>` — spawn an isolated Claude session in its own thread',
    '• 📊 `list sessions` — show all running sessions with lineage',
    '• ☠️ `kill session: <name>` — terminate a named session',
    '• 💚 `health` / `status` — daemon health and diagnostics',
    '• 🔌 `reconnect` — re-establish chat connection without restarting',
    '• 🔄 `restart` — restart the daemon (picks up code changes, sessions reconnect)',
    '• 🔮 `recover` — revive dead sessions from a crash',
    '',
    '**Thread-scoped (in a session thread only, ❌ elsewhere):**',
    '• 🍴 `fork` / `fork: <description>` — fork into a new thread with full history',
    '• 🍽️ `forks` — list all forks from this thread',
    '• 🤝 `handoff` / `handoff: <direction>` — distill context into an artifact',
    '• 🤝 `/go` — launch the handoff successor',
    '• ⏯️ `resume` — reconnect to a dead session with full context (via --resume)',
    '• 🔁 `respawn` — fresh session that reads thread history and continues',
    '• 📈 `usage` — session stats: context %, messages, runtime, fork count',
    '• ☠️ `kill` — kill this session',
    '• 👂/⏸️ `listen` / `pause` — toggle whether the session responds to all messages',
    '',
    '**Other:**',
    '• 📋 `commands` — this list',
  ].join('\n')
  try { await gateway.send(msg.channelId, text, { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Recover — crash recovery via resume or resurrect
// ---------------------------------------------------------------------------

let recoveryInProgress = false
const MAX_CONCURRENT = 2
const STAGGER_MS = 5_000

async function recoverOne(dead: SessionInfo): Promise<{ name: string; method: 'resumed' | 'resurrected'; newName: string; threadUrl?: string } | { name: string; method: 'failed'; reason: string; threadUrl?: string }> {
  const originalName = dead.tmuxName

  if (dead.claudeSessionId) {
    const result = await tryResume(dead)
    if (result) {
      return { name: originalName, method: 'resumed', newName: result.name, threadUrl: dead.threadUrl }
    }
    process.stderr.write(`daemon: recover ${originalName}: resume failed or health check timed out, falling back to resurrect\n`)
  }

  const result = await tryRespawn(dead.threadId, dead.topic, originalName)
  if (result) {
    return { name: originalName, method: 'resurrected', newName: result.name, threadUrl: dead.threadUrl }
  }
  return { name: originalName, method: 'failed', reason: 'both resume and resurrect failed', threadUrl: dead.threadUrl }
}

export async function handleRecoverIntercept(msg: InboundMessage, targetName?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔮').catch(() => {})

  if (recoveryInProgress) {
    try { await gateway.send(msg.channelId, 'Recovery already in progress.', { replyTo: msg.id }) } catch {}
    return
  }

  const allDead = registry.deadSessions()
  if (allDead.length === 0) {
    try { await gateway.send(msg.channelId, 'No dead sessions to recover.', { replyTo: msg.id }) } catch {}
    return
  }

  let targets = allDead
  if (targetName && targetName !== 'all') {
    targets = targets.filter(s => s.tmuxName === targetName)
    if (targets.length === 0) {
      try { await gateway.send(msg.channelId, `"${targetName}" not found in dead sessions.`, { replyTo: msg.id }) } catch {}
      return
    }
  }

  targets.sort((a, b) => b.lastActive - a.lastActive)

  recoveryInProgress = true
  try {
    await gateway.send(msg.channelId, `🔮 Recovering ${targets.length} session(s)...`, { replyTo: msg.id })
  } catch {}

  const results: Awaited<ReturnType<typeof recoverOne>>[] = []

  try {
    let active = 0
    const queue = [...targets]

    while (queue.length > 0) {
      while (active < MAX_CONCURRENT && queue.length > 0) {
        const dead = queue.shift()!
        active++

        recoverOne(dead).then(r => {
          results.push(r)
          if (r.method !== 'failed') {
            const e = sessionEmoji(r.newName)
            void gateway.send(dead.threadId, `🔮 ${e} \`${r.newName}\` recovered (${r.method})`).catch(() => {})
          }
        }).catch(err => {
          results.push({ name: dead.tmuxName, method: 'failed' as const, reason: String(err) })
        }).finally(() => {
          active--
        })

        if (queue.length > 0) await new Promise(r => setTimeout(r, STAGGER_MS))
      }
      if (active > 0) await new Promise(r => setTimeout(r, 2_000))
    }

    while (active > 0) await new Promise(r => setTimeout(r, 1_000))
  } finally {
    recoveryInProgress = false
  }

  const resumed = results.filter(r => r.method === 'resumed')
  const resurrected = results.filter(r => r.method === 'resurrected')
  const failed = results.filter(r => r.method === 'failed') as Array<{ name: string; method: 'failed'; reason: string }>

  const fmtName = (r: { name: string; threadUrl?: string }) =>
    r.threadUrl ? `[\`${r.name}\`](${r.threadUrl})` : `\`${r.name}\``

  const lines = [`🔮 **Recovery complete** — ${results.length} session(s)`]
  if (resumed.length > 0) lines.push(`• ${resumed.length} resumed (full context): ${resumed.map(fmtName).join(', ')}`)
  if (resurrected.length > 0) lines.push(`• ${resurrected.length} resurrected (thread re-read): ${resurrected.map(fmtName).join(', ')}`)
  if (failed.length > 0) lines.push(`• ${failed.length} failed: ${failed.map(r => `${fmtName(r)} (${r.reason})`).join(', ')}`)

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}

  const succeeded = results.filter(r => r.method !== 'failed')
  for (const r of succeeded) {
    const t = targets.find(t => t.tmuxName === r.name)
    if (t) registry.removeDead(t.threadId)
  }
  registry.deleteRecoveryManifest()
}
