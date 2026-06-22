import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress, sessionDeathEmitter } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { getBuildByThread } from './build.js'
import { reviewCriticPrompt } from './prompts/review-critic.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewState = {
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  topic?: string
  rounds: number
  currentRound: number
  currentTurn: 'critic' | 'owner'
  phase: 'debate' | 'cleanup' | 'complete' | 'cancelled'
  consecutiveFailures: number
  messageIds: string[]  // track all review messages for cleanup
  timeout?: ReturnType<typeof setTimeout>
  _disconnectTimer?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State
//
// reviews: keyed by ownerThreadId (one review per thread, no indirection)
// activeParticipants: all sessionIds currently in a review (owners + critics)
//   — fast O(1) check for bridge-server hot path
// ---------------------------------------------------------------------------

const reviews = new Map<string, ReviewState>()
const activeParticipants = new Set<string>()

const CRITIC_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes for critic
const OWNER_TIMEOUT_MS = 30 * 60 * 1000  // 30 minutes for owner (human involvement)

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getReviewByThread(threadId: string): ReviewState | undefined {
  return reviews.get(threadId)
}

export function isReviewParticipant(sessionId: string): boolean {
  return activeParticipants.has(sessionId)
}

/** Find the review state for a given session (owner or critic). */
function findReviewBySession(sessionId: string): { state: ReviewState; role: 'critic' | 'owner' } | null {
  for (const state of reviews.values()) {
    if (state.criticSessionId === sessionId) return { state, role: 'critic' }
    if (state.ownerSessionId === sessionId) return { state, role: 'owner' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Death emitter — safety net for unexpected critic kills
// ---------------------------------------------------------------------------

sessionDeathEmitter.on('death', ({ sessionId, threadId }: { sessionId: string; threadId: string }) => {
  const state = reviews.get(threadId)
  if (!state || state.phase !== 'debate') return
  if (state.criticSessionId === sessionId) {
    void cancelReview(threadId).catch(err => {
      process.stderr.write(`daemon: review auto-cancel on critic death failed: ${err}\n`)
    })
  }
})

// ---------------------------------------------------------------------------
// Start a review
// ---------------------------------------------------------------------------

export async function startReview(
  ownerThreadId: string,
  ownerSessionId: string,
  rounds: number,
  topic?: string,
): Promise<ReviewState> {
  if (reviews.has(ownerThreadId)) {
    throw new Error('A review is already in progress in this thread')
  }
  if (getBuildByThread(ownerThreadId)) {
    throw new Error('A build is in progress in this thread — finish or cancel it first')
  }

  const state: ReviewState = {
    ownerThreadId,
    ownerSessionId,
    topic,
    rounds,
    currentRound: 1,
    currentTurn: 'critic',
    phase: 'debate',
    consecutiveFailures: 0,
    messageIds: [],
  }

  // Set state synchronously before any await to prevent TOCTOU
  reviews.set(ownerThreadId, state)
  activeParticipants.add(ownerSessionId)

  try {
    const topicLine = topic ? `\nFocus: **${topic}**` : ''
    const ann = await gateway.send(ownerThreadId, [
      `**Adversarial Review** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `A critic will challenge the design. You defend.${topicLine}`,
    ].join('\n'))
    state.messageIds.push(ann.id)

    // Notify owner to prepare
    transport.sendOrQueue(ownerSessionId, {
      type: 'notification',
      content: `[system] Adversarial review started (${rounds} rounds). A critic will challenge your design. When their critique arrives as a notification, defend your work by replying to your thread. Be specific — cite code and reasoning.`,
      meta: { chat_id: ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    // Spawn critic
    await spawnCritic(state)
    return state
  } catch (err) {
    // Clean up state if startup fails
    reviews.delete(ownerThreadId)
    activeParticipants.delete(ownerSessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Cancel a review
// ---------------------------------------------------------------------------

export async function cancelReview(threadId: string): Promise<void> {
  const state = reviews.get(threadId)
  if (!state) return

  state.phase = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)
  if (state._disconnectTimer) clearTimeout(state._disconnectTimer)

  // Kill critic if alive
  if (state.criticSessionId) {
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'review cancelled')
    }
    activeParticipants.delete(state.criticSessionId)
  }

  activeParticipants.delete(state.ownerSessionId)
  reviews.delete(threadId)
  await gateway.send(state.ownerThreadId, `Review cancelled.`)

  // Clean up review messages (cancel announcement stays for context)
  void deleteReviewMessages(state).catch(err => {
    process.stderr.write(`daemon: cancel cleanup failed: ${err}\n`)
  })
}

// ---------------------------------------------------------------------------
// Core reply handler — called from bridge-server for ALL reply tool calls
// ---------------------------------------------------------------------------

export function onReviewReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  if (!activeParticipants.has(sessionId)) return

  const match = findReviewBySession(sessionId)
  if (!match) return

  const { state, role } = match
  if (chatId !== state.ownerThreadId) return

  if (role === 'critic') {
    if (state.phase === 'debate' && state.currentTurn === 'critic') {
      state.messageIds.push(...sentMessageIds)
      onCriticPosted(state, text)
    }
    return
  }

  // Owner posting
  if (state.phase === 'cleanup') {
    // Don't push sentMessageIds — summary should survive deletion
    if (text.toLowerCase().includes('review summary')) {
      finalizeReview(state)
    }
    return
  }

  if (state.phase !== 'debate' || state.currentTurn !== 'owner') return
  state.messageIds.push(...sentMessageIds)
  onOwnerPosted(state, text)
}

/** Called when a critic bridge disconnects. Grace period before cancel. */
export function onParticipantDisconnect(sessionId: string): void {
  if (!activeParticipants.has(sessionId)) return

  const match = findReviewBySession(sessionId)
  if (!match || match.role !== 'critic') return
  const { state } = match

  if (state.phase !== 'debate' || state.criticSessionId !== sessionId) return

  // If a new bridge already registered, this is a stale disconnect — ignore
  if (transport.has(sessionId)) return

  process.stderr.write(`daemon: review critic disconnected — 30s grace period\n`)
  // Pause turn timeout during grace period to prevent double-cancel
  if (state.timeout) {
    clearTimeout(state.timeout)
    state.timeout = undefined
  }
  // Grace period: bridge reconnections fire disconnect before re-register
  state._disconnectTimer = setTimeout(async () => {
    if (transport.has(sessionId)) {
      process.stderr.write(`daemon: review critic reconnected, grace period cleared\n`)
      resetTimeout(state)
      return
    }
    process.stderr.write(`daemon: review critic did not reconnect, cancelling review\n`)
    await cancelReview(state.ownerThreadId)
  }, 30_000)
}

/** Called when a bridge registers — clears disconnect grace period if applicable. */
export function onParticipantReconnect(sessionId: string): void {
  if (!activeParticipants.has(sessionId)) return

  const match = findReviewBySession(sessionId)
  if (!match) return
  const { state } = match

  if (!state._disconnectTimer) return
  clearTimeout(state._disconnectTimer)
  state._disconnectTimer = undefined
  // Restore turn timeout that was paused during disconnect
  resetTimeout(state)
  process.stderr.write(`daemon: review participant ${sessionId} reconnected, grace period cleared\n`)
}

// ---------------------------------------------------------------------------
// Turn handlers
// ---------------------------------------------------------------------------

function onCriticPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  // Push critique to owner
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `[Adversarial Review — Critic ${roundLabel}]\n\n${text}\n\n---\nDefend your design. Reply to your thread with your response.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-critic', user_id: 'system', ts: new Date().toISOString() },
  })

  state.currentTurn = 'owner'
  resetTimeout(state)
}

function onOwnerPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  if (state.currentRound >= state.rounds) {
    // Final round complete — kill critic, finish
    void finishDebate(state, text).catch(err => {
      process.stderr.write(`daemon: finishDebate failed: ${err}\n`)
      void cancelReview(state.ownerThreadId).catch(() => {})
      void gateway.send(state.ownerThreadId, `Review failed during cleanup: ${err}`).catch(() => {})
    })
    return
  }

  // Push defense to critic and advance round
  state.currentRound++
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`

  transport.sendOrQueue(state.criticSessionId!, {
    type: 'notification',
    content: `[Adversarial Review — Owner Defense]\n\n${text}\n\n---\nPost your counter-argument for ${roundLabel}.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-owner', user_id: 'system', ts: new Date().toISOString() },
  })

  state.currentTurn = 'critic'
  resetTimeout(state)
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

async function finishDebate(state: ReviewState, lastOwnerText: string): Promise<void> {
  // Kill critic
  if (state.criticSessionId) {
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'debate complete')
    }
    activeParticipants.delete(state.criticSessionId)
    state.criticSessionId = undefined
  }

  // If the owner's final defense already contains the summary, skip cleanup phase
  if (lastOwnerText.toLowerCase().includes('review summary')) {
    finalizeReview(state)
    return
  }

  completeReview(state)
}

function completeReview(state: ReviewState): void {
  state.phase = 'cleanup'

  // Cleanup timeout: auto-finalize if owner doesn't post summary within 5 minutes
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: review cleanup timed out, auto-finalizing\n`)
    await gateway.send(state.ownerThreadId, `**Review Summary** — auto-closed (owner did not post summary)`).catch(() => {})
    finalizeReview(state)
  }, 5 * 60 * 1000)

  // Nudge owner to post a summary — messages stay visible until summary is posted
  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: [
      `[system] Adversarial review complete (${state.rounds} round${state.rounds > 1 ? 's' : ''}).`,
      `Post a brief summary to your thread. After you post, the review messages will be cleaned up.`,
      ``,
      `Use this format:`,
      `**Review Summary** (${state.rounds} round${state.rounds > 1 ? 's' : ''})`,
      `- ✅ issue — fixed/will fix`,
      `- ⚠️ issue — acknowledged, deferred`,
      `- ❌ issue — rebutted`,
    ].join('\n'),
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

/** Delete review messages after owner posts summary. Serialized with delay to avoid rate limits. */
async function deleteReviewMessages(state: ReviewState): Promise<void> {
  let failures = 0
  for (const msgId of state.messageIds) {
    try {
      await gateway.delete(state.ownerThreadId, msgId)
    } catch (err) {
      failures++
      process.stderr.write(`daemon: review cleanup: failed to delete message ${msgId}: ${err}\n`)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  if (failures > 0) {
    process.stderr.write(`daemon: review cleanup: ${failures}/${state.messageIds.length} message deletes failed\n`)
  }
}

function finalizeReview(state: ReviewState): void {
  if (state.phase !== 'cleanup') return  // guard against double-entry (timeout + reply race)
  if (state.timeout) clearTimeout(state.timeout)
  state.phase = 'complete'

  // Clear state immediately — phase guard prevents re-entry
  activeParticipants.delete(state.ownerSessionId)
  reviews.delete(state.ownerThreadId)

  void deleteReviewMessages(state).catch(err => {
    process.stderr.write(`daemon: review message cleanup failed: ${err}\n`)
  })
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnCritic(state: ReviewState): Promise<void> {
  const msg = await gateway.send(state.ownerThreadId, `Spawning critic...`)
  state.messageIds.push(msg.id)

  try {
    const result = await doSpawnSession(`Adversarial review CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      memberLabel: 'review-critic',
      promptBuilder: (sessionId, tmuxName) =>
        reviewCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, topic: state.topic }),
    })

    state.criticSessionId = result.sessionId
    state.consecutiveFailures = 0
    activeParticipants.add(result.sessionId)
    resetTimeout(state)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: critic spawn failed: ${msg}\n`)
    await gateway.send(state.ownerThreadId, `Failed to spawn critic: ${msg}. Review cancelled.`)
    void cancelReview(state.ownerThreadId)
  }
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function resetTimeout(state: ReviewState): void {
  if (state.timeout) clearTimeout(state.timeout)

  const whose = state.currentTurn
  const timeoutMs = whose === 'owner' ? OWNER_TIMEOUT_MS : CRITIC_TIMEOUT_MS
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: review turn timed out (${whose})\n`)
    await gateway.send(state.ownerThreadId, `Review timed out waiting for ${whose}. Cancelling.`)
    await cancelReview(state.ownerThreadId)
  }, timeoutMs)
}
