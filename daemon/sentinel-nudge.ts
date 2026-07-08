// Liveness: a protocol role that posts without its phase's expected first-line
// tag is silently ignored by every protocol's onReply — the work happened, the
// protocol never saw it. This module converts that silence into feedback.
//
// Live specimen (2026-07-08 smoke run): archaeologist posted correctly-tagged
// questions 90s after the question window's timeout gavel; the post was
// swallowed with no signal to anyone.
import { transport } from './bridge-transport.js'
import { registry } from './sessions.js'
import { getExpectedTag } from './protocol-registry.js'

const NUDGE_COOLDOWN_MS = 60_000
const lastNudgeAt = new Map<string, number>()

export function maybeNudgeMissingSentinel(
  sessionId: string,
  text: string,
  chatId: string,
  now: number = Date.now(),
): boolean {
  const expected = getExpectedTag(sessionId, chatId)
  if (!expected) return false
  if (text.split('\n')[0].trim().startsWith(expected)) return false

  // Keyed per session+thread: a session in two concurrent protocols must not
  // have a nudge in one thread suppress a legitimate nudge in the other.
  const cooldownKey = `${sessionId}:${chatId}`
  const last = lastNudgeAt.get(cooldownKey) ?? 0
  if (now - last < NUDGE_COOLDOWN_MS) return false
  lastNudgeAt.set(cooldownKey, now)

  const name = registry.get(sessionId)?.tmuxName ?? sessionId
  process.stderr.write(`daemon: liveness: ${name} posted without expected tag ${expected}, nudging\n`)
  transport.sendOrQueue(sessionId, {
    type: 'notification',
    content: [
      `[system] Liveness check: your last post was NOT counted by the active protocol.`,
      `This phase expects your first line to start with \`${expected}\`.`,
      `If that post was just a status note, ignore this; otherwise repost with that exact first line.`,
    ].join('\n'),
    meta: { chat_id: chatId, message_id: '', user: 'system', user_id: 'system', ts: new Date(now).toISOString() },
  })

  // Self-pruning after the send (off the decision path): lapsed entries are
  // dead weight — nothing else cleans this map. Deleting during iteration is
  // spec-legal for Map.
  for (const [key, at] of lastNudgeAt) {
    if (now - at >= NUDGE_COOLDOWN_MS) lastNudgeAt.delete(key)
  }
  return true
}

export function _resetNudgesForTesting(): void {
  lastNudgeAt.clear()
}
