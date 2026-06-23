import { execSync } from 'child_process'
import { gateway } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId } from '../session-lifecycle.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent } from '../util.js'
import type { InboundMessage } from '../../gateway.js'

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
  // Find session that owned this thread (may be dead) — threadRegistry primary
  const threadId = msg.channelId
  const thread = threadRegistry.get(threadId)
    ?? (msg.existingThreadId ? threadRegistry.get(msg.existingThreadId) : undefined)
  const sessionId = thread?.currentSessionId
    ?? registry.getByThread(threadId)
    ?? (msg.existingThreadId ? registry.getByThread(msg.existingThreadId) : undefined)

  if (!sessionId) {
    await gateway.send(threadId, `No session found for this thread.`, { replyTo: msg.id })
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    await gateway.send(threadId, `Session not found.`, { replyTo: msg.id })
    return
  }

  if (!isSessionDead(info)) {
    await gateway.send(threadId, `**${info.tmuxName}** is still running. Talk to it or \`kill\` it first.`, { replyTo: msg.id })
    return
  }

  void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})

  // Kill lingering tmux
  try { execSync(`tmux kill-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  // Try resume with saved Claude session ID
  if (info.claudeSessionId) {
    try {
      const result = await doSpawnSession(info.topic, threadId, undefined, {
        forkFrom: { claudeSessionId: info.claudeSessionId, parentName: info.tmuxName },
      })

      await gateway.send(threadId, `⏯️ Resumed as **${result.name}** — full context restored.${result.url ? ` ${result.url}` : ''}`, { replyTo: msg.id })
      debouncedRefreshListDisplay()
      return
    } catch (err) {
      process.stderr.write(`daemon: resume --resume failed: ${err}, falling back to respawn\n`)
    }
  }

  // Fallback: respawn (fresh session reads thread history)
  try {
    const result = await doSpawnSession(info.topic, threadId, undefined)

    await gateway.send(threadId, `🔁 Respawned as **${result.name}** — reading thread history.${result.url ? ` ${result.url}` : ''}`, { replyTo: msg.id })
    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(threadId, `Resume failed: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleRespawnIntercept(msg: InboundMessage): Promise<void> {
  const threadId = msg.channelId
  const thread = threadRegistry.get(threadId)
    ?? (msg.existingThreadId ? threadRegistry.get(msg.existingThreadId) : undefined)
  const sessionId = thread?.currentSessionId
    ?? registry.getByThread(threadId)
    ?? (msg.existingThreadId ? registry.getByThread(msg.existingThreadId) : undefined)

  if (!sessionId) {
    await gateway.send(threadId, `No session found for this thread.`, { replyTo: msg.id })
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    await gateway.send(threadId, `Session not found.`, { replyTo: msg.id })
    return
  }

  if (!isSessionDead(info)) {
    await gateway.send(threadId, `**${info.tmuxName}** is still running. \`kill\` it first.`, { replyTo: msg.id })
    return
  }

  void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})
  try { execSync(`tmux kill-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  try {
    const result = await doSpawnSession(info.topic, threadId, undefined)
    await gateway.send(threadId, `🔁 Respawned as **${result.name}** — reading thread history.${result.url ? ` ${result.url}` : ''}`, { replyTo: msg.id })
    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(threadId, `Respawn failed: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleRecoverIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔮').catch(() => {})

  // Use threadRegistry's detachedThreads as primary source, fall back to session scan
  const detachedThreads = threadRegistry.detachedThreads()
  const deadSessions = [...registry.values()].filter(s => isSessionDead(s) && !s.isJoinMember)

  // Merge: prefer threadRegistry entries, add any dead sessions not already covered
  const coveredThreadIds = new Set(detachedThreads.map(t => t.threadId))
  const additionalDead = deadSessions.filter(s => !coveredThreadIds.has(s.threadId))
  const totalCount = detachedThreads.length + additionalDead.length

  if (totalCount === 0) {
    await gateway.send(msg.channelId, `No dead sessions found.`, { replyTo: msg.id })
    return
  }

  await gateway.send(msg.channelId, `Recovering ${totalCount} dead session${totalCount > 1 ? 's' : ''}...`, { replyTo: msg.id })

  let recovered = 0

  // Recover from threadRegistry detached threads
  for (const thread of detachedThreads) {
    try {
      const lastSession = thread.sessionHistory[thread.sessionHistory.length - 1]
      const claudeSessionId = lastSession?.claudeSessionId
      const spawnOpts = claudeSessionId
        ? { forkFrom: { claudeSessionId, parentName: lastSession.tmuxName } }
        : undefined

      await doSpawnSession(thread.topic, thread.threadId, undefined, spawnOpts)
      recovered++
      await new Promise(r => setTimeout(r, 5000))
    } catch (err) {
      process.stderr.write(`daemon: recover failed for thread ${thread.threadId}: ${err}\n`)
    }
  }

  // Recover additional dead sessions not in threadRegistry
  for (const info of additionalDead) {
    try {
      try { execSync(`tmux kill-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {}

      const spawnOpts = info.claudeSessionId
        ? { forkFrom: { claudeSessionId: info.claudeSessionId, parentName: info.tmuxName } }
        : undefined

      await doSpawnSession(info.topic, info.threadId, undefined, spawnOpts)
      recovered++
      await new Promise(r => setTimeout(r, 5000))
    } catch (err) {
      process.stderr.write(`daemon: recover failed for ${info.tmuxName}: ${err}\n`)
    }
  }

  await gateway.send(msg.channelId, `Recovered ${recovered}/${totalCount} sessions.`)
}
