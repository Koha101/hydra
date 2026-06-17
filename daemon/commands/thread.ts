import { execSync } from 'child_process'
import { gateway } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId, tryResume, tryRespawn } from '../session-lifecycle.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent, reportError } from '../util.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleThreadKillIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  await killSession(info, 'session ended')
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

  const lines = await Promise.all(forks.sort((a, b) => a.createdAt - b.createdAt).map(async s => {
    const url = await gateway.getThreadUrl(s.threadId).catch(() => '')
    const desc = s.description ?? fallbackDescription(s.topic)
    const ctx = getContextPercent(s.tmuxName)
    const msgs = s.messageCount ?? 0
    const duration = formatDuration(Date.now() - s.createdAt)
    const e = sessionEmoji(s.tmuxName)
    const title = url ? `[**${desc}**](${url})` : `**${desc}**`
    return `╰ ${e} \`${s.tmuxName}\` — ${title}\n    ◦ ${ctx} (${msgs} msgs · ${duration})`
  }))

  const pe = sessionEmoji(info.tmuxName)
  try { await gateway.send(msg.channelId, `Forks from ${pe} \`${info.tmuxName}\`\n\n${lines.join('\n')}`, { replyTo: msg.id }) } catch {}
}

export async function handleResumeIntercept(msg: InboundMessage): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'resume', 'must be used in a thread')
    return
  }

  const threadId = msg.existingThreadId ?? msg.channelId
  const staleId = registry.getByThread(threadId)
  const dead = staleId ? registry.get(staleId) : null

  if (!dead) {
    await reportError(msg.channelId, msg.id, 'resume', 'no session found in this thread', 'Use `respawn` to start a fresh session that reads this thread.')
    return
  }

  let tmuxAlive = false
  try { execSync(`tmux has-session -t '${dead.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}
  if (tmuxAlive) {
    void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})
    try { await gateway.send(msg.channelId, `Session **${dead.tmuxName}** is already running.`, { replyTo: msg.id }) } catch {}
    return
  }

  void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})

  // Three-tier cascade: resume → fork-from-dead → respawn
  if (dead.claudeSessionId) {
    // Tier 1: full resume (--resume, same conversation)
    const result = await tryResume(dead)
    if (result) {
      registry.removeDead(threadId)
      const e = sessionEmoji(result.name)
      try { await gateway.send(msg.channelId, `⏯️ ${e} \`${result.name}\` resumed — full context restored.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id }) } catch {}
      const mainBridge = transport.get('main')
      if (mainBridge) {
        transport.sendToBridge(mainBridge, {
          type: 'notification',
          content: `[system] ⏯️ ${e} \`${result.name}\` resumed in thread (was ${dead.tmuxName})`,
          meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
        })
      }
      debouncedRefreshListDisplay()
      return
    }
    process.stderr.write(`daemon: resume tier 1 (--resume) failed for ${dead.tmuxName}, trying fork-from-dead\n`)

    // Tier 2: fork from dead session (--resume --fork-session, transcript copy)
    try {
      const forkResult = await doSpawnSession(dead.topic, undefined, undefined, {
        existingThreadId: dead.threadId,
        forkFrom: { claudeSessionId: dead.claudeSessionId, parentName: dead.tmuxName },
      })
      registry.removeDead(threadId)
      const e = sessionEmoji(forkResult.name)
      try { await gateway.send(msg.channelId, `⏯️ ${e} \`${forkResult.name}\` resumed (forked from dead session — transcript preserved).\nView in any terminal: \`tmux attach -t ${forkResult.name}\``, { replyTo: msg.id }) } catch {}
      debouncedRefreshListDisplay()
      return
    } catch {
      process.stderr.write(`daemon: resume tier 2 (fork-from-dead) failed for ${dead.tmuxName}, falling back to respawn\n`)
    }
  }

  // Tier 3: respawn (fresh session reads thread history)
  const result = await tryRespawn(threadId, dead.topic, dead.tmuxName)
  if (result) {
    registry.removeDead(threadId)
    const e = sessionEmoji(result.name)
    try { await gateway.send(msg.channelId, `🔁 ${e} \`${result.name}\` respawned (resume unavailable — reading thread history).\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id }) } catch {}
    debouncedRefreshListDisplay()
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
  const staleId = registry.getByThread(threadId)
  const dead = staleId ? registry.get(staleId) : null

  if (dead) {
    let tmuxAlive = false
    try { execSync(`tmux has-session -t '${dead.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}
    if (tmuxAlive) {
      await reportError(msg.channelId, msg.id, 'respawn', `thread has a live session (**${dead.tmuxName}**)`, 'Use `kill` first, or `spawn:` for a new thread.')
      return
    }
  }

  void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})

  const resolvedTopic = topic || dead?.topic || 'respawned session'
  const resurrectFrom = dead?.tmuxName

  const result = await tryRespawn(threadId, resolvedTopic, resurrectFrom)
  if (result) {
    if (dead) registry.removeDead(threadId)
    const e = sessionEmoji(result.name)
    try { await gateway.send(msg.channelId, `🔁 ${e} \`${result.name}\` respawned — reading thread history.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id }) } catch {}
    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] 🔁 ${e} \`${result.name}\` respawned in thread${resurrectFrom ? ` (was ${resurrectFrom})` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
    debouncedRefreshListDisplay()
  } else {
    await reportError(msg.channelId, msg.id, 'respawn', 'failed to spawn session')
  }
}
