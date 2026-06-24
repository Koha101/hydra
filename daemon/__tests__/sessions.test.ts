import { describe, test, expect } from 'bun:test'
import { SessionRegistry, sessionEmoji, threadRegistry, type SessionInfo, type ThreadInfo } from '../sessions.js'

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

  test('resolveThreadSession finds session by channelId via threadRegistry', () => {
    const reg = new SessionRegistry()
    const info = makeInfo({ sessionId: 'sid-resolve-1', threadId: 'thread-99' })
    reg.set('sid-resolve-1', info)
    threadRegistry.set('thread-99', { threadId: 'thread-99', topic: 'test', anchorState: 'live', respawnCount: 0, currentSessionId: 'sid-resolve-1', createdAt: Date.now(), lastActive: Date.now(), totalMessages: 0, sessionHistory: [] } as ThreadInfo)

    const found = reg.resolveThreadSession('thread-99')
    expect(found).toBe(info)
    threadRegistry.delete('thread-99')
  })

  test('resolveThreadSession finds session by existingThreadId via threadRegistry', () => {
    const reg = new SessionRegistry()
    const info = makeInfo({ sessionId: 'sid-resolve-2', threadId: 'thread-100' })
    reg.set('sid-resolve-2', info)
    threadRegistry.set('thread-100', { threadId: 'thread-100', topic: 'test', anchorState: 'live', respawnCount: 0, currentSessionId: 'sid-resolve-2', createdAt: Date.now(), lastActive: Date.now(), totalMessages: 0, sessionHistory: [] } as ThreadInfo)

    const found = reg.resolveThreadSession('unknown-channel', 'thread-100')
    expect(found).toBe(info)
    threadRegistry.delete('thread-100')
  })

  test('resolveThreadSession returns null when isThread=false', () => {
    const reg = new SessionRegistry()
    const id = 'sid-resolve-3'
    reg.set(id, makeInfo({ sessionId: id, threadId: 'thread-101' }))
    threadRegistry.set('thread-101', { threadId: 'thread-101', topic: 'test', anchorState: 'live', respawnCount: 0, currentSessionId: id, createdAt: Date.now(), lastActive: Date.now(), totalMessages: 0, sessionHistory: [] } as ThreadInfo)

    expect(reg.resolveThreadSession('thread-101', undefined, false)).toBeNull()
    threadRegistry.delete('thread-101')
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
