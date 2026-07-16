import { transport } from './bridge-transport.js'
import { transferWatches } from './pr-watch.js'
import { registry, threadRegistry } from './sessions.js'

const bootPendingThreads = new Set<string>()

export function transferSessionContinuity(fromSessionId: string, toSessionId: string): { watches: number; messages: number } {
  const watches = transferWatches(fromSessionId, toSessionId)
  const messages = transport.transferQueue(fromSessionId, toSessionId)
  transport.flushCodexQueue(toSessionId)
  transport.flushQueue(toSessionId)
  return { watches, messages }
}

export function completeSessionContinuity(
  threadId: string,
  fromSessionId: string,
  toSessionId: string,
): { watches: number; messages: number } {
  const result = transferSessionContinuity(fromSessionId, toSessionId)
  if (threadRegistry.get(threadId)?.pendingContinuitySessionId === fromSessionId) {
    threadRegistry.setPendingContinuity(threadId)
  }
  bootPendingThreads.delete(threadId)
  transport.release(fromSessionId)
  return result
}

export function holdPendingContinuityForBoot(threadId: string, sessionId: string): void {
  bootPendingThreads.add(threadId)
  transport.hold(sessionId)
}

export function completePendingContinuityForConnectedSession(sessionId: string): boolean {
  if (!transport.has(sessionId)) return false
  const info = registry.get(sessionId)
  if (!info || registry.getByThread(info.threadId) !== sessionId) return false
  if (!bootPendingThreads.has(info.threadId)) return false
  const pendingSessionId = threadRegistry.get(info.threadId)?.pendingContinuitySessionId
  if (!pendingSessionId) return false
  const thread = threadRegistry.get(info.threadId)
  if (thread && !thread.sessionHistory.some(entry => entry.sessionId === sessionId)) {
    threadRegistry.recordSpawn(info.threadId, {
      anchorMessageId: info.anchorMessageId,
      threadUrl: info.threadUrl,
      topic: info.topic,
      respawnCount: info.respawnCount ?? 0,
      sessionId,
      tmuxName: info.tmuxName,
      originType: info.originType ?? 'handoff',
      originFrom: info.originFrom,
      model: info.capabilities?.model,
      effort: info.capabilities?.effort,
      engine: info.engine,
      codexThreadId: info.codexThreadId,
      worktreeRepo: info.worktreeRepo,
      worktreePath: info.worktreePath,
      worktreeBranch: info.worktreeBranch,
      worktreeName: info.worktreeName,
    })
  }
  completeSessionContinuity(info.threadId, pendingSessionId, sessionId)
  return true
}
