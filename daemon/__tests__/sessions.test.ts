import { describe, test, expect } from 'bun:test'
import { SessionRegistry, ThreadRegistry, recoverableWorktreeRef, sessionEmoji, type SessionInfo, type ThreadMetadata } from '../sessions.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

function makeThread(overrides: Partial<ThreadMetadata> = {}): ThreadMetadata {
  return {
    threadId: 'thread-1',
    topic: 'test',
    respawnCount: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
    totalMessages: 0,
    sessionHistory: [],
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

describe('ThreadRegistry', () => {
  test('set and get', () => {
    const tr = new ThreadRegistry()
    const info = makeThread({ threadId: 'thread-tr-1' })
    tr.set('thread-tr-1', info)
    expect(tr.get('thread-tr-1')).toBe(info)
    expect(tr.has('thread-tr-1')).toBe(true)
    expect(tr.size).toBe(1)
  })

  test('delete removes thread', () => {
    const tr = new ThreadRegistry()
    const info = makeThread({ threadId: 'thread-tr-2' })
    tr.set('thread-tr-2', info)
    expect(tr.has('thread-tr-2')).toBe(true)
    tr.delete('thread-tr-2')
    expect(tr.has('thread-tr-2')).toBe(false)
  })

  test('persists and clears a pending continuity session', () => {
    const tr = new ThreadRegistry()
    tr.set('thread-continuity', makeThread({ threadId: 'thread-continuity' }))
    tr.setPendingContinuity('thread-continuity', 'source-session')
    expect(tr.get('thread-continuity')?.pendingContinuitySessionId).toBe('source-session')
    tr.setPendingContinuity('thread-continuity')
    expect(tr.get('thread-continuity')?.pendingContinuitySessionId).toBeUndefined()
  })

  test('boot creates threads from sessions', () => {
    const tr = new ThreadRegistry()
    const reg = new SessionRegistry()
    reg.set('sid-boot-1', makeInfo({ sessionId: 'sid-boot-1', threadId: 'thread-boot-1', topic: 'boot test' }))
    tr.boot(reg)
    const thread = tr.get('thread-boot-1')
    expect(thread).toBeDefined()
    expect(thread!.topic).toBe('boot test')
    expect(thread!.sessionHistory).toHaveLength(1)
    expect(thread!.sessionHistory[0].sessionId).toBe('sid-boot-1')
  })

  test('boot preserves worktree recovery metadata', () => {
    const tr = new ThreadRegistry()
    const reg = new SessionRegistry()
    reg.set('sid-wt', makeInfo({
      sessionId: 'sid-wt', threadId: 'thread-wt', worktreeRepo: '/repo', worktreePath: '/repo/.worktrees/wt',
      worktreeBranch: 'wt/spark', worktreeName: 'spark',
    }))
    tr.boot(reg)
    expect(tr.get('thread-wt')!.sessionHistory[0]).toMatchObject({
      worktreeRepo: '/repo', worktreePath: '/repo/.worktrees/wt', worktreeBranch: 'wt/spark', worktreeName: 'spark',
    })
  })

  test('recordSpawn persists a native Codex conversation ID', () => {
    const tr = new ThreadRegistry()
    tr.recordSpawn('thread-codex', {
      topic: 'codex', respawnCount: 0, sessionId: 'sid-codex', tmuxName: 'spark',
      originType: 'spawn', engine: 'codex', codexThreadId: 'codex-thread',
    })
    expect(tr.get('thread-codex')!.sessionHistory[0].codexThreadId).toBe('codex-thread')
  })

  test('only reuses worktrees that still exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'hydra-worktree-'))
    const info = makeInfo({ worktreeRepo: '/repo', worktreePath: root })
    expect(recoverableWorktreeRef(info)?.path).toBe(root)
    rmSync(root, { recursive: true })
    expect(recoverableWorktreeRef(info)).toBeUndefined()
  })

  test('boot skips join members', () => {
    const tr = new ThreadRegistry()
    const reg = new SessionRegistry()
    reg.set('sid-join', makeInfo({ sessionId: 'sid-join', threadId: 'thread-join', isJoinMember: true }))
    tr.boot(reg)
    expect(tr.has('thread-join')).toBe(false)
  })

  test('boot does not overwrite existing threads', () => {
    const tr = new ThreadRegistry()
    const existing = makeThread({ threadId: 'thread-existing', topic: 'original topic', respawnCount: 3, totalMessages: 10 })
    tr.set('thread-existing', existing)
    const reg = new SessionRegistry()
    reg.set('sid-ex', makeInfo({ sessionId: 'sid-ex', threadId: 'thread-existing', topic: 'new topic' }))
    tr.boot(reg)
    expect(tr.get('thread-existing')!.topic).toBe('original topic')
    expect(tr.get('thread-existing')!.respawnCount).toBe(3)
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
