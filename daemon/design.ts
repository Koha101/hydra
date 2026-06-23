import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
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

  await gateway.send(threadId, [
    `**Design Session** — ${PERSONA_NAMES.length} personas`,
    `Topic: **${topic}**`,
    `Spawning ${PERSONA_NAMES.join(', ')}...`,
  ].join('\n'))

  // Spawn personas with 2s stagger
  for (const name of PERSONA_NAMES) {
    try {
      const result = await doSpawnSession(`Design persona: ${name}`, undefined, undefined, {
        joinThread: threadId,
        memberLabel: name,
        promptBuilder: (sessionId, tmuxName) => buildPersonaPrompt(sessionId, tmuxName, name, topic, threadId),
      })
      state.personas.push({ name, sessionId: result.sessionId, proposed: false })
      process.stderr.write(`daemon: design: spawned ${name} as ${result.name}\n`)
      if (name !== PERSONA_NAMES[PERSONA_NAMES.length - 1]) {
        await new Promise(r => setTimeout(r, 2000))
      }
    } catch (err) {
      process.stderr.write(`daemon: design: failed to spawn ${name}: ${err}\n`)
    }
  }

  // Adjust expected count for failed spawns
  state.proposalsExpected = state.personas.length
  if (state.proposalsExpected === 0) {
    await gateway.send(threadId, `No personas could be spawned. Design cancelled.`)
    designs.delete(threadId)
    state.phase = 'cancelled'
    return state
  }

  const spawnResult = designMachine.transition(state.phase, 'all_spawned')
  if (spawnResult.ok) state.phase = spawnResult.to

  await gateway.send(threadId, `_${state.personas.length} persona${state.personas.length > 1 ? 's' : ''} spawned. Waiting for proposals..._`)

  // Set timeout for proposals
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: design: proposal timeout\n`)
    await gateway.send(threadId, `Design timed out waiting for proposals. Cancelling.`)
    await cancelDesign(threadId)
  }, PERSONA_TIMEOUT_MS)

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

  // Kill all persona sessions
  for (const p of state.personas) {
    const info = registry.get(p.sessionId)
    if (info && !killsInProgress.has(p.sessionId)) {
      await killSession(info, 'design cancelled').catch(() => {})
    }
  }
  if (state.synthesizerSessionId) {
    const info = registry.get(state.synthesizerSessionId)
    if (info && !killsInProgress.has(state.synthesizerSessionId)) {
      await killSession(info, 'design cancelled').catch(() => {})
    }
  }
  if (state.auditorSessionId) {
    const info = registry.get(state.auditorSessionId)
    if (info && !killsInProgress.has(state.auditorSessionId)) {
      await killSession(info, 'design cancelled').catch(() => {})
    }
  }

  designs.delete(threadId)
  await gateway.send(state.ownerThreadId, `Design session cancelled.`)
}

// ---------------------------------------------------------------------------
// Reply handler — track persona proposals
// ---------------------------------------------------------------------------

export function onDesignReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  // Find which design this session belongs to
  for (const [threadId, state] of designs) {
    if (chatId !== threadId) continue

    // Check if this is a persona posting a proposal
    const persona = state.personas.find(p => p.sessionId === sessionId)
    if (persona && state.phase === 'independent') {
      const firstLine = text.split('\n')[0].trim()
      const expectedTag = `[${persona.name}→thread]`
      if (!firstLine.startsWith(expectedTag)) return  // conversational, ignore

      if (persona.proposed) return  // already proposed, ignore duplicate
      persona.proposed = true
      state.proposalsReceived++
      process.stderr.write(`daemon: design: ${persona.name} proposed (${state.proposalsReceived}/${state.proposalsExpected})\n`)

      if (state.proposalsReceived >= state.proposalsExpected) {
        if (state.timeout) clearTimeout(state.timeout)
        const result = designMachine.transition(state.phase, 'all_proposed')
        if (result.ok) {
          state.phase = result.to
          void gateway.send(threadId, [
            `_All ${state.proposalsReceived} proposals received._`,
            ``,
            `Type \`next\` to synthesize, or \`done\` to end.`,
          ].join('\n')).catch(() => {})
        }
      }
      return
    }

    // TODO: Tickets 4-6 — handle synthesizer output, refinement replies, auditor output
  }
}

// ---------------------------------------------------------------------------
// Persona prompt builder
// ---------------------------------------------------------------------------

const PERSONA_DESCRIPTIONS: Record<PersonaName, { optimizes: string; lens: string }> = {
  pragmatist: {
    optimizes: 'simplicity and deliverability',
    lens: 'What is the simplest thing that works today? How do we migrate/switch over? What can we cut?',
  },
  systems_thinker: {
    optimizes: 'composability and long-term strength',
    lens: 'What does this look like at 10x scale and in 4 years? How strong are the contracts? What is the long-term vision?',
  },
  adversary: {
    optimizes: 'robustness and failure resistance',
    lens: 'How does this break? What are the failure modes? What edge cases will cause problems?',
  },
  operator: {
    optimizes: 'operability and debuggability',
    lens: 'How do I deploy this? How do I monitor it? How do I debug it at 3am?',
  },
  historian: {
    optimizes: 'learning from precedent',
    lens: 'What did we try before? What patterns worked or failed in this codebase? What can we learn from prior decisions?',
  },
}

function buildPersonaPrompt(
  sessionId: string,
  tmuxName: string,
  persona: PersonaName,
  topic: string,
  threadId: string,
): string {
  const desc = PERSONA_DESCRIPTIONS[persona]
  return [
    `You are ${tmuxName}, the **${persona.replace('_', ' ')}** in a multi-persona design session.`,
    ``,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Topic:** ${topic}`,
    ``,
    `**Your role:** You optimize for **${desc.optimizes}**.`,
    `${desc.lens}`,
    ``,
    `**Instructions:**`,
    `1. Call fetch_messages(channel="${threadId}", limit=100) to read the design context`,
    `2. Read any code files, wiki articles, or documents referenced in the thread`,
    `3. Form your proposal INDEPENDENTLY — do NOT read or reference other personas' proposals`,
    `4. Post your proposal using reply(chat_id="${threadId}")`,
    ``,
    `**Message routing:**`,
    `- Your first line MUST be exactly: \`[${persona}→thread]\``,
    `- Post exactly ONE proposal. Be specific — cite code, suggest interfaces, name tradeoffs.`,
    `- Structure: Summary (2-3 sentences) → Approach → Key decisions → Risks from your lens`,
    ``,
    `After posting, **WAIT**. You may be asked to refine your position in a later phase.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Exports for state machine testing
// ---------------------------------------------------------------------------

export { designMachine }
