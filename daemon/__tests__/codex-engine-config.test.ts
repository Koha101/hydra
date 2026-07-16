import { describe, expect, test } from 'bun:test'
import { CodexEngine } from '../codex-engine.js'

function fakeConnection() {
  return {
    sessionId: 'session', ws: { send() {} }, threadId: 'thread-1', currentTurnId: null,
    turnPending: false, turnWatchdog: null, nextRequestId: 0, pendingRequests: new Map(),
    messageBuffer: [], steerQueue: [], lastUsageWarning: 0,
    defaultModel: 'gpt-default', defaultEffort: 'medium', model: 'gpt-default', effort: 'medium',
    developerInstructions: undefined as string | undefined,
  }
}

describe('Codex runtime configuration', () => {
  test('applies model and effort to the next turn', async () => {
    const engine = new CodexEngine() as any
    const connection = fakeConnection()
    engine.connections.set('session', connection)
    let request: { method: string; params: Record<string, unknown> } | undefined
    engine.request = async (_connection: unknown, method: string, params: Record<string, unknown>) => {
      request = { method, params }
      return { turn: { id: 'turn' } }
    }
    engine.configure('session', { model: 'gpt-next', effort: 'ultra' })
    await engine.startTurn('session', 'hello')
    expect(request).toEqual({
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }], model: 'gpt-next', effort: 'ultra' },
    })
  })

  test('starts a fresh thread with workspace instructions and tracks token usage', async () => {
    const engine = new CodexEngine() as any
    const connection = fakeConnection()
    connection.developerInstructions = 'workspace rules'
    engine.connections.set('session', connection)
    let resetParams: Record<string, unknown> | undefined
    engine.request = async (_connection: unknown, _method: string, params: Record<string, unknown>) => {
      resetParams = params
      return { thread: { id: 'thread-2' } }
    }
    expect(await engine.resetThread('session', 'updated workspace rules')).toEqual({ threadId: 'thread-2', model: 'gpt-default', effort: 'medium' })
    expect(resetParams).toEqual({ model: 'gpt-default', config: { model_reasoning_effort: 'medium' }, developerInstructions: 'updated workspace rules' })
    engine.handleNotification(connection, 'thread/tokenUsage/updated', {
      tokenUsage: {
        total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningOutputTokens: 10 },
        last: { totalTokens: 80, inputTokens: 70, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 5 },
        modelContextWindow: 200,
      },
    })
    expect(engine.getContext('session').tokenUsage).toEqual({
      totalTokens: 80, inputTokens: 70, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 5, modelContextWindow: 200,
    })
  })
})
