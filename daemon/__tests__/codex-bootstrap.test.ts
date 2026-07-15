import { describe, expect, test } from 'bun:test'
import { replayPendingInitialPrompt } from '../codex-bootstrap.js'
import type { SessionInfo } from '../sessions.js'

function provisional(codexThreadId?: string): SessionInfo {
  return {
    sessionId: 'session', threadId: 'thread', topic: 'test', tmuxName: 'spark', listening: false,
    createdAt: Date.now(), lastActive: Date.now(), engine: 'codex', codexThreadId,
    pendingInitialPrompt: 'handoff context',
  }
}

describe('Codex provisional handoff recovery', () => {
  test('replays the prompt after a fresh reconnect', async () => {
    const info = provisional()
    const calls: string[] = []
    expect(await replayPendingInitialPrompt(info, async (_id, prompt) => { calls.push(prompt) })).toBe(true)
    expect(calls).toEqual(['handoff context'])
    expect(info.pendingInitialPrompt).toBeUndefined()
  })

  test('replays the prompt after resuming its persisted thread', async () => {
    const info = provisional('codex-thread')
    const calls: string[] = []
    expect(await replayPendingInitialPrompt(info, async (_id, prompt) => { calls.push(prompt) })).toBe(true)
    expect(calls).toEqual(['handoff context'])
    expect(info.codexThreadId).toBe('codex-thread')
  })

  test('keeps the prompt when replay fails', async () => {
    const info = provisional()
    let disconnected = false
    expect(await replayPendingInitialPrompt(
      info,
      async () => { throw new Error('failed') },
      () => { disconnected = true },
    )).toBe(false)
    expect(info.pendingInitialPrompt).toBe('handoff context')
    expect(disconnected).toBe(true)
  })
})
