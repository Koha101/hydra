import { randomUUID } from 'crypto'
import { transport } from './bridge-transport.js'

export type LegacyCodexConfigResult = { model: string; effort: string }
export type LegacyCodexContextResult = {
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

type Pending = {
  sessionId: string
  action?: 'context' | 'clear'
  resolve: (message: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingConfigs = new Map<string, Pending>()
const pendingControls = new Map<string, Pending>()

function request(
  pending: Map<string, Pending>,
  sessionId: string,
  message: Record<string, unknown>,
  action?: Pending['action'],
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const bridge = transport.get(sessionId)
  if (!bridge) return Promise.reject(new Error('legacy Codex bridge is not connected'))

  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`legacy Codex bridge did not acknowledge ${action ?? 'the configuration change'}`))
    }, timeoutMs)
    pending.set(id, { sessionId, action, resolve, reject, timer })
    transport.sendToBridge(bridge, { ...message, id })
  })
}

export async function configureLegacyCodexSession(
  sessionId: string,
  update: { model?: string | null; effort?: string | null },
): Promise<LegacyCodexConfigResult> {
  const message = await request(pendingConfigs, sessionId, { type: 'session_config', ...update })
  return {
    model: typeof message.model === 'string' ? message.model : 'default',
    effort: typeof message.effort === 'string' ? message.effort : 'default',
  }
}

export async function getLegacyCodexContext(sessionId: string): Promise<LegacyCodexContextResult> {
  const message = await request(pendingControls, sessionId, { type: 'session_control', action: 'context' }, 'context')
  const rawUsage = message.usage
  const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage as LegacyCodexContextResult['usage'] : undefined
  return {
    ...(typeof message.codexSessionId === 'string' ? { codexSessionId: message.codexSessionId } : {}),
    ...(usage ? { usage } : {}),
  }
}

export async function clearLegacyCodexContext(sessionId: string): Promise<void> {
  await request(pendingControls, sessionId, { type: 'session_control', action: 'clear' }, 'clear')
}

function resolvePending(pending: Map<string, Pending>, sessionId: string, message: Record<string, unknown>): void {
  const id = typeof message.id === 'string' ? message.id : ''
  const item = pending.get(id)
  if (!item || item.sessionId !== sessionId || (item.action && message.action !== item.action)) return
  clearTimeout(item.timer)
  pending.delete(id)
  if (message.ok !== true) {
    item.reject(new Error(typeof message.error === 'string' ? message.error : 'legacy Codex rejected the request'))
  } else {
    item.resolve(message)
  }
}

export function handleLegacyCodexConfigResult(sessionId: string, message: Record<string, unknown>): void {
  resolvePending(pendingConfigs, sessionId, message)
}

export function handleLegacyCodexControlResult(sessionId: string, message: Record<string, unknown>): void {
  resolvePending(pendingControls, sessionId, message)
}

export function rejectLegacyCodexRequests(sessionId: string): void {
  for (const pending of [pendingConfigs, pendingControls]) {
    for (const [id, item] of pending) {
      if (item.sessionId !== sessionId) continue
      clearTimeout(item.timer)
      pending.delete(id)
      item.reject(new Error('legacy Codex bridge disconnected before completing the request'))
    }
  }
}
