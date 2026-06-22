import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress, sessionDeathEmitter } from './session-lifecycle.js'
import type { SessionDeathEvent } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { getBuildByThread } from './build.js'
import { reviewCriticPrompt } from './prompts/review-critic.js'
import { createStateMachine } from './state-machine.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewPhase = 'critic_turn' | 'owner_turn' | 'cleanup' | 'complete' | 'cancelled'
type ReviewEvent = 'critic_posted' | 'owner_posted' | 'final_round' | 'summary_posted' | 'timeout' | 'cancel'

export type ReviewState = {
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  topic?: string
  rounds: number
  currentRound: number
  phase: ReviewPhase
  messageIds: string[]
  timeout?: ReturnType<typeof setTimeout>
  _disconnectTimer?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const reviewMachine = createStateMachine<ReviewPhase, ReviewEvent>('review', {
  critic_turn: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' },
  owner_turn:  { owner_posted: 'critic_turn', final_round: 'cleanup', timeout: 'cancelled', cancel: 'cancelled' },
  cleanup:     { summary_posted: 'complete', timeout: 'complete' },
  complete:    {},
  cancelled:   {},
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const reviews = new Map<string, ReviewState>()        // ownerThreadId → state
const activeParticipants = new Set<string>()           // O(1) sessionId membership check

const CRITIC_TIMEOUT_MS = 10 * 60 * 1000
const OWNER_TIMEOUT_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findReviewBySession(sessionId: string): { state: ReviewState; role: 'owner' | 'critic' } | null {
  for (const state of reviews.values()) {
    if (state.phase === 'complete' || state.phase === 'cancelled') continue
    if (state.criticSessionId === sessionId) return { state, role: 'critic' }
    if (state.ownerSessionId === sessionId) return { state, role: 'owner' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getActiveReviews(): ReviewState[] {
  return [...reviews.values()].filter(r => r.phase !== 'complete' && r.phase !== 'cancelled')
}

export function getReviewByThread(threadId: string): ReviewState | undefined {
  return reviews.get(threadId)
}

export function isReviewParticipant(sessionId: string): boolean {
  return activeParticipants.has(sessionId)
}

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
    phase: 'critic_turn',
    messageIds: [],
  }

  reviews.set(ownerThreadId, state)
  activeParticipants.add(ownerSessionId)

  try {
    const topicLine = topic ? `\nFocus: **${topic}**` : ''
    const ann = await gateway.send(ownerThreadId, [
      `**Adversarial Review** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `A critic will challenge the design. You defend.${topicLine}`,
    ].join('\n'))
    state.messageIds.push(ann.id)

    transport.sendOrQueue(ownerSessionId, {
      type: 'notification',
      content: [
        `[system] Adversarial review started (${rounds} rounds). A critic will challenge your design.`,
        `When their critique arrives as a notification, defend your work by replying to your thread.`,
      ].join('\n'),
      meta: { chat_id: ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    await spawnCritic(state)
    return state
  } catch (err) {
    cleanupState(state)
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

  try {
    if (state.criticSessionId) {
      const info = registry.get(state.criticSessionId)
      if (info && !killsInProgress.has(state.criticSessionId)) {
        await killSession(info, 'review cancelled')
      }
    }
  } catch (err) {
    process.stderr.write(`daemon: review cancel killSession failed: ${err}\n`)
  } finally {
    cleanupState(state)
  }

  await gateway.send(state.ownerThreadId, `Review cancelled.`)

  void deleteReviewMessages(state).catch(err => {
    process.stderr.write(`daemon: cancel cleanup failed: ${err}\n`)
  })
}

// ---------------------------------------------------------------------------
// Core reply handler
// ---------------------------------------------------------------------------

export function onReviewReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  const found = findReviewBySession(sessionId)
  if (!found) return

  const { state, role } = found
  if (chatId !== state.ownerThreadId) return

  const firstLine = text.split('\n')[0].trim()

  if (role === 'critic') {
    if (state.criticSessionId !== sessionId) return

    const result = reviewMachine.transition(state.phase, 'critic_posted')
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    state.phase = result.to
    onCriticPosted(state, text)
    return
  }

  // Owner posting
  if (role === 'owner') {
    // Cleanup phase — check for summary
    if (state.phase === 'cleanup') {
      const summaryLine = firstLine.startsWith('**Review Summary**')
      if (summaryLine) {
        const result = reviewMachine.transition(state.phase, 'summary_posted')
        if (result.ok) {
          state.phase = result.to
          finalizeReview(state)
        }
      }
      return
    }

    const isFinalRound = state.currentRound >= state.rounds
    const event: ReviewEvent = isFinalRound ? 'final_round' : 'owner_posted'
    const result = reviewMachine.transition(state.phase, event)
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    state.phase = result.to

    if (isFinalRound) {
      void finishDebate(state, text).catch(err => {
        process.stderr.write(`daemon: finishDebate failed: ${err}\n`)
        void cancelReview(state.ownerThreadId).catch(() => {})
      })
    } else {
      onOwnerPosted(state, text)
    }
  }
}

/** Called when a critic bridge disconnects. */
export function onParticipantDisconnect(sessionId: string): void {
  const found = findReviewBySession(sessionId)
  if (!found || found.role !== 'critic') return
  const state = found.state

  if (state.phase === 'critic_turn' && state.criticSessionId === sessionId) {
    if (transport.has(sessionId)) return

    process.stderr.write(`daemon: review critic disconnected — 30s grace period\n`)
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
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
}

/** Called when a bridge registers. */
export function onParticipantReconnect(sessionId: string): void {
  const found = findReviewBySession(sessionId)
  if (!found || found.role !== 'critic') return
  const state = found.state
  if (!state._disconnectTimer) return
  clearTimeout(state._disconnectTimer)
  state._disconnectTimer = undefined
  resetTimeout(state)
  process.stderr.write(`daemon: review participant ${sessionId} reconnected, grace period cleared\n`)
}

// ---------------------------------------------------------------------------
// Death emitter — handle unexpected critic kills
// ---------------------------------------------------------------------------

sessionDeathEmitter.on('death', (event: SessionDeathEvent) => {
  if (event.wasOwner) return
  const found = findReviewBySession(event.sessionId)
  if (!found || found.role !== 'critic') return
  const state = found.state

  if (state.phase === 'complete' || state.phase === 'cancelled') return

  process.stderr.write(`daemon: review critic ${event.sessionId} died unexpectedly, cancelling review\n`)
  void cancelReview(state.ownerThreadId).catch(err => {
    process.stderr.write(`daemon: review cancel after death failed: ${err}\n`)
  })
})

// ---------------------------------------------------------------------------
// Turn handlers
// ---------------------------------------------------------------------------

function onCriticPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `[Adversarial Review — Critic ${roundLabel}]\n\n${text}\n\n---\nDefend your design. Reply to your thread.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-critic', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(state)
}

function onOwnerPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  state.currentRound++
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`

  transport.sendOrQueue(state.criticSessionId!, {
    type: 'notification',
    content: `[Adversarial Review — Owner Defense]\n\n${text}\n\n---\nPost your counter-argument for ${roundLabel}.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-owner', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(state)
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

async function finishDebate(state: ReviewState, lastOwnerText: string): Promise<void> {
  // Kill critic
  if (state.criticSessionId) {
    activeParticipants.delete(state.criticSessionId)
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'debate complete')
    }
    state.criticSessionId = undefined
  }

  // If the owner's final defense already contains the summary, skip cleanup
  if (lastOwnerText.split('\n')[0].trim().startsWith('**Review Summary**')) {
    state.phase = 'complete'
    finalizeReview(state)
    return
  }

  completeReview(state)
}

function completeReview(state: ReviewState): void {
  // Phase already set to 'cleanup' by the dispatcher

  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: review cleanup timed out, auto-finalizing\n`)
    await gateway.send(state.ownerThreadId, `**Review Summary** — auto-closed (owner did not post summary)`).catch(() => {})
    state.phase = 'complete'
    finalizeReview(state)
  }, 5 * 60 * 1000)

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
  if (state.phase !== 'complete') return
  if (state.timeout) clearTimeout(state.timeout)

  cleanupState(state)

  void deleteReviewMessages(state).catch(err => {
    process.stderr.write(`daemon: review message cleanup failed: ${err}\n`)
  })
}

// ---------------------------------------------------------------------------
// State cleanup
// ---------------------------------------------------------------------------

function cleanupState(state: ReviewState): void {
  if (state.criticSessionId) activeParticipants.delete(state.criticSessionId)
  activeParticipants.delete(state.ownerSessionId)
  reviews.delete(state.ownerThreadId)
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnCritic(state: ReviewState): Promise<void> {
  const statusMsg = await gateway.send(state.ownerThreadId, `Spawning critic...`)
  state.messageIds.push(statusMsg.id)

  try {
    const result = await doSpawnSession(`Adversarial review CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      memberLabel: 'review-critic',
      promptBuilder: (sessionId, tmuxName) =>
        reviewCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, topic: state.topic }),
    })

    state.criticSessionId = result.sessionId
    activeParticipants.add(result.sessionId)
    void gateway.edit(state.ownerThreadId, statusMsg.id, `_Critic (**${result.name}**) spawned._`).catch(() => {})
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

  const whose = state.phase === 'critic_turn' ? 'critic' : 'owner'
  const timeoutMs = whose === 'critic' ? CRITIC_TIMEOUT_MS : OWNER_TIMEOUT_MS
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: review turn timed out (${whose})\n`)
    await gateway.send(state.ownerThreadId, `Review timed out waiting for ${whose}. Cancelling.`)
    await cancelReview(state.ownerThreadId)
  }, timeoutMs)
}
