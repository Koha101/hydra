import { gateway } from '../config.js'
import { registry, threadRegistry } from '../sessions.js'
import { watchPr, unwatchPr, listWatches, formatWatchEntry, detectPrUrl, WATCH_ERRORS } from '../pr-watch.js'
import { reportError } from '../util.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleWatchIntercept(msg: InboundMessage, prUrl?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '👁️').catch(() => {})

  const thread = threadRegistry.get(msg.channelId)
    ?? (msg.existingThreadId ? threadRegistry.get(msg.existingThreadId) : undefined)
  const sessionId = thread?.currentSessionId ?? undefined

  const targetSessionId = sessionId ?? 'main'
  const info = sessionId ? registry.get(sessionId) : undefined
  const threadId = info?.threadId ?? msg.channelId

  // Auto-detect PR from session's cwd if no URL provided
  let resolvedUrl = prUrl
  if (!resolvedUrl) {
    if (!sessionId) {
      await reportError(msg.channelId, msg.id, 'watch', WATCH_ERRORS.NO_SESSION)
      return
    }
    const cwd = info?.capabilities?.cwd
    if (!cwd) {
      await reportError(msg.channelId, msg.id, 'watch', WATCH_ERRORS.NO_CWD)
      return
    }
    const detected = await detectPrUrl(cwd)
    if (!detected.ok) {
      await reportError(msg.channelId, msg.id, 'watch', detected.reason)
      return
    }
    resolvedUrl = detected.url
  }

  try {
    const result = await watchPr(resolvedUrl, targetSessionId, threadId)
    await gateway.send(msg.channelId, result, { replyTo: msg.id })
  } catch (err) {
    await reportError(msg.channelId, msg.id, 'watch', err instanceof Error ? err.message : String(err))
  }
}

export async function handleUnwatchIntercept(msg: InboundMessage, prUrl: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🙈').catch(() => {})

  const unwatchThread = threadRegistry.get(msg.channelId)
    ?? (msg.existingThreadId ? threadRegistry.get(msg.existingThreadId) : undefined)
  const sessionId = unwatchThread?.currentSessionId ?? undefined

  try {
    const result = unwatchPr(prUrl, sessionId)
    await gateway.send(msg.channelId, result, { replyTo: msg.id })
  } catch (err) {
    await reportError(msg.channelId, msg.id, 'unwatch', err instanceof Error ? err.message : String(err))
  }
}

export async function handleWatchesIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📡').catch(() => {})
  const entries = listWatches()
  if (entries.length === 0) {
    await gateway.send(msg.channelId, 'No PRs being watched.', { replyTo: msg.id })
    return
  }

  const lines = entries.map(e => `• ${formatWatchEntry(e)}`)
  await gateway.send(msg.channelId, `**Watched PRs:**\n${lines.join('\n')}`, { replyTo: msg.id })
}
