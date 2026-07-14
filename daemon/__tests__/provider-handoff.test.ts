import { describe, expect, test } from 'bun:test'
import { buildProviderHandoffContext, findLatestProviderConversation } from '../provider-handoff.js'
import type { FetchedMessage } from '../../gateway.js'
import type { ThreadSessionEntry } from '../sessions.js'

function message(content: string, at: number, authorUsername = 'user'): FetchedMessage {
  return {
    id: String(at),
    authorId: authorUsername,
    authorUsername,
    content,
    attachmentCount: 0,
    createdAt: new Date(at),
  }
}

describe('provider handoff context', () => {
  test('selects the latest conversation for the requested provider', () => {
    const history = [
      { sessionId: 'c1', tmuxName: 'spark', originType: 'spawn', startedAt: 1, messageCount: 0, provider: 'claude', claudeSessionId: 'claude-1' },
      { sessionId: 'x1', tmuxName: 'pixel', originType: 'handoff', startedAt: 2, messageCount: 0, provider: 'codex', codexSessionId: 'codex-1' },
      { sessionId: 'c2', tmuxName: 'nova', originType: 'handoff', startedAt: 3, messageCount: 0, provider: 'claude', claudeSessionId: 'claude-2' },
    ] satisfies ThreadSessionEntry[]

    expect(findLatestProviderConversation(history, 'claude')?.claudeSessionId).toBe('claude-2')
    expect(findLatestProviderConversation(history, 'codex')?.codexSessionId).toBe('codex-1')
  })

  test('skips failed sessions without a resumable provider conversation', () => {
    const history = [
      { sessionId: 'x1', tmuxName: 'pixel', originType: 'handoff', startedAt: 1, messageCount: 0, provider: 'codex', codexSessionId: 'codex-1' },
      { sessionId: 'x2', tmuxName: 'nova', originType: 'handoff', startedAt: 2, messageCount: 0, provider: 'codex' },
    ] satisfies ThreadSessionEntry[]

    expect(findLatestProviderConversation(history, 'codex')?.codexSessionId).toBe('codex-1')
  })

  test('includes only intervening messages and omits the switch command', () => {
    const context = buildProviderHandoffContext([
      message('old message', 1_000),
      message('new work completed', 2_000, 'claude'),
      message('/provider codex', 3_000),
    ], 'claude', 'codex', 1_500)

    expect(context).not.toContain('old message')
    expect(context).toContain('new work completed')
    expect(context).not.toContain('/provider codex')
    expect(context).toContain('claude to codex')
  })
})
