import { describe, test, expect } from 'bun:test'
import { SessionRegistry, sessionEmoji, type SessionInfo } from '../sessions.js'

// Suppress stderr
process.stderr.write = (() => true) as any

function makeInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'sid-1',
    topic: 'test topic',
    threadId: 'thread-1',
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: 'spark',
    listening: false,
    ...overrides,
  }
}

// Note: SessionRegistry constructor loads from STATE_DIR/sessions.json and checks tmux.
// Real sessions may exist on the host, so we test behaviors that are additive/relative.

describe('SessionRegistry', () => {
  test('set and get', () => {
    const reg = new SessionRegistry()
    const baseline = reg.size
    const info = makeInfo({ sessionId: 'test-set-get' })
    reg.set('test-set-get', info)
    expect(reg.get('test-set-get')).toBe(info)
    expect(reg.has('test-set-get')).toBe(true)
    expect(reg.size).toBe(baseline + 1)
  })

  test('delete removes session', () => {
    const reg = new SessionRegistry()
    const id = 'test-delete-' + Date.now()
    reg.set(id, makeInfo({ sessionId: id }))
    expect(reg.has(id)).toBe(true)
    reg.delete(id)
    expect(reg.has(id)).toBe(false)
  })

  test('thread mapping', () => {
    const reg = new SessionRegistry()
    reg.setThread('thread-42', 'sid-1')
    expect(reg.getByThread('thread-42')).toBe('sid-1')
    reg.deleteThread('thread-42')
    expect(reg.getByThread('thread-42')).toBeUndefined()
  })

  test('resolveThreadSession finds session by channelId', () => {
    const reg = new SessionRegistry()
    const info = makeInfo({ sessionId: 'sid-resolve-1', threadId: 'thread-99' })
    reg.set('sid-resolve-1', info)
    reg.setThread('thread-99', 'sid-resolve-1')

    const found = reg.resolveThreadSession('thread-99')
    expect(found).toBe(info)
  })

  test('resolveThreadSession finds session by existingThreadId', () => {
    const reg = new SessionRegistry()
    const info = makeInfo({ sessionId: 'sid-resolve-2', threadId: 'thread-100' })
    reg.set('sid-resolve-2', info)
    reg.setThread('thread-100', 'sid-resolve-2')

    const found = reg.resolveThreadSession('unknown-channel', 'thread-100')
    expect(found).toBe(info)
  })

  test('resolveThreadSession returns null when isThread=false', () => {
    const reg = new SessionRegistry()
    const id = 'sid-resolve-3'
    reg.set(id, makeInfo({ sessionId: id, threadId: 'thread-101' }))
    reg.setThread('thread-101', id)

    expect(reg.resolveThreadSession('thread-101', undefined, false)).toBeNull()
  })

  test('resolveThreadSession returns null when not found', () => {
    const reg = new SessionRegistry()
    expect(reg.resolveThreadSession('nonexistent-thread-xyz')).toBeNull()
  })
})

describe('sessionEmoji', () => {
  test('known names return correct emoji', () => {
    expect(sessionEmoji('spark')).toBe('\u26A1')     // lightning
    expect(sessionEmoji('flint')).toBe('\uD83E\uDEA8') // rock
    expect(sessionEmoji('ember')).toBe('\uD83D\uDD25') // fire
  })

  test('unknown name returns default', () => {
    expect(sessionEmoji('unknown-name')).toBe('\uD83D\uDD39') // small blue diamond
  })
})
