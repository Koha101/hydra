import { execSync } from 'child_process'
import { gateway } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId, tryResume, tryRespawn } from '../session-lifecycle.js'
import { COUNT_EMOJI, setAnchorState } from '../anchor-state.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent, reportError } from '../util.js'
import type { InboundMessage } from '../../gateway.js'
import type { SpawnResult, ThreadInfo } from '../sessions.js'

async function reportRecoverySuccess(
  msg: InboundMessage,
  result: SpawnResult,
  respawnCount: number,
  method: string,
  emoji: string,
  detail: string,
  previousName?: string,
): Promise<void> {
  const e = sessionEmoji(result.name)
  const countLabel = respawnCount > 0 ? ` ${COUNT_EMOJI[Math.min(respawnCount - 1, COUNT_EMOJI.length - 1)]}` : ''
  try {
    const sent = await gateway.send(msg.channelId, `${emoji} ${e} \`${result.name}\` ${method}${countLabel} — ${detail}\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id })
    if (respawnCount > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
  } catch {}
  const mainBridge = transport.get('main')
  if (mainBridge) {
    transport.sendToBridge(mainBridge, {
      type: 'notification',
      content: `[system] ${emoji} ${e} \`${result.name}\` ${method} in thread${previousName ? ` (was ${previousName})` : ''}`,
      meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
  }
  debouncedRefreshListDisplay()
}

export async function handleThreadKillIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  await killSession(info, 'session ended')
  debouncedRefreshListDisplay()
}

export async function handleForkIntercept(msg: InboundMessage, description?: string): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  if (!info.claudeSessionId) {
    const discovered = discoverClaudeSessionId(info.tmuxName)
    if (discovered) {
      info.claudeSessionId = discovered
      registry.persist()
    } else {
      void gateway.send(msg.channelId, 'Fork unavailable — could not resolve Claude session ID.', { replyTo: msg.id }).catch(() => {})
      return
    }
  }

  try {
    execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
  } catch {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `Cannot fork — **${info.tmuxName}** is no longer running.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🍴').catch(() => {})

  const parentName = info.tmuxName
  const parentMessages = info.messageCount ?? 0
  const parentContext = getContextPercent(parentName)
  const forkTopic = description || `continuing: ${info.topic}`
  const threadAnchor = gateway.getThreadAnchor(msg.channelId)
  const baseChatId = threadAnchor?.channelId ?? msg.channelId

  // Stale session guard: Claude can't fork from sessions older than ~24h
  const sessionAge = Date.now() - info.createdAt
  const MAX_FORK_AGE_MS = 24 * 60 * 60 * 1000
  if (sessionAge > MAX_FORK_AGE_MS) {
    const hours = Math.round(sessionAge / (60 * 60 * 1000))
    try {
      await gateway.send(msg.channelId, `⚠️ **${info.tmuxName}** is ${hours}h old — too stale to fork. Spawning a fresh session instead.`, { replyTo: msg.id })
    } catch {}
    // Fall back to regular spawn with the fork topic
    try {
      const result = await doSpawnSession(forkTopic, baseChatId, undefined)
      const e = sessionEmoji(result.name)
      await gateway.send(msg.channelId, `${e} \`${result.name}\` spawned (fresh — fork unavailable for stale sessions)${result.url ? ` — ${result.url}` : ''}`, { replyTo: msg.id })
      debouncedRefreshListDisplay()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      try { await gateway.send(msg.channelId, `Spawn failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
    }
    return
  }

  try {
    const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
      forkFrom: { claudeSessionId: info.claudeSessionId, parentName },
    })

    const pe = sessionEmoji(parentName)
    const ce = sessionEmoji(result.name)
    await gateway.send(msg.channelId, [
      `🍴 ${pe} \`${parentName}\` forked → ${ce} \`${result.name}\` — ${result.url}`,
      `    ◦ ${parentContext} (${parentMessages} msgs)`,
    ].join('\n'), { replyTo: msg.id })

    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] ${pe} \`${parentName}\` forked → ${ce} \`${result.name}\`: ${forkTopic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }

    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: fork intercept failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Fork failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}

export async function handleForksIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🍽️').catch(() => {})
  const forks = [...registry.values()].filter(s => s.originType === 'fork' && s.originFrom === info.tmuxName)
  if (forks.length === 0) {
    try { await gateway.send(msg.channelId, `No forks from ${sessionEmoji(info.tmuxName)} \`${info.tmuxName}\`.`, { replyTo: msg.id }) } catch {}
    return
  }

  const lines = forks.sort((a, b) => a.createdAt - b.createdAt).map(s => {
    const url = s.threadUrl ?? ''
    const desc = s.description ?? fallbackDescription(s.topic)
    const ctx = getContextPercent(s.tmuxName)
    const msgs = s.messageCount ?? 0
    const duration = formatDuration(Date.now() - s.createdAt)
    const e = sessionEmoji(s.tmuxName)
    const title = url ? `[**${desc}**](${url})` : `**${desc}**`
    return `╰ ${e} \`${s.tmuxName}\` — ${title}\n    ◦ ${ctx} (${msgs} msgs · ${duration})`
  })

  const pe = sessionEmoji(info.tmuxName)
  try { await gateway.send(msg.channelId, `Forks from ${pe} \`${info.tmuxName}\`\n\n${lines.join('\n')}`, { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Resume / Recover
// ---------------------------------------------------------------------------

export function isSessionDead(info: { tmuxName: string; sessionId: string }): boolean {
  try {
    execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
    return !transport.has(info.sessionId)  // tmux alive but bridge gone = Claude crashed inside
  } catch {
    return true  // tmux gone = fully dead
  }
}

export async function handleResumeIntercept(msg: InboundMessage): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'resume', 'must be used in a thread')
    return
  }

  const threadId = msg.existingThreadId ?? msg.channelId
  const thread = threadRegistry.get(threadId)

  if (!thread) {
    await reportError(msg.channelId, msg.id, 'resume', 'no session found in this thread', 'Use `respawn` to start a fresh session that reads this thread.')
    return
  }

  // If thread has a live session, check if it's actually running
  if (thread.currentSessionId) {
    const liveInfo = registry.get(thread.currentSessionId)
    if (liveInfo) {
      let tmuxAlive = false
      try { execSync(`tmux has-session -t '${liveInfo.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}
      if (tmuxAlive) {
        void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})
        try { await gateway.send(msg.channelId, `Session **${liveInfo.tmuxName}** is already running.`, { replyTo: msg.id }) } catch {}
        return
      }
    }
  }

  // Thread is detached — find claudeSessionId from last session in history
  const lastSession = thread.sessionHistory[thread.sessionHistory.length - 1]
  const claudeSessionId = lastSession?.claudeSessionId
  const lastTmuxName = lastSession?.tmuxName ?? thread.threadId.slice(0, 8)

  void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})

  // Three-tier cascade: resume → fork-from-dead → respawn
  if (claudeSessionId) {
    // Tier 1: full resume (--resume, same conversation)
    const result = await tryResume({
      topic: thread.topic,
      threadId: thread.threadId,
      claudeSessionId,
      threadUrl: thread.threadUrl,
    })
    if (result) {
      await reportRecoverySuccess(msg, result, thread.respawnCount, 'resumed', '⏯️', 'full context restored.', lastTmuxName)
      return
    }
    process.stderr.write(`daemon: resume tier 1 (--resume) failed for ${lastTmuxName}, trying fork-from-dead\n`)

    // Tier 2: fork from dead session (--resume --fork-session, transcript copy)
    try {
      const forkResult = await doSpawnSession(thread.topic, undefined, undefined, {
        existingThreadId: thread.threadId,
        forkFrom: { claudeSessionId, parentName: lastTmuxName },
      })
      await reportRecoverySuccess(msg, forkResult, thread.respawnCount, 'resumed', '⏯️', 'forked from dead session — transcript preserved.', lastTmuxName)
      return
    } catch {
      process.stderr.write(`daemon: resume tier 2 (fork-from-dead) failed for ${lastTmuxName}, falling back to respawn\n`)
    }
  }

  // Tier 3: respawn (fresh session reads thread history)
  const t3result = await tryRespawn(threadId, thread.topic, lastTmuxName)
  if (t3result) {
    await reportRecoverySuccess(msg, t3result, thread.respawnCount, 'respawned', '🔁', 'resume unavailable — reading thread history.', lastTmuxName)
  } else {
    await reportError(msg.channelId, msg.id, 'resume', 'all recovery methods failed')
  }
}

export async function handleRespawnIntercept(msg: InboundMessage, topic?: string): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'respawn', 'must be used in a thread')
    return
  }

  const threadId = msg.existingThreadId ?? msg.channelId
  const thread = threadRegistry.get(threadId)

  if (thread?.currentSessionId) {
    const liveInfo = registry.get(thread.currentSessionId)
    if (liveInfo) {
      let tmuxAlive = false
      try { execSync(`tmux has-session -t '${liveInfo.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}
      if (tmuxAlive) {
        await reportError(msg.channelId, msg.id, 'respawn', `thread has a live session (**${liveInfo.tmuxName}**)`, 'Use `kill` first, or `spawn:` for a new thread.')
        return
      }
    }
  }

  void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})

  const lastSession = thread?.sessionHistory[thread.sessionHistory.length - 1]
  const resolvedTopic = topic || thread?.topic || 'respawned session'
  const resurrectFrom = lastSession?.tmuxName

  const result = await tryRespawn(threadId, resolvedTopic, resurrectFrom)
  if (result) {
    await reportRecoverySuccess(msg, result, thread?.respawnCount ?? 0, 'respawned', '🔁', 'reading thread history.', resurrectFrom)
  } else {
    await reportError(msg.channelId, msg.id, 'respawn', 'failed to spawn session')
  }
}

export async function handleRecoverIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔮').catch(() => {})

  const crashed = threadRegistry.detachedThreads()
  if (crashed.length === 0) {
    try { await gateway.send(msg.channelId, `No crashed sessions to recover.`, { replyTo: msg.id }) } catch {}
    return
  }

  try { await gateway.send(msg.channelId, `🔮 Recovering ${crashed.length} crashed session(s)...`, { replyTo: msg.id }) } catch {}

  let recovered = 0
  let failed = 0
  for (const thread of crashed) {
    const lastSession = thread.sessionHistory[thread.sessionHistory.length - 1]
    const result = await tryRespawn(thread.threadId, thread.topic, lastSession?.tmuxName)
    if (result) {
      recovered++
    } else {
      failed++
    }
    // Stagger to avoid overwhelming
    await new Promise(r => setTimeout(r, 5000))
  }

  try { await gateway.send(msg.channelId, `🔮 Recovery complete: ${recovered} recovered, ${failed} failed.`, { replyTo: msg.id }) } catch {}
}
