import { randomUUID } from 'crypto'
import { transport } from './bridge-transport.js'

export type CodexConfigUpdate = {
  model?: string | null
  effort?: string | null
}

export type CodexConfigResult = {
  model: string
  effort: string
}

export type CodexContextResult = {
  codexSessionId?: string
  usage?: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    reasoningOutputTokens: number
    usedTokens: number
    contextWindow?: number
  }
}

export type CodexClearResult = {
  previousSessionId?: string
}

type PendingConfig = {
  sessionId: string
  resolve: (result: CodexConfigResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingConfigs = new Map<string, PendingConfig>()

type PendingControl = {
  sessionId: string
  action: 'context' | 'clear'
  resolve: (message: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingControls = new Map<string, PendingControl>()

/** Reconfigure a live Codex sidecar and wait for it to acknowledge the update. */
export function configureCodexSession(
  sessionId: string,
  update: CodexConfigUpdate,
  timeoutMs = 5_000,
): Promise<CodexConfigResult> {
  const bridge = transport.get(sessionId)
  if (!bridge) return Promise.reject(new Error('Codex bridge is not connected'))

  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingConfigs.delete(id)
      reject(new Error('Codex bridge did not acknowledge the configuration change'))
    }, timeoutMs)
    pendingConfigs.set(id, { sessionId, resolve, reject, timer })
    transport.sendToBridge(bridge, { type: 'session_config', id, ...update })
  })
}

/** Resolve a configuration request from a Codex sidecar response. */
export function handleCodexConfigResult(sessionId: string, message: Record<string, unknown>): void {
  const id = typeof message.id === 'string' ? message.id : ''
  const pending = pendingConfigs.get(id)
  if (!pending || pending.sessionId !== sessionId) return

  clearTimeout(pending.timer)
  pendingConfigs.delete(id)
  if (message.ok !== true) {
    pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Codex rejected the configuration change'))
    return
  }
  pending.resolve({
    model: typeof message.model === 'string' ? message.model : 'default',
    effort: typeof message.effort === 'string' ? message.effort : 'default',
  })
}

function requestCodexControl(
  sessionId: string,
  action: PendingControl['action'],
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const bridge = transport.get(sessionId)
  if (!bridge) return Promise.reject(new Error('Codex bridge is not connected'))

  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControls.delete(id)
      reject(new Error(`Codex bridge did not acknowledge the ${action} request`))
    }, timeoutMs)
    pendingControls.set(id, { sessionId, action, resolve, reject, timer })
    transport.sendToBridge(bridge, { type: 'session_control', id, action })
  })
}

export async function getCodexContext(sessionId: string, timeoutMs = 5_000): Promise<CodexContextResult> {
  const message = await requestCodexControl(sessionId, 'context', timeoutMs)
  const rawUsage = message.usage
  const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage as CodexContextResult['usage'] : undefined
  return {
    ...(typeof message.codexSessionId === 'string' ? { codexSessionId: message.codexSessionId } : {}),
    ...(usage ? { usage } : {}),
  }
}

export async function clearCodexContext(sessionId: string, timeoutMs = 5_000): Promise<CodexClearResult> {
  const message = await requestCodexControl(sessionId, 'clear', timeoutMs)
  return typeof message.previousSessionId === 'string'
    ? { previousSessionId: message.previousSessionId }
    : {}
}

/** Resolve a context/clear request from a Codex sidecar response. */
export function handleCodexControlResult(sessionId: string, message: Record<string, unknown>): void {
  const id = typeof message.id === 'string' ? message.id : ''
  const pending = pendingControls.get(id)
  if (!pending || pending.sessionId !== sessionId || message.action !== pending.action) return

  clearTimeout(pending.timer)
  pendingControls.delete(id)
  if (message.ok !== true) {
    pending.reject(new Error(typeof message.error === 'string' ? message.error : `Codex rejected the ${pending.action} request`))
    return
  }
  pending.resolve(message)
}

/** Fail outstanding requests promptly when their sidecar disconnects. */
export function rejectCodexConfigRequests(sessionId: string): void {
  for (const [id, pending] of pendingConfigs) {
    if (pending.sessionId !== sessionId) continue
    clearTimeout(pending.timer)
    pendingConfigs.delete(id)
    pending.reject(new Error('Codex bridge disconnected before applying the configuration change'))
  }
  for (const [id, pending] of pendingControls) {
    if (pending.sessionId !== sessionId) continue
    clearTimeout(pending.timer)
    pendingControls.delete(id)
    pending.reject(new Error(`Codex bridge disconnected before completing the ${pending.action} request`))
  }
}
