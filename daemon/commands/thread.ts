import { execSync } from 'child_process'
import { gateway } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId, tryResume, tryRespawn, waitForBridge, HEALTH_TIMEOUT_MS } from '../session-lifecycle.js'
import { COUNT_EMOJI, refreshSessionVisual } from '../anchor-state.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent, tmuxHasSession, reportError } from '../util.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { transferWatches } from '../pr-watch.js'
import { buildProviderHandoffContext, findLatestProviderConversation } from '../provider-handoff.js'
import { getBySessionId, updateIdempotency } from '../idempotency.js'
import type { InboundMessage } from '../../gateway.js'
import type { SessionInfo, SessionProvider, SpawnResult } from '../sessions.js'

const providerHandoffsInProgress = new Set<string>()

function nativeConversationId(info: SessionInfo, provider: SessionProvider): string | undefined {
  return provider === 'codex' ? info.codexSessionId : info.claudeSessionId
}

function restoreSessionPresentation(source: SessionInfo, replacement: SessionInfo): void {
  replacement.listening = source.listening
  replacement.paused = source.paused
  replacement.description = source.description
  replacement.contentEmoji = source.contentEmoji
  replacement.contextLinks = source.contextLinks
  replacement.respawnCount = source.respawnCount
  registry.persist()
  refreshSessionVisual(replacement.threadId)
}

function sendHandoffNotification(result: SpawnResult, provider: SessionProvider, resumed: boolean, context: string): void {
  // A fresh Claude process receives the handoff as its startup prompt. Claude
  // --resume does not accept a prompt, so deliver it after its channel bridge
  // reconnects. Codex accepts a prompt on both exec and exec resume.
  if (provider === 'claude' && resumed) {
    transport.sendOrQueue(result.sessionId, {
      type: 'notification',
      content: context,
      meta: {
        chat_id: result.threadId,
        message_id: '',
        user: 'system',
        user_id: 'system',
        ts: new Date().toISOString(),
      },
    })
  }
}

export async function handleProviderIntercept(msg: InboundMessage, target: SessionProvider): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'provider', 'must be used in a session thread')
    return
  }

  const sourceInfo = registry.resolveThreadSessionFromMsg(msg)
  if (!sourceInfo || !tmuxHasSession(sourceInfo.tmuxName)) {
    await reportError(msg.channelId, msg.id, 'provider', 'no live session found in this thread', 'Use `resume` first, or spawn a new session.')
    return
  }

  const source = sourceInfo.provider ?? 'claude'
  if (source === target) {
    await gateway.send(msg.channelId, `Already using provider \`${target}\`.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  const occupied = isThreadOccupied(sourceInfo.threadId)
  if (occupied) {
    await reportError(msg.channelId, msg.id, 'provider', `a ${occupied} is active in this thread`, `Cancel the active ${occupied} before switching providers.`)
    return
  }

  if (providerHandoffsInProgress.has(sourceInfo.threadId)) {
    await gateway.send(msg.channelId, 'A provider handoff is already in progress.', { replyTo: msg.id }).catch(() => {})
    return
  }
  providerHandoffsInProgress.add(sourceInfo.threadId)

  try {

  void gateway.react(msg.channelId, msg.id, '🔀').catch(() => {})

  if (source === 'claude' && !sourceInfo.claudeSessionId) {
    sourceInfo.claudeSessionId = discoverClaudeSessionId(sourceInfo.tmuxName) ?? undefined
    registry.persist()
  }

  const thread = threadRegistry.get(sourceInfo.threadId)
  const priorTarget = findLatestProviderConversation(thread?.sessionHistory ?? [], target)
  const resumeFrom = target === 'codex' ? priorTarget?.codexSessionId : priorTarget?.claudeSessionId
  const messages = await gateway.fetchMessages(sourceInfo.threadId, 100).catch(() => [])
  const handoffContext = buildProviderHandoffContext(messages, source, target, priorTarget?.endedAt)
  const rollbackContext = buildProviderHandoffContext(messages, target, source)
  const topic = thread?.topic ?? sourceInfo.topic
  const sourceSessionId = sourceInfo.sessionId
  const idempotencyKey = getBySessionId(sourceSessionId)?.key
  const sourceResumeFrom = nativeConversationId(sourceInfo, source)
  const reuseWorktree = sourceInfo.worktreeRepo && sourceInfo.worktreePath ? {
    repo: sourceInfo.worktreeRepo,
    path: sourceInfo.worktreePath,
    branch: sourceInfo.worktreeBranch ?? `wt/${sourceInfo.tmuxName}`,
    name: sourceInfo.worktreeName ?? sourceInfo.tmuxName,
  } : undefined

  const targetModel = priorTarget?.model
  const targetEffort = target === 'codex' ? priorTarget?.effort : undefined
  let result: SpawnResult | undefined

  try {
    await killSession(sourceInfo, `provider handoff: ${source} → ${target}`, {
      silent: true,
      preserveWorktree: true,
      preserveWatches: true,
      emitDeath: false,
    })

    result = await doSpawnSession(topic, undefined, undefined, {
      existingThreadId: sourceInfo.threadId,
      handedOffFrom: sourceInfo.tmuxName,
      provider: target,
      model: targetModel,
      effort: targetEffort,
      promptPrefix: handoffContext,
      initiator: sourceInfo.initiator,
      ephemeral: sourceInfo.ephemeral,
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(reuseWorktree ? { reuseWorktree } : {}),
    })

    if (!await waitForBridge(result.sessionId, HEALTH_TIMEOUT_MS)) {
      throw new Error(`${target} bridge did not connect`)
    }

    const replacement = registry.get(result.sessionId)
    if (replacement) restoreSessionPresentation(sourceInfo, replacement)
    transferWatches(sourceSessionId, result.sessionId)
    if (idempotencyKey) updateIdempotency(idempotencyKey, { sessionId: result.sessionId })
    sendHandoffNotification(result, target, !!resumeFrom, handoffContext)

    const method = resumeFrom ? 'resumed its earlier conversation' : 'started a new conversation with thread history'
    await gateway.send(msg.channelId, `🔀 Provider \`${source}\` → \`${target}\` — ${method}.`, { replyTo: msg.id }).catch(() => {})
    debouncedRefreshListDisplay()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    // If the destination registered before failing its health check, retire it
    // without destroying the shared worktree, then restore the source provider.
    if (result) {
      const failedTarget = registry.get(result.sessionId)
      if (failedTarget) {
        await killSession(failedTarget, 'provider handoff failed', {
          silent: true,
          preserveWorktree: true,
          preserveWatches: true,
          emitDeath: false,
        }).catch(() => {})
      }
    }

    try {
      const restored = await doSpawnSession(topic, undefined, undefined, {
        existingThreadId: sourceInfo.threadId,
        handedOffFrom: result?.name ?? sourceInfo.tmuxName,
        provider: source,
        model: sourceInfo.capabilities?.model,
        effort: source === 'codex' ? sourceInfo.capabilities?.effort : undefined,
        promptPrefix: rollbackContext,
        initiator: sourceInfo.initiator,
        ephemeral: sourceInfo.ephemeral,
        ...(sourceResumeFrom ? { resumeFrom: sourceResumeFrom } : {}),
        ...(reuseWorktree ? { reuseWorktree } : {}),
      })
      if (!await waitForBridge(restored.sessionId, HEALTH_TIMEOUT_MS)) {
        throw new Error(`${source} bridge did not reconnect`)
      }
      const replacement = registry.get(restored.sessionId)
      if (replacement) restoreSessionPresentation(sourceInfo, replacement)
      transferWatches(sourceSessionId, restored.sessionId)
      if (idempotencyKey) updateIdempotency(idempotencyKey, { sessionId: restored.sessionId })
      sendHandoffNotification(restored, source, !!sourceResumeFrom, rollbackContext)
      await gateway.send(msg.channelId, `❌ Could not switch to \`${target}\`: ${detail}. Restored \`${source}\`.`, { replyTo: msg.id }).catch(() => {})
    } catch (restoreError) {
      const restoreDetail = restoreError instanceof Error ? restoreError.message : String(restoreError)
      if (idempotencyKey) updateIdempotency(idempotencyKey, { status: 'failed' })
      await gateway.send(msg.channelId, `❌ Could not switch to \`${target}\` (${detail}), and \`${source}\` could not be restored (${restoreDetail}). Use \`resume\` to recover.`, { replyTo: msg.id }).catch(() => {})
    }
    debouncedRefreshListDisplay()
  }
  } finally {
    providerHandoffsInProgress.delete(sourceInfo.threadId)
  }
}

export async function handleThreadKillIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSessionFromMsg(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  await killSession(info, 'session ended')
  debouncedRefreshListDisplay()
}

export async function handleForkIntercept(msg: InboundMessage, description?: string): Promise<void> {
  const info = registry.resolveThreadSessionFromMsg(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  if (info.provider === 'codex') {
    void gateway.send(msg.channelId, 'Fork is not available for Codex sessions. Use `spawn codex: <topic>` to start a separate Codex thread.', { replyTo: msg.id }).catch(() => {})
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

  if (!tmuxHasSession(info.tmuxName)) {
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
  const baseChatId = msg.parentChannelId ?? msg.channelId

  try {
    const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
      forkFrom: { claudeSessionId: info.claudeSessionId, parentName },
      model: info.capabilities?.model,
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
        model: info.capabilities?.model,
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
  const info = registry.resolveThreadSessionFromMsg(msg)
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
// Recovery announcement helper — shared by all resume tiers
// ---------------------------------------------------------------------------

async function announceRecovery(
  msg: InboundMessage,
  result: { name: string },
  thread: { respawnCount: number; threadId?: string },
  method: string,
  emoji: string,
  lastTmuxName: string,
): Promise<void> {
  const e = sessionEmoji(result.name)
  const count = thread.respawnCount
  const countLabel = count > 0 ? ` ${COUNT_EMOJI[Math.min(count - 1, COUNT_EMOJI.length - 1)]}` : ''
  try {
    const sent = await gateway.send(msg.channelId, `${emoji} ${e} \`${result.name}\` ${method}${countLabel}.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id })
    if (count > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
  } catch {}
  const mainBridge = transport.get('main')
  if (mainBridge) {
    transport.sendToBridge(mainBridge, {
      type: 'notification',
      content: `[system] ${emoji} ${e} \`${result.name}\` ${method} in thread (was ${lastTmuxName})`,
      meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
  }
  debouncedRefreshListDisplay()
}

// ---------------------------------------------------------------------------
// Resume / Respawn
// ---------------------------------------------------------------------------

export async function handleResumeIntercept(msg: InboundMessage): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'resume', 'must be used in a thread')
    return
  }

  const threadId = msg.effectiveThreadId ?? msg.channelId
  const thread = threadRegistry.get(threadId)

  if (!thread) {
    await reportError(msg.channelId, msg.id, 'resume', 'no session found in this thread', 'Use `respawn` to start a fresh session that reads this thread.')
    return
  }

  // If thread has a live session, check if it's actually running
  const liveSessionId = registry.getByThread(threadId)
  if (liveSessionId) {
    const liveInfo = registry.get(liveSessionId)
    if (liveInfo) {
      if (tmuxHasSession(liveInfo.tmuxName)) {
        void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})
        try { await gateway.send(msg.channelId, `Session **${liveInfo.tmuxName}** is already running.`, { replyTo: msg.id }) } catch {}
        return
      }
    }
  }

  // Thread is detached — find the provider conversation ID from history.
  const lastSession = thread.sessionHistory[thread.sessionHistory.length - 1]
  const claudeSessionId = lastSession?.claudeSessionId
  const codexSessionId = lastSession?.codexSessionId
  const provider = lastSession?.provider ?? 'claude'
  const lastTmuxName = lastSession?.tmuxName ?? thread.threadId.slice(0, 8)
  const deadModel = lastSession?.model ?? registry.get(lastSession?.sessionId ?? '')?.capabilities?.model
  const deadEffort = lastSession?.effort ?? registry.get(lastSession?.sessionId ?? '')?.capabilities?.effort

  void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})

  // Three-tier cascade: resume → fork-from-dead → respawn
  if (claudeSessionId || codexSessionId) {
    // Tier 1: full resume (--resume, same conversation)
    const result = await tryResume({
      topic: thread.topic,
      threadId: thread.threadId,
      claudeSessionId,
      codexSessionId,
      provider,
      threadUrl: thread.threadUrl,
      model: deadModel,
      effort: deadEffort,
    })
    if (result) {
      await announceRecovery(msg, result, thread, 'resumed — full context restored', '⏯️', lastTmuxName)
      return
    }
    process.stderr.write(`daemon: resume tier 1 (--resume) failed for ${lastTmuxName}, trying fork-from-dead\n`)

    // Tier 2 is Claude-only: Codex resume already preserves its conversation.
    if (provider === 'claude' && claudeSessionId) try {
      const forkResult = await doSpawnSession(thread.topic, undefined, undefined, {
        existingThreadId: thread.threadId,
        forkFrom: { claudeSessionId, parentName: lastTmuxName },
        model: deadModel,
      })
      await announceRecovery(msg, forkResult, thread, 'resumed (forked from dead session — transcript preserved)', '⏯️', lastTmuxName)
      return
    } catch {
      process.stderr.write(`daemon: resume tier 2 (fork-from-dead) failed for ${lastTmuxName}, falling back to respawn\n`)
    }
  }

  // Tier 3: respawn (fresh session reads thread history)
  const t3result = await tryRespawn(threadId, thread.topic, lastTmuxName, deadModel, provider, deadEffort)
  if (t3result) {
    await announceRecovery(msg, t3result, thread, 'respawned (resume unavailable — reading thread history)', '🔁', lastTmuxName)
  } else {
    await reportError(msg.channelId, msg.id, 'resume', 'all recovery methods failed')
  }
}

export async function handleRespawnIntercept(msg: InboundMessage, topic?: string): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'respawn', 'must be used in a thread')
    return
  }

  const threadId = msg.effectiveThreadId ?? msg.channelId
  const thread = threadRegistry.get(threadId)

  const respawnLiveId = registry.getByThread(threadId)
  if (respawnLiveId) {
    const liveInfo = registry.get(respawnLiveId)
    if (liveInfo) {
      if (tmuxHasSession(liveInfo.tmuxName)) {
        await reportError(msg.channelId, msg.id, 'respawn', `thread has a live session (**${liveInfo.tmuxName}**)`, 'Use `kill` first, or `spawn:` for a new thread.')
        return
      }
    }
  }

  void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})

  const lastSession = thread?.sessionHistory[thread.sessionHistory.length - 1]
  const resolvedTopic = topic || thread?.topic || 'respawned session'
  const resurrectFrom = lastSession?.tmuxName
  const deadModel = lastSession?.model ?? registry.get(lastSession?.sessionId ?? '')?.capabilities?.model
  const deadEffort = lastSession?.effort ?? registry.get(lastSession?.sessionId ?? '')?.capabilities?.effort
  const provider = lastSession?.provider ?? 'claude'

  const result = await tryRespawn(threadId, resolvedTopic, resurrectFrom, deadModel, provider, deadEffort)
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
