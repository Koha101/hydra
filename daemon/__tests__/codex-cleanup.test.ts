import { describe, test, expect } from 'bun:test'
import { execSync } from 'child_process'
import { applyCodexSpawnMetadata, killCodexProcessTree } from '../codex-process.js'
import type { SessionInfo } from '../sessions.js'

// Test the exported killCodexProcessTree by spawning real (short-lived) processes.
// This avoids mocking child_process globally which leaks across test files.

function makeInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'test-session',
    topic: 'test',
    threadId: 'ch:thread',
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: 'test-codex-cleanup',
    listening: true,
    engine: 'codex',
    ...overrides,
  }
}

function captureLstart(pid: number): string {
  return execSync(`ps -p ${pid} -o lstart=`, { stdio: 'pipe' }).toString().trim()
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function exitsWithin(pid: number, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
  return !isAlive(pid)
}

describe('killCodexProcessTree — live process tests', () => {
  test('no-op when no pane roots and no stored PIDs', () => {
    const info = makeInfo({})
    // Should not throw
    killCodexProcessTree(info)
  })

  test('skips pane root with mismatched lstart (PID reuse guard)', () => {
    // Spawn a real process
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    const pid = child.pid
    try {
      const info = makeInfo({
        codexPaneRoots: [{ pid, lstart: 'FAKE LSTART THAT WONT MATCH' }],
      })
      killCodexProcessTree(info)
      // Process should still be alive — lstart didn't match
      expect(isAlive(pid)).toBe(true)
    } finally {
      child.kill()
    }
  })

  test('kills verified pane root', async () => {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    const pid = child.pid
    const lstart = captureLstart(pid)
    const info = makeInfo({
      codexPaneRoots: [{ pid, lstart }],
    })
    killCodexProcessTree(info)
    expect(await exitsWithin(pid)).toBe(true)
  })

  test('persists provisional metadata for failed handoff cleanup', async () => {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    const pid = child.pid
    const lstart = captureLstart(pid)
    const info = makeInfo({ pendingInitialPrompt: 'handoff context' })
    applyCodexSpawnMetadata(info, {
      codexThreadId: 'codex-thread',
      codexPaneRoots: [{ pid, lstart }],
      codexAppServerPid: pid,
      codexAppServerLstart: lstart,
      spawnLogPath: '/tmp/codex.log',
    })
    expect(info.codexThreadId).toBe('codex-thread')
    expect(info.spawnLogPath).toBe('/tmp/codex.log')
    killCodexProcessTree(info)
    expect(await exitsWithin(pid)).toBe(true)
  })

  test('falls back to stored app-server PID when another pane root is valid', () => {
    const killed: number[] = []
    const info = makeInfo({
      codexPaneRoots: [
        { pid: 10, lstart: 'stale' },
        { pid: 20, lstart: 'valid' },
      ],
      codexAppServerPid: 30,
      codexAppServerLstart: 'valid',
    })
    killCodexProcessTree(info, {
      verifyPid: (_pid, lstart) => lstart === 'valid',
      killTreeFromPid: pid => { killed.push(pid); return [pid] },
      findAppServerPidBySocket: () => undefined,
    })
    expect(killed).toEqual([20, 30])
  })
})
