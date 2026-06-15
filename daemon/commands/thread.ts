import { execSync } from 'child_process'
import { gateway } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId } from '../session-lifecycle.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent } from '../util.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleThreadKillIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  await killSession(info, 'session ended')
  debouncedRefreshListDisplay()
}

export async function handleForkIntercept(msg: InboundMessage, description?: string): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId)
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
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId)
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

// ---------------------------------------------------------------------------
// Resurrect — crash recovery for dead session threads
// ---------------------------------------------------------------------------

const resurrectsInProgress = new Set<string>()

export async function handleResurrectIntercept(msg: InboundMessage): Promise<void> {
  // Resurrect works in threads where a session previously lived but has died.
  // It spawns a fresh session and instructs it to read the thread history to
  // reconstruct context — unlike fork, which carries the transcript via --resume.

  const threadId = msg.existingThreadId ?? msg.channelId
  if (resurrectsInProgress.has(threadId)) {
    void gateway.send(msg.channelId, 'Resurrection already in progress for this thread.', { replyTo: msg.id }).catch(() => {})
    return
  }

  // Check if there's a live session for this thread
  const liveSession = registry.resolveThreadSession(msg.channelId, msg.existingThreadId)
  if (liveSession) {
    try {
      execSync(`tmux has-session -t '${liveSession.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
      // Session is genuinely alive
      void gateway.send(msg.channelId, 'Session is still alive — use `kill` first if you want to restart.', { replyTo: msg.id }).catch(() => {})
      return
    } catch {
      // tmux session is gone — clean up stale tracking and proceed with resurrect.
      // killSession handles bridge/thread/session cleanup and respects killsInProgress.
      // The tmux kill-session inside will fail silently since the session is already dead.
      await killSession(liveSession, 'stale — resurrecting')
    }
  }

  // In a thread: check if this thread EVER had a session (even if cleaned up)
  // We can detect this by checking if the thread has a session-like anchor pattern
  if (!msg.isThread) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, 'Resurrect must be used in a thread where a session previously lived.', { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🫀').catch(() => {})

  // Resurrect reattaches INTO the existing thread — no new thread, no cross-link
  const existingThreadId = msg.existingThreadId ?? msg.channelId
  const previousName = liveSession?.tmuxName

  resurrectsInProgress.add(threadId)
  try {
    const topic = 'resurrected session — reading thread history'
    const result = await doSpawnSession(topic, undefined, undefined, { existingThreadId, resurrectFrom: previousName })

    const ce = sessionEmoji(result.name)
    await gateway.send(existingThreadId, [
      `🫀 ${ce} \`${result.name}\` resurrected in this thread`,
      `View in any terminal: \`tmux attach -t ${result.name}\``,
    ].join('\n'), { replyTo: msg.id })

    // Notify main session
    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] 🫀 Resurrected session → ${ce} \`${result.name}\`${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: resurrect intercept failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Resurrect failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  } finally {
    resurrectsInProgress.delete(threadId)
  }
}
