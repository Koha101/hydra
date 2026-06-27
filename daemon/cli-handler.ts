import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { doSpawnSession, killSession, sessionDeathEmitter } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, getContextPercent } from './util.js'
import { checkIdempotency, registerIdempotency, updateIdempotency, clearIdempotency, listIdempotencyEntries } from './idempotency.js'

// ---------------------------------------------------------------------------
// CLI auth source tracking (in-memory, keyed by sessionId)
// ---------------------------------------------------------------------------

const cliAuthSources = new Map<string, string>()

export function getCLIAuthSource(sessionId: string): string | undefined {
  return cliAuthSources.get(sessionId)
}

sessionDeathEmitter.on('death', (event: { sessionId: string }) => {
  cliAuthSources.delete(event.sessionId)
})

// ---------------------------------------------------------------------------
// CLI access config
// ---------------------------------------------------------------------------

export type CLIAccessSource = {
  allowed_purposes: string[] | '*'
  max_concurrent: number
  timeout_default_minutes?: number
}

export type CLIAccessConfig = {
  sources: Record<string, CLIAccessSource>
  require_auth: boolean
}

const CLI_ACCESS_PATH = join(STATE_DIR, 'cli-access.json')

function loadCLIAccess(): CLIAccessConfig {
  try {
    if (existsSync(CLI_ACCESS_PATH)) {
      return JSON.parse(readFileSync(CLI_ACCESS_PATH, 'utf8'))
    }
  } catch {}
  return { sources: { manual: { allowed_purposes: '*', max_concurrent: 5 } }, require_auth: false }
}

// ---------------------------------------------------------------------------
// CLI request/response types
// ---------------------------------------------------------------------------

export type CLIRequest = {
  type: 'cli'
  command: string
  id: string
  authSource?: string
  params: Record<string, unknown>
}

export type CLIResponse = {
  type: 'cli-response'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// Auth validation
// ---------------------------------------------------------------------------

function validateAuth(authSource: string | undefined, purpose: string | undefined): { ok: true } | { ok: false; error: string } {
  const config = loadCLIAccess()
  if (!config.require_auth) return { ok: true }

  const source = authSource ?? 'manual'
  const entry = config.sources[source]
  if (!entry) return { ok: false, error: `unknown auth source: ${source}` }

  if (purpose && entry.allowed_purposes !== '*') {
    if (!entry.allowed_purposes.includes(purpose)) {
      return { ok: false, error: `source "${source}" not authorized for purpose "${purpose}"` }
    }
  }

  const activeCount = [...cliAuthSources.values()].filter(s => s === source).length
  if (activeCount >= entry.max_concurrent) {
    return { ok: false, error: `source "${source}" at max concurrent (${entry.max_concurrent})` }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSpawn(req: CLIRequest): Promise<CLIResponse> {
  const { prompt, purpose, idempotencyKey, timeoutMinutes, notifyThread } = req.params as {
    prompt?: string
    purpose?: string
    idempotencyKey?: string
    timeoutMinutes?: number
    notifyThread?: string
  }

  if (!prompt) return { type: 'cli-response', id: req.id, ok: false, error: 'prompt is required' }

  const authSource = req.authSource ?? 'manual'
  const authResult = validateAuth(req.authSource, purpose)
  if (!authResult.ok) return { type: 'cli-response', id: req.id, ok: false, error: authResult.error }

  if (idempotencyKey) {
    const check = checkIdempotency(idempotencyKey)
    if (check.blocked) {
      return {
        type: 'cli-response', id: req.id, ok: false,
        error: `idempotency key "${idempotencyKey}" already exists (status: ${check.entry.status}, session: ${check.entry.sessionId})`,
        data: { existing: check.entry },
      }
    }
  }

  if (notifyThread) {
    const existing = registry.getByThread(notifyThread)
    if (!existing) {
      try {
        const { gateway } = await import('./config.js')
        await gateway.fetchChannel(notifyThread)
      } catch {
        return { type: 'cli-response', id: req.id, ok: false, error: `invalid notifyThread: "${notifyThread}" is not a valid channel or thread` }
      }
    }
  }

  const topic = purpose ? `[${purpose}] ${prompt}` : prompt
  const result = await doSpawnSession(topic, notifyThread)

  cliAuthSources.set(result.sessionId, authSource)

  if (idempotencyKey) {
    registerIdempotency(idempotencyKey, result.sessionId)
  }

  if (timeoutMinutes && timeoutMinutes > 0) {
    setTimeout(() => {
      const info = registry.get(result.sessionId)
      if (info) {
        void killSession(info, `CLI timeout (${timeoutMinutes}m)`).catch(() => {})
        if (idempotencyKey) updateIdempotency(idempotencyKey, 'timed_out')
      }
      cliAuthSources.delete(result.sessionId)
    }, timeoutMinutes * 60 * 1000)
  }

  return {
    type: 'cli-response', id: req.id, ok: true,
    data: {
      sessionId: result.sessionId,
      name: result.name,
      threadId: result.threadId,
      url: result.url,
      idempotencyKey,
    },
  }
}

function handleList(req: CLIRequest): CLIResponse {
  const sorted = [...registry.values()].sort((a, b) => b.lastActive - a.lastActive)
  const list = sorted.map(s => ({
    name: s.tmuxName,
    sessionId: s.sessionId,
    description: s.description ?? (s.topic ? fallbackDescription(s.topic) : ''),
    url: s.threadUrl ?? '',
    context: getContextPercent(s.tmuxName),
    running_for: formatDuration(Date.now() - s.createdAt),
    status: transport.has(s.sessionId) ? 'connected' : 'disconnected',
    cliSource: cliAuthSources.get(s.sessionId),
  }))
  return { type: 'cli-response', id: req.id, ok: true, data: list }
}

function handleStatus(req: CLIRequest): CLIResponse {
  const { name } = req.params as { name?: string }
  if (!name) return { type: 'cli-response', id: req.id, ok: false, error: 'name is required' }

  const info = [...registry.values()].find(s => s.tmuxName === name || s.sessionId === name)
  if (!info) return { type: 'cli-response', id: req.id, ok: false, error: `session "${name}" not found` }

  const tmuxAlive = (() => {
    try {
      const result = Bun.spawnSync(['tmux', 'has-session', '-t', info.tmuxName], { stdio: ['pipe', 'pipe', 'pipe'] })
      return result.exitCode === 0
    } catch { return false }
  })()

  return {
    type: 'cli-response', id: req.id, ok: true,
    data: {
      name: info.tmuxName,
      sessionId: info.sessionId,
      topic: info.topic,
      description: info.description,
      threadId: info.threadId,
      url: info.threadUrl,
      context: getContextPercent(info.tmuxName),
      running_for: formatDuration(Date.now() - info.createdAt),
      bridge: transport.has(info.sessionId) ? 'connected' : 'disconnected',
      tmux: tmuxAlive ? 'alive' : 'dead',
      origin: info.originType,
      cliSource: cliAuthSources.get(info.sessionId),
    },
  }
}

async function handleKill(req: CLIRequest): Promise<CLIResponse> {
  const { name } = req.params as { name?: string }
  if (!name) return { type: 'cli-response', id: req.id, ok: false, error: 'name is required' }

  const info = [...registry.values()].find(s => s.tmuxName === name || s.sessionId === name)
  if (!info) return { type: 'cli-response', id: req.id, ok: false, error: `session "${name}" not found` }

  await killSession(info, 'killed via CLI')
  cliAuthSources.delete(info.sessionId)
  return { type: 'cli-response', id: req.id, ok: true, data: { killed: info.tmuxName } }
}

function handleHealth(req: CLIRequest): CLIResponse {
  const sessions = [...registry.values()]
  const connected = sessions.filter(s => transport.has(s.sessionId)).length
  const disconnected = sessions.length - connected

  let tmuxRunning = false
  try {
    const result = Bun.spawnSync(['tmux', 'list-sessions'], { stdio: ['pipe', 'pipe', 'pipe'] })
    tmuxRunning = result.exitCode === 0
  } catch {}

  return {
    type: 'cli-response', id: req.id, ok: true,
    data: {
      sessions: { total: sessions.length, connected, disconnected },
      tmux: tmuxRunning ? 'running' : 'not running',
      idempotency: { active: listIdempotencyEntries().length },
    },
  }
}

function handleClearKey(req: CLIRequest): CLIResponse {
  const { key } = req.params as { key?: string }
  if (!key) return { type: 'cli-response', id: req.id, ok: false, error: 'key is required' }
  const cleared = clearIdempotency(key)
  if (!cleared) return { type: 'cli-response', id: req.id, ok: false, error: `key "${key}" not found` }
  return { type: 'cli-response', id: req.id, ok: true, data: { cleared: key } }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleCLIRequest(req: CLIRequest): Promise<CLIResponse> {
  try {
    switch (req.command) {
      case 'spawn': return await handleSpawn(req)
      case 'list': return handleList(req)
      case 'status': return handleStatus(req)
      case 'kill': return await handleKill(req)
      case 'health': return handleHealth(req)
      case 'clear-key': return handleClearKey(req)
      default:
        return { type: 'cli-response', id: req.id, ok: false, error: `unknown command: ${req.command}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'cli-response', id: req.id, ok: false, error: msg }
  }
}
