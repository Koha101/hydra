import { gateway } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { createStateMachine } from './state-machine.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesignPhase =
  | 'spawning'       // spawning persona sessions
  | 'independent'    // waiting for all proposals
  | 'synthesis'      // synthesizer analyzing proposals
  | 'refinement'     // targeted persona refinement of divergences
  | 'audit'          // auditor reviewing composite
  | 'waiting'        // paused for user input between phases
  | 'complete'
  | 'cancelled'

type DesignEvent =
  | 'all_spawned'
  | 'all_proposed'
  | 'synthesized'
  | 'user_next'
  | 'user_refine'
  | 'user_done'
  | 'user_audit'
  | 'refined'
  | 'audited'
  | 'timeout'
  | 'cancel'

export type DesignState = {
  ownerThreadId: string
  topic: string
  phase: DesignPhase
  personas: Array<{ name: string; sessionId: string; proposed: boolean }>
  synthesizerSessionId?: string
  auditorSessionId?: string
  proposalsExpected: number
  proposalsReceived: number
  divergences: Array<{ description: string; personas: string[]; impact: string }>
  currentDivergence: number
  nextPhaseAfterWaiting?: 'synthesis' | 'refinement' | 'audit'
  timeout?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const designMachine = createStateMachine<DesignPhase, DesignEvent>('design', {
  spawning:    { all_spawned: 'independent', timeout: 'cancelled', cancel: 'cancelled' },
  independent: { all_proposed: 'waiting',    timeout: 'cancelled', cancel: 'cancelled' },
  waiting:     { user_next: 'synthesis', user_refine: 'refinement', user_audit: 'audit', user_done: 'complete', cancel: 'cancelled' },
  synthesis:   { synthesized: 'waiting',     timeout: 'cancelled', cancel: 'cancelled' },
  refinement:  { refined: 'waiting',         timeout: 'cancelled', cancel: 'cancelled' },
  audit:       { audited: 'complete',        timeout: 'cancelled', cancel: 'cancelled' },
  complete:    {},
  cancelled:   {},
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const designs = new Map<string, DesignState>()  // keyed by threadId

const PERSONA_TIMEOUT_MS = 15 * 60 * 1000
const SYNTHESIS_TIMEOUT_MS = 10 * 60 * 1000

export const PERSONA_NAMES = ['pragmatist', 'systems_thinker', 'adversary', 'operator', 'historian'] as const
export type PersonaName = typeof PERSONA_NAMES[number]

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getDesignByThread(threadId: string): DesignState | undefined {
  return designs.get(threadId)
}

export function isDesignParticipant(sessionId: string): boolean {
  for (const design of designs.values()) {
    if (design.personas.some(p => p.sessionId === sessionId)) return true
    if (design.synthesizerSessionId === sessionId) return true
    if (design.auditorSessionId === sessionId) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Start a design
// ---------------------------------------------------------------------------

export async function startDesign(
  threadId: string,
  topic: string,
): Promise<DesignState> {
  if (designs.has(threadId)) {
    throw new Error('A design session is already in progress in this thread')
  }

  const state: DesignState = {
    ownerThreadId: threadId,
    topic,
    phase: 'spawning',
    personas: [],
    proposalsExpected: PERSONA_NAMES.length,
    proposalsReceived: 0,
    divergences: [],
    currentDivergence: 0,
  }

  designs.set(threadId, state)

  const ann = await gateway.send(threadId, [
    `**Design Session** — ${PERSONA_NAMES.length} personas`,
    `Topic: **${topic}**`,
    `Spawning ${PERSONA_NAMES.join(', ')}...`,
  ].join('\n'))

  // TODO: Ticket 2 — spawn personas here
  // For now, advance to independent phase placeholder
  const result = designMachine.transition(state.phase, 'all_spawned')
  if (result.ok) state.phase = result.to

  return state
}

// ---------------------------------------------------------------------------
// Cancel a design
// ---------------------------------------------------------------------------

export async function cancelDesign(threadId: string): Promise<void> {
  const state = designs.get(threadId)
  if (!state) return

  state.phase = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)

  // TODO: kill all persona sessions, synthesizer, auditor

  designs.delete(threadId)
  await gateway.send(state.ownerThreadId, `Design session cancelled.`)
}

// ---------------------------------------------------------------------------
// Reply handler (placeholder — Tickets 2-6 fill this in)
// ---------------------------------------------------------------------------

export function onDesignReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  // TODO: Ticket 2+ — handle persona proposals, synthesizer output, etc.
}

// ---------------------------------------------------------------------------
// Exports for state machine testing
// ---------------------------------------------------------------------------

export { designMachine }
