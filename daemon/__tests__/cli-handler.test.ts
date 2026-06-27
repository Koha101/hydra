import { describe, test, expect } from 'bun:test'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'

// Suppress stderr from daemon modules
process.stderr.write = (() => true) as any

function makeReq(overrides: Partial<CLIRequest> = {}): CLIRequest {
  return {
    type: 'cli',
    command: 'health',
    id: `test-${Date.now()}`,
    params: {},
    ...overrides,
  }
}

describe('cli-handler', () => {
  test('health returns session counts', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'health' }))
    expect(res.ok).toBe(true)
    expect(res.type).toBe('cli-response')
    const data = res.data as any
    expect(data.sessions).toBeDefined()
    expect(typeof data.sessions.total).toBe('number')
    expect(typeof data.sessions.connected).toBe('number')
    expect(typeof data.sessions.disconnected).toBe('number')
  })

  test('list returns array', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'list' }))
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
  })

  test('status with missing name returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'status', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('name is required')
  })

  test('status with unknown name returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'status', params: { name: 'nonexistent-session-xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })

  test('kill with missing name returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'kill', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('name is required')
  })

  test('unknown command returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'foobar' }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown command')
  })

  test('spawn with missing prompt returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'spawn', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('prompt is required')
  })

  test('spawn with idempotency key blocks duplicate', async () => {
    const key = `cli-test-idem-${Date.now()}`
    // Register a key directly
    const { registerIdempotency } = await import('../idempotency.js')
    registerIdempotency(key, 'existing-session')

    const res = await handleCLIRequest(makeReq({
      command: 'spawn',
      params: { prompt: 'test', idempotencyKey: key },
    }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('idempotency')
    expect(res.error).toContain(key)
  })

  test('response always includes type and id', async () => {
    const id = `test-id-${Date.now()}`
    const res = await handleCLIRequest(makeReq({ id, command: 'health' }))
    expect(res.type).toBe('cli-response')
    expect(res.id).toBe(id)
  })

  test('clear-key with missing key returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'clear-key', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('key is required')
  })

  test('clear-key removes registered key', async () => {
    const key = `cli-test-clear-${Date.now()}`
    const { registerIdempotency } = await import('../idempotency.js')
    registerIdempotency(key, 'some-session')

    const res = await handleCLIRequest(makeReq({ command: 'clear-key', params: { key } }))
    expect(res.ok).toBe(true)
    const data = res.data as any
    expect(data.cleared).toBe(key)
  })

  test('clear-key with unknown key returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'clear-key', params: { key: 'no-such-key-xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })
})
