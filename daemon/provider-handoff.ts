import type { FetchedMessage } from '../gateway.js'
import type { SessionProvider, ThreadSessionEntry } from './sessions.js'

const MAX_HANDOFF_CHARS = 24_000

export function findLatestProviderConversation(
  history: ThreadSessionEntry[],
  provider: SessionProvider,
): ThreadSessionEntry | undefined {
  return [...history].reverse().find(entry =>
    (entry.provider ?? 'claude') === provider
      && (provider === 'codex' ? !!entry.codexSessionId : !!entry.claudeSessionId),
  )
}

/** Build a bounded, chronological transcript for the destination provider.
 * When it has been active in this thread before, only messages posted after
 * that provider's last session ended are included. */
export function buildProviderHandoffContext(
  messages: FetchedMessage[],
  source: SessionProvider,
  target: SessionProvider,
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
    'The transcript below is the handoff context. Treat the latest user request and current workspace state as authoritative. Do not restart completed work.',
    '',
    since ? 'Messages since this provider was last active:' : 'Recent thread transcript:',
    selected.length > 0 ? selected.join('\n') : '(no intervening thread messages)',
  ].join('\n')
}
