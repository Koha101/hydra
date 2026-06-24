import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { watchPr, unwatchPr, listWatches, getWatchesBySession } from '../pr-watch.js'
import { formatDuration } from '../util.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleWatchIntercept(msg: InboundMessage, prUrl: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '👁️').catch(() => {})

  const sessionId = registry.getByThread(msg.channelId)
    ?? (msg.existingThreadId ? registry.getByThread(msg.existingThreadId) : undefined)

  const targetSessionId = sessionId ?? 'main'
  const info = sessionId ? registry.get(sessionId) : undefined
  const threadId = info?.threadId ?? msg.channelId

  try {
    const result = await watchPr(prUrl, targetSessionId, threadId)
    await gateway.send(msg.channelId, result, { replyTo: msg.id })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `watch failed: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleUnwatchIntercept(msg: InboundMessage, prUrl: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🚫').catch(() => {})

  try {
    const result = unwatchPr(prUrl)
    await gateway.send(msg.channelId, result, { replyTo: msg.id })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `unwatch failed: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleWatchesIntercept(msg: InboundMessage): Promise<void> {
  const entries = listWatches()
  if (entries.length === 0) {
    await gateway.send(msg.channelId, 'No PRs being watched.', { replyTo: msg.id })
    return
  }

  const lines = entries.map(e => {
    const age = formatDuration(Date.now() - e.createdAt)
    const sessionInfo = registry.get(e.sessionId)
    const name = sessionInfo?.tmuxName ?? e.sessionId
    return `• [#${e.prNumber}](${e.prUrl}) → **${name}** (${age})`
  })
  await gateway.send(msg.channelId, `**Watched PRs:**\n${lines.join('\n')}`, { replyTo: msg.id })
}
