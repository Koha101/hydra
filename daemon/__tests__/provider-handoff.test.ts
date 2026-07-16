import { describe, expect, test } from 'bun:test'
import { buildProviderHandoffContext, chooseDeliverySession, clearProviderHandoffRoute, findLatestEngineConversation, isRecoveryCommand, isSessionCommand, providerHandoffRoute, reconcilePendingContinuityOnBoot, setProviderHandoffRoute } from '../provider-handoff.js'
import type { FetchedMessage } from '../../gateway.js'
import { registry, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { completePendingContinuityForConnectedSession } from '../session-continuity.js'

describe('provider handoff', () => {
  test('finds the latest native or legacy provider conversation', () => {
    const history = [
      { sessionId: 'a', tmuxName: 'a', originType: 'spawn' as const, startedAt: 1, messageCount: 0, provider: 'codex' as const, codexSessionId: 'legacy' },
      { sessionId: 'b', tmuxName: 'b', originType: 'handoff' as const, startedAt: 2, messageCount: 0, engine: 'claude' as const, claudeSessionId: 'claude' },
      { sessionId: 'c', tmuxName: 'c', originType: 'handoff' as const, startedAt: 3, messageCount: 0, engine: 'codex' as const, codexThreadId: 'native' },
    ]
    expect(findLatestEngineConversation(history, 'codex')?.codexThreadId).toBe('native')
    expect(findLatestEngineConversation(history.slice(0, 2), 'codex')?.codexSessionId).toBe('legacy')
    expect(findLatestEngineConversation(history, 'claude')?.claudeSessionId).toBe('claude')
  })

  test('excludes provider commands and keeps attachment context', () => {
    const messages: FetchedMessage[] = [
      { id: '1', authorId: 'u', authorUsername: 'user', content: 'keep this', attachmentCount: 1, createdAt: new Date('2026-07-14T12:00:00Z') },
      { id: '2', authorId: 'u', authorUsername: 'user', content: '/provider codex', attachmentCount: 0, createdAt: new Date('2026-07-14T12:01:00Z') },
    ]
    const context = buildProviderHandoffContext(messages, 'claude', 'codex')
    expect(context).toContain('keep this [1 attachment]')
    expect(context).not.toContain('/provider codex')
  })

  test('routes messages through a provider transition', () => {
    setProviderHandoffRoute('thread', 'source')
    expect(providerHandoffRoute('thread')).toBe('source')
    setProviderHandoffRoute('thread', 'target')
    expect(providerHandoffRoute('thread')).toBe('target')
    clearProviderHandoffRoute('thread')
    expect(providerHandoffRoute('thread')).toBeUndefined()
  })

  test('classifies commands that must not escape a provider transition', () => {
    expect(isSessionCommand('/clear')).toBe(true)
    expect(isSessionCommand('fork: investigate')).toBe(true)
    expect(isSessionCommand('allow')).toBe(true)
    expect(isSessionCommand('/health')).toBe(false)
    expect(isSessionCommand('/restart')).toBe(true)
    expect(isSessionCommand('/waiting 2026-07-20')).toBe(true)
    expect(isSessionCommand('waiting next Monday')).toBe(true)
    expect(isSessionCommand('continue the job')).toBe(false)
    expect(isRecoveryCommand('/resume')).toBe(true)
    expect(isRecoveryCommand('respawn: retry')).toBe(true)
    expect(isRecoveryCommand('/clear')).toBe(false)
  })

  test('re-resolves a stale source after recovery completes', () => {
    expect(chooseDeliverySession('source', undefined, undefined, 'replacement')).toBe('replacement')
    expect(chooseDeliverySession('main', undefined, undefined, 'replacement')).toBe('replacement')
    expect(chooseDeliverySession('source', 'target', 'source', 'target')).toBe('target')
    expect(chooseDeliverySession('source', undefined, 'source', 'target')).toBe('source')
  })

  test('boot waits for a provisional replacement transport before finalizing', () => {
    const threadId = 'handoff-boot-thread'
    const sourceId = 'handoff-boot-source'
    const targetId = 'handoff-boot-target'
    registry.set(targetId, {
      sessionId: targetId, threadId, topic: 'test', tmuxName: 'spark', listening: false,
      createdAt: Date.now(), lastActive: Date.now(),
    })
    registry.setThread(threadId, targetId)
    threadRegistry.set(threadId, {
      threadId, topic: 'test', respawnCount: 0, createdAt: Date.now(), lastActive: Date.now(),
      totalMessages: 0, sessionHistory: [], pendingContinuitySessionId: sourceId,
    })
    transport.sendOrQueue(sourceId, { content: 'queued during handoff' })

    reconcilePendingContinuityOnBoot()

    expect(threadRegistry.get(threadId)?.pendingContinuitySessionId).toBe(sourceId)
    expect(transport.messageQueues.get(sourceId)).toEqual([{ content: 'queued during handoff' }])
    const written: string[] = []
    transport.set(targetId, {
      sessionId: targetId, buf: '', socket: { write(data: string) { written.push(data) }, end() {} } as any,
    })
    expect(completePendingContinuityForConnectedSession(targetId)).toBe(true)
    expect(threadRegistry.get(threadId)?.pendingContinuitySessionId).toBeUndefined()
    expect(threadRegistry.get(threadId)?.sessionHistory.some(entry => entry.sessionId === targetId)).toBe(true)
    expect(transport.messageQueues.get(targetId)).toBeUndefined()
    expect(JSON.parse(written[0])).toEqual({ content: 'queued during handoff' })
    transport.delete(targetId)
    transport.messageQueues.delete(targetId)
    transport.persistQueues()
    registry.deleteThread(threadId)
    registry.delete(targetId)
    threadRegistry.delete(threadId)
  })

  test('active handoff registration does not bypass leg completion', () => {
    const threadId = 'handoff-active-thread'
    const sourceId = 'handoff-active-source'
    const targetId = 'handoff-active-target'
    registry.set(targetId, {
      sessionId: targetId, threadId, topic: 'test', tmuxName: 'spark', listening: false,
      createdAt: Date.now(), lastActive: Date.now(),
    })
    registry.setThread(threadId, targetId)
    threadRegistry.set(threadId, {
      threadId, topic: 'test', respawnCount: 0, createdAt: Date.now(), lastActive: Date.now(),
      totalMessages: 0, sessionHistory: [], pendingContinuitySessionId: sourceId,
    })
    transport.set(targetId, {
      sessionId: targetId, buf: '', socket: { write() {}, end() {} } as any,
    })

    expect(completePendingContinuityForConnectedSession(targetId)).toBe(false)
    expect(threadRegistry.get(threadId)?.pendingContinuitySessionId).toBe(sourceId)
    transport.delete(targetId)
    registry.deleteThread(threadId)
    registry.delete(targetId)
    threadRegistry.delete(threadId)
  })
})
