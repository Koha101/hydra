import { execSync } from 'child_process'
import { gateway } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId, tryResume, tryRespawn } from '../session-lifecycle.js'
import { COUNT_EMOJI } from '../anchor-state.js'
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
  const thread = threadRegistry.get(info.threadId)
  const forkTopic = description || `continuing: ${thread?.topic ?? info.description ?? 'session'}`
  const threadAnchor = gateway.getThreadAnchor(msg.channelId)
  const baseChatId = threadAnchor?.channelId ?? msg.channelId

  try {
    const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
      forkFrom: { claudeSessionId: info.claudeSessionId, parentName },
    })

    const pe = sessionEmoji(parentName)
    const ce = sessionEmoji(result.name)
    await gateway.send(msg.channelId, [
      `${ce} \`${result.name}\` — forked from ${pe} \`${parentName}\``,
      forkTopic.startsWith('continuing:') ? '' : forkTopic,
      `${result.url ? result.url : ''}`,
    ].filter(Boolean).join('\n'), { replyTo: msg.id })

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
    process.stderr.write(`daemon: fork failed, falling back to spawn: ${errMsg}\n`)
    try {
      await gateway.send(msg.channelId, `⚠️ Fork failed — spawning fresh session that will read the thread for context.`, { replyTo: msg.id })
      const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
        resurrectFrom: parentName,
      })
      const e = sessionEmoji(result.name)
      await gateway.send(msg.channelId, `${e} \`${result.name}\` spawned (reading thread from **${parentName}**)${result.url ? ` — ${result.url}` : ''}`, { replyTo: msg.id })
      debouncedRefreshListDisplay()
    } catch (spawnErr) {
      const spawnErrMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
      try { await gateway.send(msg.channelId, `Fork and fallback spawn both failed: ${spawnErrMsg}`, { replyTo: msg.id }) } catch {}
    }
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
    const t = threadRegistry.get(s.threadId)
    const url = t?.threadUrl ?? ''
    const desc = s.description ?? fallbackDescription(t?.topic ?? '')
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
// Resume / Respawn
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
      const e = sessionEmoji(result.name)
      const count = thread.respawnCount
      const countLabel = count > 0 ? ` ${COUNT_EMOJI[Math.min(count - 1, COUNT_EMOJI.length - 1)]}` : ''
      try {
        const sent = await gateway.send(msg.channelId, `⏯️ ${e} \`${result.name}\` resumed${countLabel} — full context restored.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id })
        if (count > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
      } catch {}
      const mainBridge = transport.get('main')
      if (mainBridge) {
        transport.sendToBridge(mainBridge, {
          type: 'notification',
          content: `[system] ⏯️ ${e} \`${result.name}\` resumed in thread (was ${lastTmuxName})`,
          meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
        })
      }
      debouncedRefreshListDisplay()
      return
    }
    process.stderr.write(`daemon: resume tier 1 (--resume) failed for ${lastTmuxName}, trying fork-from-dead\n`)

    // Tier 2: fork from dead session (--resume --fork-session, transcript copy)
    try {
      const forkResult = await doSpawnSession(thread.topic, undefined, undefined, {
        existingThreadId: thread.threadId,
        forkFrom: { claudeSessionId, parentName: lastTmuxName },
      })
      const e = sessionEmoji(forkResult.name)
      const forkCount = thread.respawnCount
      const forkCountLabel = forkCount > 0 ? ` ${COUNT_EMOJI[Math.min(forkCount - 1, COUNT_EMOJI.length - 1)]}` : ''
      try {
        const sent = await gateway.send(msg.channelId, `⏯️ ${e} \`${forkResult.name}\` resumed${forkCountLabel} (forked from dead session — transcript preserved).\nView in any terminal: \`tmux attach -t ${forkResult.name}\``, { replyTo: msg.id })
        if (forkCount > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
      } catch {}
      const mainBridge = transport.get('main')
      if (mainBridge) {
        transport.sendToBridge(mainBridge, {
          type: 'notification',
          content: `[system] ⏯️ ${e} \`${forkResult.name}\` resumed via fork in thread (was ${lastTmuxName})`,
          meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
        })
      }
      debouncedRefreshListDisplay()
      return
    } catch {
      process.stderr.write(`daemon: resume tier 2 (fork-from-dead) failed for ${lastTmuxName}, falling back to respawn\n`)
    }
  }

  // Tier 3: respawn (fresh session reads thread history)
  const t3result = await tryRespawn(threadId, thread.topic, lastTmuxName)
  if (t3result) {
    const e = sessionEmoji(t3result.name)
    const t3count = thread.respawnCount
    const T3_EMOJI = ['2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '👨‍👩‍👦‍👦']
    const t3label = t3count > 0 ? ` ${T3_EMOJI[Math.min(t3count - 1, T3_EMOJI.length - 1)]}` : ''
    try {
      const sent = await gateway.send(msg.channelId, `🔁 ${e} \`${t3result.name}\` respawned${t3label} (resume unavailable — reading thread history).\nView in any terminal: \`tmux attach -t ${t3result.name}\``, { replyTo: msg.id })
      if (t3count > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
    } catch {}
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
    const e = sessionEmoji(result.name)
    const count = thread?.respawnCount ?? 0
    const countLabel = count > 0 ? ` ${COUNT_EMOJI[Math.min(count - 1, COUNT_EMOJI.length - 1)]}` : ''
    try {
      const sent = await gateway.send(msg.channelId, `🔁 ${e} \`${result.name}\` respawned${countLabel} — reading thread history.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id })
      if (count > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
    } catch {}
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
