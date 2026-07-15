import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearLegacyCodexContext,
  configureLegacyCodexSession,
  getLegacyCodexContext,
  handleLegacyCodexConfigResult,
  handleLegacyCodexControlResult,
  rejectLegacyCodexRequests,
} from '../legacy-codex-control.js'
import { transport, type BridgeConn } from '../bridge-transport.js'

const sessionId = 'legacy-codex-control-test'

afterEach(() => {
  rejectLegacyCodexRequests(sessionId)
  transport.delete(sessionId)
})

function connectFakeBridge(writes: string[]): void {
  transport.set(sessionId, {
    sessionId,
    socket: { write(value: string) { writes.push(value); return true } },
    buf: '',
  } as unknown as BridgeConn)
}

describe('legacy Codex session control', () => {
  test('configures a running sidecar', async () => {
    const writes: string[] = []
    connectFakeBridge(writes)
    const pending = configureLegacyCodexSession(sessionId, { model: 'gpt-next', effort: 'high' })
    const request = JSON.parse(writes[0])
    expect(request).toMatchObject({ type: 'session_config', model: 'gpt-next', effort: 'high' })
    handleLegacyCodexConfigResult(sessionId, { id: request.id, ok: true, model: 'gpt-next', effort: 'high' })
    await expect(pending).resolves.toEqual({ model: 'gpt-next', effort: 'high' })
  })

  test('reads context and clears the sidecar', async () => {
    const writes: string[] = []
    connectFakeBridge(writes)
    const context = getLegacyCodexContext(sessionId)
    const contextRequest = JSON.parse(writes[0])
    handleLegacyCodexControlResult(sessionId, {
      id: contextRequest.id, action: 'context', ok: true, codexSessionId: 'thread',
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, usedTokens: 12, contextWindow: 100 },
    })
    await expect(context).resolves.toMatchObject({ codexSessionId: 'thread', usage: { usedTokens: 12 } })

    const clear = clearLegacyCodexContext(sessionId)
    const clearRequest = JSON.parse(writes[1])
    handleLegacyCodexControlResult(sessionId, { id: clearRequest.id, action: 'clear', ok: true })
    await expect(clear).resolves.toBeUndefined()
  })
})
