import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearCodexContext,
  configureCodexSession,
  getCodexContext,
  handleCodexConfigResult,
  handleCodexControlResult,
  rejectCodexConfigRequests,
} from '../codex-control.js'
import { transport, type BridgeConn } from '../bridge-transport.js'

const sessionId = 'codex-control-test'

afterEach(() => {
  rejectCodexConfigRequests(sessionId)
  transport.delete(sessionId)
})

function connectFakeBridge(writes: string[]): void {
  transport.set(sessionId, {
    sessionId,
    socket: {
      write(value: string) {
        writes.push(value)
        return true
      },
    },
    buf: '',
  } as unknown as BridgeConn)
}

describe('Codex session control', () => {
  test('sends a config update and resolves its acknowledgement', async () => {
    const writes: string[] = []
    connectFakeBridge(writes)

    const pending = configureCodexSession(sessionId, { model: 'gpt-5.6', effort: 'high' })
    const request = JSON.parse(writes[0])
    expect(request).toMatchObject({
      type: 'session_config',
      model: 'gpt-5.6',
      effort: 'high',
    })

    handleCodexConfigResult(sessionId, {
      type: 'session_config_result',
      id: request.id,
      ok: true,
      model: 'gpt-5.6',
      effort: 'high',
    })
    await expect(pending).resolves.toEqual({ model: 'gpt-5.6', effort: 'high' })
  })

  test('rejects updates when the Codex bridge is disconnected', async () => {
    await expect(configureCodexSession(sessionId, { effort: 'medium' })).rejects.toThrow('not connected')
  })

  test('requests current context usage from the sidecar', async () => {
    const writes: string[] = []
    connectFakeBridge(writes)

    const pending = getCodexContext(sessionId)
    const request = JSON.parse(writes[0])
    expect(request).toMatchObject({ type: 'session_control', action: 'context' })

    handleCodexControlResult(sessionId, {
      type: 'session_control_result',
      id: request.id,
      action: 'context',
      ok: true,
      codexSessionId: 'codex-thread',
      usage: { inputTokens: 42000, cachedInputTokens: 30000, outputTokens: 1000, reasoningOutputTokens: 250, usedTokens: 43000, contextWindow: 258400 },
    })
    await expect(pending).resolves.toEqual({
      codexSessionId: 'codex-thread',
      usage: { inputTokens: 42000, cachedInputTokens: 30000, outputTokens: 1000, reasoningOutputTokens: 250, usedTokens: 43000, contextWindow: 258400 },
    })
  })

  test('requests a fresh context from the sidecar', async () => {
    const writes: string[] = []
    connectFakeBridge(writes)

    const pending = clearCodexContext(sessionId)
    const request = JSON.parse(writes[0])
    expect(request).toMatchObject({ type: 'session_control', action: 'clear' })

    handleCodexControlResult(sessionId, {
      type: 'session_control_result',
      id: request.id,
      action: 'clear',
      ok: true,
      previousSessionId: 'old-codex-thread',
    })
    await expect(pending).resolves.toEqual({ previousSessionId: 'old-codex-thread' })
  })
})
