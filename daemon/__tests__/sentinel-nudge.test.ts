import { describe, test, expect, beforeEach } from 'bun:test'
import { registerProtocol, _resetForTesting } from '../protocol-registry.js'
import { maybeNudgeMissingSentinel, _resetNudgesForTesting } from '../sentinel-nudge.js'

// Suppress stderr
process.stderr.write = (() => true) as any

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
