import { gateway } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { doSpawnSession, killSession, sessionDeathEmitter } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, getContextPercent } from './util.js'
import { checkIdempotency, registerIdempotency, updateIdempotency, clearIdempotency, listIdempotencyEntries } from './idempotency.js'

// ---------------------------------------------------------------------------
// CLI session state (unified, keyed by sessionId)
// ---------------------------------------------------------------------------

type CLISessionState = {
  idempotencyKey?: string
  timeout?: Timer
}

const cliSessions = new Map<string, CLISessionState>()

sessionDeathEmitter.on('death', (event: { sessionId: string }) => {
  const state = cliSessions.get(event.sessionId)
  if (!state) return

  if (state.idempotencyKey) {
    updateIdempotency(state.idempotencyKey, 'completed')
  }

  if (state.timeout) {
    clearTimeout(state.timeout)
  }

  cliSessions.delete(event.sessionId)
})

// ---------------------------------------------------------------------------
// CLI request/response types
// ---------------------------------------------------------------------------

export type CLIRequest = {
  type: 'cli'
  command: string
  id: string
  params: Record<string, unknown>
}

export type CLIResponse = {
  type: 'cli-response'
  command: string
  id: string
  ok: boolean
  data?: unknown
  error?: string
  exitCode?: number
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function respond(req: CLIRequest, ok: true, data?: unknown): CLIResponse
function respond(req: CLIRequest, ok: false, error: string, data?: unknown, exitCode?: number): CLIResponse
function respond(req: CLIRequest, ok: boolean, dataOrError?: unknown, maybeData?: unknown, exitCode?: number): CLIResponse {
  if (ok) {
    return { type: 'cli-response', command: req.command, id: req.id, ok: true, data: dataOrError }
  }
  return {
    type: 'cli-response', command: req.command, id: req.id, ok: false,
    error: dataOrError as string,
    ...(maybeData !== undefined ? { data: maybeData } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  }
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

  if (!prompt) return respond(req, false, 'prompt is required')

  if (idempotencyKey) {
    const check = checkIdempotency(idempotencyKey)
    if (check.blocked) {
      return respond(req, false,
        `idempotency key "${idempotencyKey}" already exists (status: ${check.entry.status}, session: ${check.entry.sessionId})`,
        { existing: check.entry },
        2,
      )
    }
  }

  if (notifyThread) {
    const existing = registry.getByThread(notifyThread)
    if (!existing) {
      try {
        await gateway.fetchChannel(notifyThread)
      } catch {
        return respond(req, false, `invalid notifyThread: "${notifyThread}" is not a valid channel or thread`)
      }
    }
  }

  const topic = purpose ? `[${purpose}] ${prompt}` : prompt
  const result = await doSpawnSession(topic, notifyThread)

  const sessionState: CLISessionState = { idempotencyKey }

  if (idempotencyKey) {
    registerIdempotency(idempotencyKey, result.sessionId)
  }

  if (timeoutMinutes && timeoutMinutes > 0) {
    sessionState.timeout = setTimeout(() => {
      const state = cliSessions.get(result.sessionId)
      if (state) {
        if (state.idempotencyKey) {
          updateIdempotency(state.idempotencyKey, 'timed_out')
          state.idempotencyKey = undefined
        }
        state.timeout = undefined
      }
      const info = registry.get(result.sessionId)
      if (info) {
        void killSession(info, `CLI timeout (${timeoutMinutes}m)`).catch(() => {})
      }
    }, timeoutMinutes * 60 * 1000)
  }

  cliSessions.set(result.sessionId, sessionState)

  return respond(req, true, {
    sessionId: result.sessionId,
    name: result.name,
    threadId: result.threadId,
    url: result.url,
    idempotencyKey,
  })
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
  }))
  return respond(req, true, list)
}

function handleStatus(req: CLIRequest): CLIResponse {
  const { name } = req.params as { name?: string }
  if (!name) return respond(req, false, 'name is required')

  const info = [...registry.values()].find(s => s.tmuxName === name || s.sessionId === name)
  if (!info) return respond(req, false, `session "${name}" not found`)

  const tmuxAlive = (() => {
    try {
      const result = Bun.spawnSync(['tmux', 'has-session', '-t', info.tmuxName], { stdio: ['pipe', 'pipe', 'pipe'] })
      return result.exitCode === 0
    } catch { return false }
  })()

  return respond(req, true, {
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
  })
}

async function handleKill(req: CLIRequest): Promise<CLIResponse> {
  const { name } = req.params as { name?: string }
  if (!name) return respond(req, false, 'name is required')

  const info = [...registry.values()].find(s => s.tmuxName === name || s.sessionId === name)
  if (!info) return respond(req, false, `session "${name}" not found`)

  const state = cliSessions.get(info.sessionId)
  if (state?.idempotencyKey) {
    updateIdempotency(state.idempotencyKey, 'failed')
    state.idempotencyKey = undefined
  }

  await killSession(info, 'killed via CLI')
  return respond(req, true, { killed: info.tmuxName })
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

  return respond(req, true, {
    sessions: { total: sessions.length, connected, disconnected },
    tmux: tmuxRunning ? 'running' : 'not running',
    idempotency: { active: listIdempotencyEntries().length },
  })
}

function handleClearKey(req: CLIRequest): CLIResponse {
  const { key } = req.params as { key?: string }
  if (!key) return respond(req, false, 'key is required')
  const cleared = clearIdempotency(key)
  if (!cleared) return respond(req, false, `key "${key}" not found`)
  return respond(req, true, { cleared: key })
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
        return respond(req, false, `unknown command: ${req.command}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return respond(req, false, msg)
  }
}
