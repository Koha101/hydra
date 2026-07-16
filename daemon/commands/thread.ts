import { execSync } from 'child_process'
import { gateway } from '../config.js'
import { conversationId, recoverableWorktreeRef, registry, sessionEmoji, sessionEngine, threadRegistry, worktreeRef } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { assertHealthySpawn, killSession, doSpawnSession, discoverClaudeSessionId, tryResume, tryRespawn } from '../session-lifecycle.js'
import { completeSessionContinuity, transferSessionContinuity } from '../session-continuity.js'
import { COUNT_EMOJI, refreshSessionVisual } from '../anchor-state.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent, tmuxHasSession, reportError } from '../util.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { buildProviderHandoffContext, clearProviderHandoffRoute, findLatestEngineConversation, setProviderHandoffRoute } from '../provider-handoff.js'
import { getBySessionId, updateIdempotency } from '../idempotency.js'
import { codexEngine } from '../codex-bootstrap.js'
import type { InboundMessage } from '../../gateway.js'
import type { SessionEngine, SessionInfo, SpawnResult } from '../sessions.js'

const providerHandoffsInProgress = new Set<string>()

function restoreSessionPresentation(source: SessionInfo, replacement: SessionInfo): void {
  replacement.listening = source.listening
  replacement.paused = source.paused
  replacement.waiting = source.waiting
  replacement.waitingDate = source.waitingDate
  replacement.description = source.description
  replacement.contentEmoji = source.contentEmoji
  replacement.contextLinks = source.contextLinks
  replacement.respawnCount = source.respawnCount
  registry.persist()
  refreshSessionVisual(replacement.threadId)
}

function claudeTurnActive(tmuxName: string): boolean {
  try {
    const pane = execSync(`tmux capture-pane -p -t '${tmuxName}' -S -10`, { encoding: 'utf8' })
    return pane.split('\n').filter(line => line.trim()).slice(-4).some(line => /esc to interrupt/i.test(line))
  } catch {
    return false
  }
}

function legacyCodexTurnActive(tmuxName: string): boolean {
  try {
    const roots = execSync(`tmux list-panes -t '${tmuxName}' -F '#{pane_pid}'`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    const seen = new Set(roots)
    let frontier = roots
    for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const pid of frontier) {
        let children = ''
        try { children = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' }).trim() } catch {}
        for (const child of children.split('\n').filter(Boolean)) {
          if (!seen.has(child)) { seen.add(child); next.push(child) }
        }
      }
      frontier = next
    }
    for (const pid of seen) {
      const command = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' })
      if (/\bcodex\b.*\bexec\b/.test(command)) return true
    }
  } catch {}
  return false
}

function remainingPhaseBudget(source: SessionInfo): number | undefined {
  return source.budgetDeadline ? Math.max(1, source.budgetDeadline - Date.now()) : undefined
}

type HandoffLeg = {
  sourceInfo: SessionInfo
  target: SessionEngine
  topic: string
  context: string
  handedOffFrom: string
  resumeFrom?: string
  model?: string
  effort?: string
  idempotencyKey?: string
}

async function spawnHandoffLeg(opts: HandoffLeg): Promise<{ result: SpawnResult; resumed: boolean }> {
  const reuseWorktree = worktreeRef(opts.sourceInfo)
  const attempts = opts.resumeFrom ? [opts.resumeFrom, undefined] : [undefined]
  let lastError: unknown

  for (const resumeFrom of attempts) {
    let result: SpawnResult | undefined
    let continuity = { watches: 0, messages: 0 }
    try {
      result = await doSpawnSession(opts.topic, undefined, undefined, {
        existingThreadId: opts.sourceInfo.threadId,
        handedOffFrom: opts.handedOffFrom,
        engine: opts.target,
        model: opts.model,
        effort: opts.effort,
        promptPrefix: opts.context,
        initiator: opts.sourceInfo.initiator,
        ephemeral: opts.sourceInfo.ephemeral,
        phaseBudgetMs: remainingPhaseBudget(opts.sourceInfo),
        ...(resumeFrom ? { resumeFrom } : {}),
        ...(reuseWorktree ? { reuseWorktree } : {}),
      })
      await assertHealthySpawn(result, opts.target, { preserveWorktree: true })
      const replacement = registry.get(result.sessionId)
      if (replacement) restoreSessionPresentation(opts.sourceInfo, replacement)
      setProviderHandoffRoute(opts.sourceInfo.threadId, result.sessionId)
      if (opts.idempotencyKey) updateIdempotency(opts.idempotencyKey, { sessionId: result.sessionId })
      continuity = completeSessionContinuity(opts.sourceInfo.threadId, opts.sourceInfo.sessionId, result.sessionId)
      return { result, resumed: !!resumeFrom }
    } catch (error) {
      lastError = error
      if (result && (continuity.watches > 0 || continuity.messages > 0)) {
        transferSessionContinuity(result.sessionId, opts.sourceInfo.sessionId)
      }
      setProviderHandoffRoute(opts.sourceInfo.threadId, opts.sourceInfo.sessionId)
      if (result) {
        const failed = registry.get(result.sessionId)
        if (failed) {
          await killSession(failed, 'provider handoff failed', {
            silent: true,
            preserveWorktree: true,
            preserveWatches: true,
            emitDeath: false,
          }).catch(() => {})
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function handleProviderIntercept(msg: InboundMessage, target: SessionEngine): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'provider', 'must be used in a session thread')
    return
  }

  const sourceInfo = registry.resolveThreadSessionFromMsg(msg)
  if (!sourceInfo || !tmuxHasSession(sourceInfo.tmuxName)) {
    await reportError(msg.channelId, msg.id, 'provider', 'no live session found in this thread', 'Use `resume` first, or spawn a new session.')
    return
  }

  const source = sessionEngine(sourceInfo)
  if (source === target) {
    await gateway.send(msg.channelId, `Already using provider \`${target}\`.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  const sourceBusy = sourceInfo.engine === 'codex'
    ? codexEngine.isBusy(sourceInfo.sessionId)
    : sourceInfo.provider === 'codex'
      ? legacyCodexTurnActive(sourceInfo.tmuxName)
      : source === 'claude' && claudeTurnActive(sourceInfo.tmuxName)
  if (sourceBusy) {
    await reportError(msg.channelId, msg.id, 'provider', `${source} is processing a turn`, 'Wait for it to finish or interrupt it before switching providers.')
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

    const sourceResumeFrom = conversationId(sourceInfo, source)
    if (!sourceResumeFrom) {
      await reportError(msg.channelId, msg.id, 'provider', `could not resolve the active ${source} conversation ID`, 'The current provider was left running.')
      return
    }

    const thread = threadRegistry.get(sourceInfo.threadId)
    const sourceSessionId = sourceInfo.sessionId
    threadRegistry.setPendingContinuity(sourceInfo.threadId, sourceSessionId)
    transport.hold(sourceSessionId)
    setProviderHandoffRoute(sourceInfo.threadId, sourceSessionId)
    const priorTarget = findLatestEngineConversation(thread?.sessionHistory ?? [], target)
    const resumeFrom = priorTarget ? conversationId(priorTarget, target) : undefined
    const messages = await gateway.fetchMessages(sourceInfo.threadId, 100).catch(() => [])
    const handoffContext = buildProviderHandoffContext(messages, source, target, priorTarget?.endedAt)
    const rollbackContext = buildProviderHandoffContext(messages, target, source)
    const topic = thread?.topic ?? sourceInfo.topic
    const idempotencyKey = getBySessionId(sourceSessionId)?.key
    const targetModel = priorTarget?.model
    const targetEffort = target === 'codex' ? priorTarget?.effort : undefined
    try {
      await killSession(sourceInfo, `provider handoff: ${source} → ${target}`, {
        silent: true,
        preserveWorktree: true,
        preserveWatches: true,
        emitDeath: false,
      })

      const { result, resumed } = await spawnHandoffLeg({
        sourceInfo,
        target,
        topic,
        context: handoffContext,
        handedOffFrom: sourceInfo.tmuxName,
        resumeFrom,
        model: targetModel,
        effort: targetEffort,
        idempotencyKey,
      })
      const method = resumed ? 'resumed its earlier conversation' : 'started a new conversation with thread history'
      await gateway.send(msg.channelId, `🔀 Provider \`${source}\` → \`${target}\` — ${method}.`, { replyTo: msg.id }).catch(() => {})
      debouncedRefreshListDisplay()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)

      try {
        await spawnHandoffLeg({
          sourceInfo,
          target: source,
          topic,
          context: rollbackContext,
          handedOffFrom: sourceInfo.tmuxName,
          resumeFrom: sourceResumeFrom,
          model: sourceInfo.capabilities?.model,
          effort: source === 'codex' ? sourceInfo.capabilities?.effort : undefined,
          idempotencyKey,
        })
        await gateway.send(msg.channelId, `❌ Could not switch to \`${target}\`: ${detail}. Restored \`${source}\`.`, { replyTo: msg.id }).catch(() => {})
      } catch (restoreError) {
        const restoreDetail = restoreError instanceof Error ? restoreError.message : String(restoreError)
        if (idempotencyKey) updateIdempotency(idempotencyKey, { status: 'failed' })
        await gateway.send(msg.channelId, `❌ Could not switch to \`${target}\` (${detail}), and \`${source}\` could not be restored (${restoreDetail}). Use \`resume\` to recover.`, { replyTo: msg.id }).catch(() => {})
      }
      debouncedRefreshListDisplay()
    }
  } finally {
    clearProviderHandoffRoute(sourceInfo.threadId)
    transport.release(sourceInfo.sessionId)
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

  const engine = sessionEngine(info)
  if (engine === 'claude' && !info.claudeSessionId) {
    const discovered = discoverClaudeSessionId(info.tmuxName)
    if (discovered) {
      info.claudeSessionId = discovered
      registry.persist()
    } else {
      void gateway.send(msg.channelId, 'Fork unavailable — could not resolve Claude session ID.', { replyTo: msg.id }).catch(() => {})
      return
    }
  } else if (engine === 'codex' && !conversationId(info, engine)) {
    void gateway.send(msg.channelId, 'Fork unavailable — could not resolve Codex thread ID.', { replyTo: msg.id }).catch(() => {})
    return
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
  const parentWorktree = worktreeRef(info)
  if (parentWorktree) {
    const status = Bun.spawnSync(['git', '-C', parentWorktree.path, 'status', '--porcelain'], { stderr: 'ignore' })
    if (status.exitCode !== 0 || status.stdout.toString().trim()) {
      await gateway.send(msg.channelId, 'Fork unavailable while this worktree has uncommitted changes; commit or stash them first.', { replyTo: msg.id }).catch(() => {})
      return
    }
  }

  try {
    const forkFrom = engine === 'codex'
      ? { codexThreadId: conversationId(info, engine)!, parentName }
      : { claudeSessionId: info.claudeSessionId!, parentName }
    const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
      forkFrom,
      model: info.capabilities?.model,
      effort: engine === 'codex' ? info.capabilities?.effort : undefined,
      engine,
      ...(parentWorktree ? { forkWorktreeFrom: parentWorktree } : {}),
    })
    await assertHealthySpawn(result, engine)

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
        effort: engine === 'codex' ? info.capabilities?.effort : undefined,
        engine,
        ...(parentWorktree ? { forkWorktreeFrom: parentWorktree } : {}),
      })
      await assertHealthySpawn(result, engine)
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
      if (!liveInfo.deadAt && tmuxHasSession(liveInfo.tmuxName)) {
        if (thread.pendingContinuitySessionId) {
          const pendingSessionId = thread.pendingContinuitySessionId
          if (liveSessionId === pendingSessionId || transport.has(liveSessionId)) {
            completeSessionContinuity(threadId, pendingSessionId, liveSessionId)
            void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})
            try { await gateway.send(msg.channelId, `Recovered live session **${liveInfo.tmuxName}** and restored queued messages.`, { replyTo: msg.id }) } catch {}
            return
          }
          try {
            await killSession(liveInfo, 'interrupted provider handoff recovery', {
              silent: true,
              preserveWorktree: true,
              preserveWatches: true,
              emitDeath: false,
            })
          } catch (error) {
            await reportError(msg.channelId, msg.id, 'resume', `could not stop the incomplete handoff session: ${error instanceof Error ? error.message : error}`)
            return
          }
        } else {
          void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})
          try { await gateway.send(msg.channelId, `Session **${liveInfo.tmuxName}** is already running.`, { replyTo: msg.id }) } catch {}
          return
        }
      }
    }
  }

  // Thread is detached — recover the last provider's native conversation.
  const lastSession = thread.sessionHistory[thread.sessionHistory.length - 1]
  const continuitySessionId = thread.pendingContinuitySessionId ?? lastSession?.sessionId
  const deadInfo = registry.get(lastSession?.sessionId ?? '')
  const claudeSessionId = lastSession?.claudeSessionId ?? deadInfo?.claudeSessionId
  const codexThreadId = lastSession?.codexThreadId ?? lastSession?.codexSessionId ?? deadInfo?.codexThreadId ?? deadInfo?.codexSessionId
  const engine = lastSession ? sessionEngine(lastSession) : deadInfo ? sessionEngine(deadInfo) : 'claude'
  const lastTmuxName = lastSession?.tmuxName ?? thread.threadId.slice(0, 8)
  const deadModel = lastSession?.model ?? deadInfo?.capabilities?.model
  const deadEffort = lastSession?.effort ?? deadInfo?.capabilities?.effort
  const reuseWorktree = (lastSession ? recoverableWorktreeRef(lastSession) : undefined)
    ?? (deadInfo ? recoverableWorktreeRef(deadInfo) : undefined)

  void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})

  // Three-tier cascade: resume → fork-from-dead → respawn
  if (claudeSessionId || codexThreadId) {
    // Tier 1: full resume (--resume, same conversation)
    const result = await tryResume({
      sessionId: continuitySessionId,
      topic: thread.topic,
      threadId: thread.threadId,
      claudeSessionId,
      codexThreadId,
      engine,
      threadUrl: thread.threadUrl,
      model: deadModel,
      effort: deadEffort,
      reuseWorktree,
    })
    if (result) {
      await announceRecovery(msg, result, thread, 'resumed — full context restored', '⏯️', lastTmuxName)
      return
    }
    process.stderr.write(`daemon: resume tier 1 (--resume) failed for ${lastTmuxName}, trying fork-from-dead\n`)

    // Tier 2: fork from the dead provider conversation.
    try {
      const forkFrom = engine === 'codex'
        ? { codexThreadId: codexThreadId!, parentName: lastTmuxName }
        : { claudeSessionId: claudeSessionId!, parentName: lastTmuxName }
      const forkResult = await doSpawnSession(thread.topic, undefined, undefined, {
        existingThreadId: thread.threadId,
        forkFrom,
        model: deadModel,
        effort: deadEffort,
        engine,
        reuseWorktree,
        replacesSessionId: continuitySessionId,
      })
      await assertHealthySpawn(forkResult, engine, {
        preserveWorktree: !!reuseWorktree,
        previousSessionId: continuitySessionId,
      })
      if (continuitySessionId) completeSessionContinuity(thread.threadId, continuitySessionId, forkResult.sessionId)
      await announceRecovery(msg, forkResult, thread, 'resumed (forked from dead session — transcript preserved)', '⏯️', lastTmuxName)
      return
    } catch {
      process.stderr.write(`daemon: resume tier 2 (fork-from-dead) failed for ${lastTmuxName}, falling back to respawn\n`)
    }
  }

  // Tier 3: respawn (fresh session reads thread history)
  const t3result = await tryRespawn({
    threadId, topic: thread.topic, resurrectFrom: lastTmuxName, model: deadModel, engine, effort: deadEffort,
    reuseWorktree, replacesSessionId: continuitySessionId,
  })
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
      if (!liveInfo.deadAt && tmuxHasSession(liveInfo.tmuxName)) {
        await reportError(msg.channelId, msg.id, 'respawn', `thread has a live session (**${liveInfo.tmuxName}**)`, 'Use `kill` first, or `spawn:` for a new thread.')
        return
      }
    }
  }

  void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})

  const lastSession = thread?.sessionHistory[thread.sessionHistory.length - 1]
  const continuitySessionId = thread?.pendingContinuitySessionId ?? lastSession?.sessionId
  const resolvedTopic = topic || thread?.topic || 'respawned session'
  const resurrectFrom = lastSession?.tmuxName
  const deadInfo = registry.get(lastSession?.sessionId ?? '')
  const deadModel = lastSession?.model ?? deadInfo?.capabilities?.model
  const engine = lastSession ? sessionEngine(lastSession) : 'claude'
  const deadEffort = lastSession?.effort ?? deadInfo?.capabilities?.effort
  const reuseWorktree = (lastSession ? recoverableWorktreeRef(lastSession) : undefined)
    ?? (deadInfo ? recoverableWorktreeRef(deadInfo) : undefined)

  const result = await tryRespawn({
    threadId, topic: resolvedTopic, resurrectFrom, model: deadModel, engine, effort: deadEffort,
    reuseWorktree, replacesSessionId: continuitySessionId,
  })
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
