import { execFileSync, execSync } from 'child_process'
import { codexSocketPath } from './codex-engine.js'
import type { SessionInfo } from './sessions.js'

type CodexProcessRef = Pick<SessionInfo, 'tmuxName' | 'codexPaneRoots' | 'codexAppServerPid' | 'codexAppServerLstart'>

type CodexSpawnMetadata = {
  codexThreadId: string
  codexPaneRoots: NonNullable<SessionInfo['codexPaneRoots']>
  codexAppServerPid?: number
  codexAppServerLstart?: string
  spawnLogPath?: string
}

export function applyCodexSpawnMetadata(info: SessionInfo, metadata: CodexSpawnMetadata): void {
  info.codexThreadId = metadata.codexThreadId
  if (metadata.codexPaneRoots.length > 0) info.codexPaneRoots = metadata.codexPaneRoots
  if (metadata.codexAppServerPid) {
    info.codexAppServerPid = metadata.codexAppServerPid
    info.codexAppServerLstart = metadata.codexAppServerLstart
  }
  if (metadata.spawnLogPath) info.spawnLogPath = metadata.spawnLogPath
}

export function getDescendants(pid: number): number[] {
  try {
    const out = execSync(`pgrep -P ${pid} 2>/dev/null || true`, { stdio: 'pipe' }).toString().trim()
    if (!out) return []
    const children = out.split('\n').map(s => parseInt(s, 10)).filter(n => n > 0)
    const all: number[] = []
    for (const child of children) {
      all.push(child)
      all.push(...getDescendants(child))
    }
    return all
  } catch { return [] }
}

function verifyPid(pid: number, expectedLstart: string): boolean {
  try {
    const actual = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { stdio: 'pipe' }).toString().trim()
    return actual === expectedLstart
  } catch { return false }
}

export function captureLstart(pid: number): string | undefined {
  try {
    const s = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { stdio: 'pipe' }).toString().trim()
    return s || undefined
  } catch { return undefined }
}

function killTreeFromPid(pid: number): number[] {
  const descendants = getDescendants(pid)
  const allPids = [pid, ...descendants.reverse()]
  const lstarts = new Map<number, string>()
  for (const p of allPids) {
    const ls = captureLstart(p)
    if (ls) lstarts.set(p, ls)
  }
  for (const p of allPids) {
    try { process.kill(p, 'SIGTERM') } catch {}
  }
  setTimeout(() => {
    for (const p of allPids) {
      const expected = lstarts.get(p)
      if (!expected) continue
      if (verifyPid(p, expected)) {
        try { process.kill(p, 'SIGKILL') } catch {}
      }
    }
  }, 3000)
  return allPids
}

function findAppServerPidBySocket(tmuxName: string): number | undefined {
  try {
    const sockPath = codexSocketPath(tmuxName)
    const out = execFileSync('lsof', ['-a', '-U', '-c', 'codex', '-F', 'p'], { stdio: 'pipe' }).toString()
    const pids = out.split('\n').filter(l => l.startsWith('p')).map(l => parseInt(l.slice(1), 10))
    for (const pid of pids) {
      try {
        const fds = execFileSync('lsof', ['-a', '-p', String(pid), '-U', '-F', 'n'], { stdio: 'pipe' }).toString()
        if (fds.includes(sockPath)) return pid
      } catch {}
    }
    return undefined
  } catch { return undefined }
}

type CodexCleanupOps = {
  verifyPid: typeof verifyPid
  killTreeFromPid: typeof killTreeFromPid
  findAppServerPidBySocket: typeof findAppServerPidBySocket
}

const defaultCleanupOps: CodexCleanupOps = { verifyPid, killTreeFromPid, findAppServerPidBySocket }

export function killCodexProcessTree(info: CodexProcessRef, ops: CodexCleanupOps = defaultCleanupOps): void {
  const targeted = new Set<number>()
  if (info.codexPaneRoots) {
    for (const root of info.codexPaneRoots) {
      if (ops.verifyPid(root.pid, root.lstart)) {
        for (const pid of ops.killTreeFromPid(root.pid)) targeted.add(pid)
      }
    }
  }
  if (info.codexAppServerPid && info.codexAppServerLstart && ops.verifyPid(info.codexAppServerPid, info.codexAppServerLstart)) {
    if (!targeted.has(info.codexAppServerPid)) ops.killTreeFromPid(info.codexAppServerPid)
    return
  }
  const socketPid = ops.findAppServerPidBySocket(info.tmuxName)
  if (socketPid && !targeted.has(socketPid)) ops.killTreeFromPid(socketPid)
}
