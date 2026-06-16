import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { gateway, STATE_DIR } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { doSpawnSession, killSession } from '../session-lifecycle.js'
import type { InboundMessage } from '../../gateway.js'
import type { Access } from '../access.js'

const RESTART_PENDING_FILE = join(STATE_DIR, 'restart-pending.json')

export async function handleSpawnIntercept(msg: InboundMessage, topic: string, access: Access): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🚀').catch(() => {})

  try {
    const result = await doSpawnSession(topic, msg.channelId, msg.id)

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
    '• `new session: <topic>` / `spawn: <topic>` — spawn an isolated Claude session in its own thread',
    '• `list sessions` — show all running sessions with lineage',
    '• `kill session: <name>` — terminate a named session',
    '• `health` / `status` — daemon health and diagnostics',
    '• `reconnect` — re-establish chat connection without restarting (sessions untouched)',
    '• `restart` — restart the daemon (picks up code changes, sessions reconnect)',
    '• `recover` — revive dead sessions from a crash (resume with full context, or resurrect from thread)',
    '',
    '**Thread-scoped (in a session thread only, ❌ elsewhere):**',
    '• `fork` — fork into a new thread carrying full conversation history',
    '• `fork: <description>` — directed fork with a specific focus',
    '• `forks` — list all forks from this thread',
    '• `handoff` — distill context into an artifact for review',
    '• `handoff: <direction>` — directed handoff with a specific focus',
    '• `/go` — launch the successor (predecessor stays alive until you `kill` it)',
    '• `usage` — session stats: context %, messages, runtime, fork count',
    '• `kill` — kill this session',
    '• `listen` / `pause` — toggle whether the session responds to all messages',
    '',
    '**Other:**',
    '• `commands` — this directory',
  ].join('\n')
  try { await gateway.send(msg.channelId, text, { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Recover — crash recovery via resume or resurrect
// ---------------------------------------------------------------------------

let recoveryInProgress = false
const MAX_CONCURRENT = 2
const STAGGER_MS = 5_000
const HEALTH_TIMEOUT_MS = 30_000

async function recoverOne(dead: SessionInfo): Promise<{ name: string; method: 'resumed' | 'resurrected'; newName: string } | { name: string; method: 'failed'; reason: string }> {
  const originalName = dead.tmuxName

  if (dead.claudeSessionId) {
    try {
      const result = await doSpawnSession(dead.topic, undefined, undefined, {
        existingThreadId: dead.threadId,
        resumeFrom: dead.claudeSessionId,
      })

      const ok = await waitForBridge(result.sessionId, HEALTH_TIMEOUT_MS)
      if (ok) {
        transport.sendOrQueue(result.sessionId, {
          type: 'notification',
          content: `[system] You were interrupted by a system crash and have been recovered with full conversation context. Check your thread for any messages you may have missed, and continue where you left off.`,
          meta: { chat_id: dead.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
        })
        return { name: originalName, method: 'resumed', newName: result.name }
      }

      process.stderr.write(`daemon: recover ${originalName}: resume health check failed, falling back to resurrect\n`)
      const info = [...registry.values()].find(s => s.sessionId === result.sessionId)
      if (info) await killSession(info, 'resume health check failed').catch(() => {})
    } catch (err) {
      process.stderr.write(`daemon: recover ${originalName}: resume failed: ${err}\n`)
    }
  }

  try {
    const result = await doSpawnSession(dead.topic, undefined, undefined, {
      existingThreadId: dead.threadId,
      resurrectFrom: originalName,
    })
    return { name: originalName, method: 'resurrected', newName: result.name }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { name: originalName, method: 'failed', reason }
  }
}

function waitForBridge(sessionId: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (transport.has(sessionId)) { resolve(true); return }
    const interval = setInterval(() => {
      if (transport.has(sessionId)) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve(true)
      }
    }, 1_000)
    const timer = setTimeout(() => {
      clearInterval(interval)
      resolve(false)
    }, timeoutMs)
  })
}

export async function handleRecoverIntercept(msg: InboundMessage, targetName?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔮').catch(() => {})

  if (recoveryInProgress) {
    try { await gateway.send(msg.channelId, 'Recovery already in progress.', { replyTo: msg.id }) } catch {}
    return
  }

  const manifest = registry.readRecoveryManifest()
  if (!manifest || manifest.sessions.length === 0) {
    try { await gateway.send(msg.channelId, 'No dead sessions to recover.', { replyTo: msg.id }) } catch {}
    return
  }

  let targets = manifest.sessions
  if (targetName && targetName !== 'all') {
    targets = targets.filter(s => s.tmuxName === targetName)
    if (targets.length === 0) {
      try { await gateway.send(msg.channelId, `"${targetName}" not found in recovery manifest.`, { replyTo: msg.id }) } catch {}
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

  const lines = [`🔮 **Recovery complete** — ${results.length} session(s)`]
  if (resumed.length > 0) lines.push(`• ${resumed.length} resumed (full context): ${resumed.map(r => `\`${r.name}\``).join(', ')}`)
  if (resurrected.length > 0) lines.push(`• ${resurrected.length} resurrected (thread re-read): ${resurrected.map(r => `\`${r.name}\``).join(', ')}`)
  if (failed.length > 0) lines.push(`• ${failed.length} failed: ${failed.map(r => `\`${r.name}\` (${r.reason})`).join(', ')}`)

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}

  if (targetName && targetName !== 'all') {
    const remaining = manifest.sessions.filter(s => !targets.some(t => t.sessionId === s.sessionId))
    if (remaining.length > 0) {
      const { writeFileSync: wfs } = await import('fs')
      const manifestPath = join(STATE_DIR, 'recovery-manifest.json')
      wfs(manifestPath, JSON.stringify({ ...manifest, sessions: remaining }, null, 2) + '\n', { mode: 0o600 })
    } else {
      registry.deleteRecoveryManifest()
    }
  } else {
    registry.deleteRecoveryManifest()
  }
}
