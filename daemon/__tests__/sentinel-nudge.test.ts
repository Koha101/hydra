import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { registerProtocol, _resetForTesting } from '../protocol-registry.js'
import { maybeNudgeMissingSentinel, _resetNudgesForTesting } from '../sentinel-nudge.js'

// Suppress stderr for this file only — restored after each test
const realStderrWrite = process.stderr.write
beforeEach(() => { process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = realStderrWrite })

const T0 = 1_000_000

function registerExpecting(tag: string | null, participant = 'role-1', thread = 'thread-1') {
  registerProtocol('design', {
    getByThread: () => false,
    isParticipant: (id) => id === participant,
    onReply: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
    expectedTag: (id, chat) => (id === participant && chat === thread ? tag : null),
  })
}

beforeEach(() => {
  _resetForTesting()
  _resetNudgesForTesting()
})

describe('maybeNudgeMissingSentinel', () => {
  test('no nudge when nothing is owed', () => {
    registerExpecting(null)
    expect(maybeNudgeMissingSentinel('role-1', 'hello', 'thread-1', T0)).toBe(false)
  })

  test('no nudge for non-participants', () => {
    registerExpecting('[x→questions]')
    expect(maybeNudgeMissingSentinel('stranger', 'hello', 'thread-1', T0)).toBe(false)
  })

  test('no nudge when the expected tag leads the first line', () => {
    registerExpecting('[x→questions]')
    expect(maybeNudgeMissingSentinel('role-1', '[x→questions]\nQ1: why?', 'thread-1', T0)).toBe(false)
  })

  test('nudges when a tagless post arrives while a tag is owed', () => {
    registerExpecting('[x→questions]')
    expect(maybeNudgeMissingSentinel('role-1', 'working on it...', 'thread-1', T0)).toBe(true)
  })

  test('no nudge for posts to a different channel', () => {
    registerExpecting('[x→questions]')
    expect(maybeNudgeMissingSentinel('role-1', 'unrelated post', 'other-thread', T0)).toBe(false)
  })

  test('cooldown suppresses repeat nudges, then re-allows', () => {
    registerExpecting('[x→questions]')
    expect(maybeNudgeMissingSentinel('role-1', 'part one', 'thread-1', T0)).toBe(true)
    expect(maybeNudgeMissingSentinel('role-1', 'part two', 'thread-1', T0 + 30_000)).toBe(false)
    expect(maybeNudgeMissingSentinel('role-1', 'still untagged', 'thread-1', T0 + 61_000)).toBe(true)
  })

  test('leading whitespace on the first line is tolerated', () => {
    registerExpecting('[x→questions]')
    expect(maybeNudgeMissingSentinel('role-1', '  [x→questions] here', 'thread-1', T0)).toBe(false)
  })
})

describe('cooldown keying', () => {
  test('a nudge in one thread does not suppress a nudge in another', () => {
    registerProtocol('design', {
      getByThread: () => false,
      isParticipant: (id) => id === 'role-1',
      onReply: () => {},
      onDisconnect: () => {},
      onReconnect: () => {},
      expectedTag: (id, chat) => (chat === 'thread-1' || chat === 'thread-2' ? '[x→questions]' : null),
    })
    expect(maybeNudgeMissingSentinel('role-1', 'untagged', 'thread-1', T0)).toBe(true)
    expect(maybeNudgeMissingSentinel('role-1', 'untagged', 'thread-2', T0 + 1000)).toBe(true)
    expect(maybeNudgeMissingSentinel('role-1', 'untagged', 'thread-1', T0 + 2000)).toBe(false)
  })
})
