import type { FetchedMessage } from '../gateway.js'
import { conversationId, sessionEngine, threadRegistry, type SessionEngine, type ThreadSessionEntry } from './sessions.js'
import { holdPendingContinuityForBoot } from './session-continuity.js'

const MAX_HANDOFF_CHARS = 24_000
const handoffRoutes = new Map<string, string>()
const SESSION_COMMAND_RE = /^(?:\/(?:provider|model|effort|context|clear|ultracode|forks?|kill|listen|unlisten|pause|unpause|waiting|resume|respawn|usage|watch|unwatch|watches|review|build(?:-wt)?|design|recover|reboot|restart|reconnect)\b|(?:forks?|kill(?:\s+(?:review|build|design))?|listen|unlisten|pause|unpause|waiting|resume|respawn|usage|watch|unwatch|watches|review|build(?:-wt)?|design|recover|restart|reconnect)(?:\s|:|$)|(?:allow|deny)$)/i

export function setProviderHandoffRoute(threadId: string, sessionId: string): void {
  handoffRoutes.set(threadId, sessionId)
}

export function providerHandoffRoute(threadId: string): string | undefined {
  return handoffRoutes.get(threadId)
}

export function clearProviderHandoffRoute(threadId: string): void {
  handoffRoutes.delete(threadId)
}

export function isSessionCommand(content: string): boolean {
  return SESSION_COMMAND_RE.test(content.trim())
}

export function isRecoveryCommand(content: string): boolean {
  return /^(?:resume|respawn|\/(?:resume|respawn))(?::|\s|$)/i.test(content.trim())
}

export function chooseDeliverySession(
  requestedSessionId: string,
  transitionSessionId: string | undefined,
  pendingSessionId: string | undefined,
  mappedSessionId: string | undefined,
): string {
  return transitionSessionId ?? pendingSessionId ?? mappedSessionId ?? requestedSessionId
}

export function reconcilePendingContinuityOnBoot(): void {
  for (const thread of threadRegistry.values()) {
    const pendingSessionId = thread.pendingContinuitySessionId
    if (!pendingSessionId) continue
    holdPendingContinuityForBoot(thread.threadId, pendingSessionId)
    process.stderr.write(`daemon: preserved interrupted provider handoff for ${thread.threadId}; awaiting reconnect or resume\n`)
  }
}

export function findLatestEngineConversation(
  history: ThreadSessionEntry[],
  engine: SessionEngine,
): ThreadSessionEntry | undefined {
  return [...history].reverse().find(entry =>
    sessionEngine(entry) === engine && !!conversationId(entry, engine),
  )
}

export function buildProviderHandoffContext(
  messages: FetchedMessage[],
  source: SessionEngine,
  target: SessionEngine,
  since?: number,
): string {
  const lines = messages
    .filter(message => !since || message.createdAt.getTime() >= since)
    .filter(message => !/^\/?provider\s+(?:claude|codex)\s*$/i.test(message.content.trim()))
    .map(message => {
      const content = message.content.trim() || '(no text)'
      const attachments = message.attachmentCount > 0
        ? ` [${message.attachmentCount} attachment${message.attachmentCount === 1 ? '' : 's'}]`
        : ''
      return `[${message.createdAt.toISOString()}] ${message.authorUsername}: ${content}${attachments}`
    })

  const selected: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1
    if (selected.length > 0 && used + cost > MAX_HANDOFF_CHARS) break
    selected.push(lines[i])
    used += cost
  }
  selected.reverse()

  return [
    '[Hydra provider handoff]',
    `Continue the same job in the same Discord thread. Provider changed from ${source} to ${target}.`,
    'Treat the latest user request and current workspace state as authoritative. Do not restart completed work.',
    '',
    since ? 'Messages since this provider was last active:' : 'Recent thread transcript:',
    selected.length > 0 ? selected.join('\n') : '(no intervening thread messages)',
  ].join('\n')
}
