import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { createStateMachine } from './state-machine.js'
import { designPersonaPrompt, PERSONA_NAMES, type PersonaName } from './prompts/design-personas.js'
import { designSynthesizerPrompt } from './prompts/design-synthesizer.js'
import { designAuditorPrompt } from './prompts/design-auditor.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesignPhase =
  | 'spawning'       // spawning persona sessions
  | 'independent'    // waiting for all proposals
  | 'synthesis'      // synthesizer analyzing proposals
  | 'refinement'     // targeted persona refinement
  | 'audit'          // auditor reviewing composite
  | 'brief'          // generating final design brief
  | 'complete'
  | 'cancelled'

type DesignEvent =
  | 'all_spawned'
  | 'all_proposed'
  | 'synthesized'
  | 'refined'
  | 'audited'
  | 'brief_posted'
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
  refinementRound: number
  refinementQueue?: Array<{ description: string; personas: string[]; impact: string }>
  refinementExpected: number
  refinementResponses: number
  refinementRespondedIds: Set<string>
  timeout?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const designMachine = createStateMachine<DesignPhase, DesignEvent>('design', {
  spawning:    { all_spawned: 'independent', timeout: 'cancelled', cancel: 'cancelled' },
  independent: { all_proposed: 'synthesis',  timeout: 'cancelled', cancel: 'cancelled' },
  synthesis:   { synthesized: 'refinement',  timeout: 'cancelled', cancel: 'cancelled' },
  refinement:  { refined: 'synthesis',       timeout: 'cancelled', cancel: 'cancelled' },  // loops back for re-synthesis
  audit:       { audited: 'brief',           timeout: 'cancelled', cancel: 'cancelled' },
  brief:       { brief_posted: 'complete',   timeout: 'cancelled', cancel: 'cancelled' },
  complete:    {},
  cancelled:   {},
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const designs = new Map<string, DesignState>()  // keyed by threadId

const PERSONA_TIMEOUT_MS = 15 * 60 * 1000
const SYNTHESIS_TIMEOUT_MS = 10 * 60 * 1000

export { PERSONA_NAMES, PersonaName }

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
    refinementRound: 0,
    refinementExpected: 0,
    refinementResponses: 0,
    refinementRespondedIds: new Set(),
  }

  designs.set(threadId, state)

  await gateway.send(threadId, [
    `**Design Session** — ${PERSONA_NAMES.length} personas`,
    `Topic: **${topic}**`,
    `Spawning ${PERSONA_NAMES.join(', ')}...`,
  ].join('\n'))

  // Record cutoff timestamp — personas should ignore messages after this point
  const cutoffTs = new Date().toISOString()

  // Spawn personas with 2s stagger
  for (const name of PERSONA_NAMES) {
    try {
      const result = await doSpawnSession(`Design persona: ${name}`, undefined, undefined, {
        joinThread: threadId,
        memberLabel: name,
        promptBuilder: (sessionId, tmuxName) => designPersonaPrompt({ sessionId, tmuxName, persona: name, topic, threadId, cutoffTs }),
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
    if (state.phase !== 'independent') return
    process.stderr.write(`daemon: design: proposal timeout\n`)
    await gateway.send(threadId, `Design timed out waiting for proposals. Cancelling.`)
    await cancelDesign(threadId)
  }, PERSONA_TIMEOUT_MS)

  return state
}

// ---------------------------------------------------------------------------
// Session cleanup — shared by cancel and completion paths
// ---------------------------------------------------------------------------

async function cleanupDesignSessions(state: DesignState, reason: string): Promise<void> {
  for (const p of state.personas) {
    const info = registry.get(p.sessionId)
    if (info && !killsInProgress.has(p.sessionId)) {
      await killSession(info, reason).catch(() => {})
    }
  }
  if (state.synthesizerSessionId) {
    const info = registry.get(state.synthesizerSessionId)
    if (info && !killsInProgress.has(state.synthesizerSessionId)) {
      await killSession(info, reason).catch(() => {})
    }
  }
  if (state.auditorSessionId) {
    const info = registry.get(state.auditorSessionId)
    if (info && !killsInProgress.has(state.auditorSessionId)) {
      await killSession(info, reason).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// Cancel a design
// ---------------------------------------------------------------------------

export async function cancelDesign(threadId: string): Promise<void> {
  const state = designs.get(threadId)
  if (!state) return

  state.phase = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)

  await cleanupDesignSessions(state, 'design cancelled')
  designs.delete(threadId)
  await gateway.send(state.ownerThreadId, `Design session cancelled.`)
}

// ---------------------------------------------------------------------------
// Autonomous flow — auto-advance after each phase
// ---------------------------------------------------------------------------

const MAX_REFINEMENT_ROUNDS = 2

async function autoAdvanceAfterSynthesis(state: DesignState): Promise<void> {
  if (state.divergences.length === 0) {
    await gateway.send(state.ownerThreadId, `_No divergences found. Proceeding to audit._`)
    state.phase = 'audit'
    await spawnAuditor(state)
    return
  }

  state.refinementRound++

  // Round 1: high + medium. Round 2: only high.
  const toRefine = state.refinementRound === 1
    ? state.divergences.filter(d => d.impact === 'high' || d.impact === 'medium')
    : state.divergences.filter(d => d.impact === 'high')

  if (toRefine.length === 0 || state.refinementRound > MAX_REFINEMENT_ROUNDS) {
    await gateway.send(state.ownerThreadId, `_Refinement complete (${state.refinementRound - 1} round${state.refinementRound - 1 !== 1 ? 's' : ''}). Proceeding to audit._`)
    state.phase = 'audit'
    await spawnAuditor(state)
    return
  }

  await gateway.send(state.ownerThreadId, `_Refinement round ${state.refinementRound}: ${toRefine.length} divergence${toRefine.length !== 1 ? 's' : ''} (${toRefine.map(d => d.impact).join(', ')})_`)

  const result = designMachine.transition(state.phase, 'synthesized')
  if (result.ok) state.phase = result.to
  state.currentDivergence = 0

  await runRefinement(state, toRefine)
}

async function autoAdvanceAfterRefinement(state: DesignState): Promise<void> {
  // Refinement done → re-synthesize (machine goes refinement → synthesis)
  const result = designMachine.transition(state.phase, 'refined')
  if (result.ok) state.phase = result.to

  await gateway.send(state.ownerThreadId, `_Re-synthesizing with refinement feedback..._`)
  await spawnSynthesizer(state)
}

async function autoCompleteDesign(state: DesignState): Promise<void> {
  await gateway.send(state.ownerThreadId, `_Audit complete. Design session finished._`)
  await cleanupDesignSessions(state, 'design complete')
  designs.delete(state.ownerThreadId)
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

async function spawnSynthesizer(state: DesignState): Promise<void> {
  await gateway.send(state.ownerThreadId, `_Spawning synthesizer..._`)

  try {
    const result = await doSpawnSession(`Design synthesizer`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      memberLabel: 'synthesizer',
      promptBuilder: (sessionId, tmuxName) => designSynthesizerPrompt({
        sessionId,
        tmuxName,
        topic: state.topic,
        threadId: state.ownerThreadId,
        personaNames: state.personas.map(p => p.name),
      }),
    })

    state.synthesizerSessionId = result.sessionId
    process.stderr.write(`daemon: design: synthesizer spawned as ${result.name}\n`)

    state.timeout = setTimeout(async () => {
      if (state.phase !== 'synthesis') return
      process.stderr.write(`daemon: design: synthesizer timeout\n`)
      const r = designMachine.transition(state.phase, 'timeout')
      if (r.ok) state.phase = r.to
      await gateway.send(state.ownerThreadId, `Synthesizer timed out. Type \`design next\` to retry or \`done\` to end.`)
    }, SYNTHESIS_TIMEOUT_MS)
  } catch (err) {
    process.stderr.write(`daemon: design: synthesizer spawn failed: ${err}\n`)
    const r = designMachine.transition(state.phase, 'timeout')
    if (r.ok) state.phase = r.to
    await gateway.send(state.ownerThreadId, `Synthesizer failed to spawn. Type \`design next\` to retry or \`done\` to end.`)
  }
}

// ---------------------------------------------------------------------------
// Auditor
// ---------------------------------------------------------------------------

async function spawnAuditor(state: DesignState): Promise<void> {
  await gateway.send(state.ownerThreadId, `_Spawning auditor for final review..._`)

  try {
    const result = await doSpawnSession(`Design auditor`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      memberLabel: 'auditor',
      promptBuilder: (sessionId, tmuxName) => designAuditorPrompt({
        sessionId,
        tmuxName,
        topic: state.topic,
        threadId: state.ownerThreadId,
        personaNames: state.personas.map(p => p.name),
      }),
    })

    state.auditorSessionId = result.sessionId
    process.stderr.write(`daemon: design: auditor spawned as ${result.name}\n`)

    state.timeout = setTimeout(async () => {
      if (state.phase !== 'audit') return
      process.stderr.write(`daemon: design: auditor timeout\n`)
      const r = designMachine.transition(state.phase, 'timeout')
      if (r.ok) state.phase = r.to
      await gateway.send(state.ownerThreadId, `Auditor timed out. Cancelling design.`)
      await cancelDesign(state.ownerThreadId)
    }, SYNTHESIS_TIMEOUT_MS)
  } catch (err) {
    process.stderr.write(`daemon: design: auditor spawn failed: ${err}\n`)
    // Fall back to complete without audit
    state.phase = 'complete'
    await gateway.send(state.ownerThreadId, `Auditor failed to spawn. Design complete without audit.`)
    designs.delete(state.ownerThreadId)
  }
}

// ---------------------------------------------------------------------------
// Parse divergences from synthesizer output
// ---------------------------------------------------------------------------

function parseDivergences(text: string): Array<{ description: string; personas: string[]; impact: string }> {
  const divergences: Array<{ description: string; personas: string[]; impact: string }> = []
  const block = text.match(/\[divergences\]\s*\n([\s\S]*?)(?:\n\n|\n```|$)/i)
  if (!block) {
    if (/divergen/i.test(text)) {
      process.stderr.write(`daemon: design: synthesizer mentioned divergences but [divergences] block not parsed — format mismatch\n`)
    }
    return divergences
  }

  const lines = block[1].split('\n').filter(l => l.trim())
  for (const line of lines) {
    // Split on | with lenient whitespace — supports multi-word impact
    const parts = line.replace(/^\d+\.\s*/, '').split('|').map(p => p.trim())
    if (parts.length >= 3) {
      divergences.push({
        description: parts[0],
        personas: parts[1].split(',').map(p => p.trim().replace(/\*\*/g, '')),  // strip bold markdown
        impact: parts[2].toLowerCase(),
      })
    }
  }
  return divergences
}

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

async function runRefinement(
  state: DesignState,
  selectedDivergences: Array<{ description: string; personas: string[]; impact: string }>,
): Promise<void> {
  state.refinementQueue = selectedDivergences
  state.refinementResponses = 0
  state.refinementExpected = 0

  await processNextDivergence(state)
}

async function processNextDivergence(state: DesignState): Promise<void> {
  if (!state.refinementQueue || state.refinementQueue.length === 0) {
    // All divergences refined — auto re-synthesize
    void autoAdvanceAfterRefinement(state)
    return
  }

  const divergence = state.refinementQueue.shift()!
  state.currentDivergence++
  state.refinementResponses = 0
  state.refinementRespondedIds = new Set()

  // Find relevant personas
  const relevant = state.personas.filter(p =>
    divergence.personas.some(name => name === p.name || name === p.name.replace('_', ' '))
  )
  state.refinementExpected = relevant.length

  if (relevant.length === 0) {
    await gateway.send(state.ownerThreadId, `_Divergence ${state.currentDivergence}: no matching personas found. Skipping._`)
    await processNextDivergence(state)
    return
  }

  await gateway.send(state.ownerThreadId, [
    `_Refining divergence ${state.currentDivergence}: **${divergence.description}** (${divergence.impact})_`,
    `_Asking: ${relevant.map(p => p.name).join(', ')}_`,
  ].join('\n'))

  // Notify each relevant persona
  for (const persona of relevant) {
    transport.sendOrQueue(persona.sessionId, {
      type: 'notification',
      content: [
        `[system] Refinement requested on divergence: **${divergence.description}**`,
        ``,
        `Critique the synthesized composite design from your lens (${persona.name}).`,
        `Suggest specific modifications — don't argue with other personas, critique the proposal.`,
        ``,
        `Post your response with: \`[${persona.name}→thread]\``,
      ].join('\n'),
      meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
  }

  // Timeout for refinement responses
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: design: refinement timeout\n`)
    await processNextDivergence(state)
  }, PERSONA_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Participant disconnect — adjust expectations when personas die
// ---------------------------------------------------------------------------

export function onDesignParticipantDisconnect(sessionId: string): void {
  for (const [threadId, state] of designs) {
    const persona = state.personas.find(p => p.sessionId === sessionId)
    if (!persona) continue

    // Check if tmux is actually dead (not just a bridge reconnect)
    try {
      const info = registry.get(sessionId)
      if (info) {
        const { execSync } = require('child_process')
        execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
        return  // tmux alive, just a bridge blip
      }
    } catch {}

    process.stderr.write(`daemon: design: ${persona.name} disconnected/died\n`)
    void gateway.send(threadId, `_⚠️ ${persona.name} disconnected. Continuing with ${state.personas.filter(p => p.sessionId !== sessionId).length} remaining personas._`).catch(() => {})

    if (state.phase === 'independent' && !persona.proposed) {
      state.proposalsExpected--
      if (state.proposalsExpected > 0 && state.proposalsReceived >= state.proposalsExpected) {
        if (state.timeout) clearTimeout(state.timeout)
        const result = designMachine.transition(state.phase, 'all_proposed')
        if (result.ok) {
          state.phase = result.to
          void gateway.send(threadId, `_All ${state.proposalsReceived} proposals received. Auto-synthesizing..._`).catch(() => {})
          void spawnSynthesizer(state)
        }
      }
    } else if (state.phase === 'refinement') {
      state.refinementExpected--
      if (state.refinementExpected > 0 && state.refinementResponses >= state.refinementExpected) {
        if (state.timeout) clearTimeout(state.timeout)
        void processNextDivergence(state)
      }
    }
    return
  }
}

// ---------------------------------------------------------------------------
// Reply handler — track persona proposals + synthesizer output + refinement
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
          void gateway.send(threadId, `_All ${state.proposalsReceived} proposals received. Auto-synthesizing..._`).catch(() => {})
          void spawnSynthesizer(state)
        }
      }
      return
    }

    // Synthesizer posting
    if (state.synthesizerSessionId === sessionId && state.phase === 'synthesis') {
      const firstLine = text.split('\n')[0].trim()
      if (!firstLine.startsWith('[synthesizer→thread]')) return

      if (state.timeout) clearTimeout(state.timeout)

      // Parse divergences from output
      state.divergences = parseDivergences(text)
      process.stderr.write(`daemon: design: synthesizer posted, ${state.divergences.length} divergences found\n`)

      const divList = state.divergences.length > 0
        ? state.divergences.map((d, i) => `  ${i + 1}. ${d.description} (${d.impact})`).join('\n')
        : '  (none identified)'
      void gateway.send(threadId, [
        `_Synthesis complete. ${state.divergences.length} divergence${state.divergences.length !== 1 ? 's' : ''} found._`,
        ``,
        divList,
      ].join('\n')).catch(() => {})

      // Auto-advance to refinement or audit
      void autoAdvanceAfterSynthesis(state)
      return
    }

    // Refinement responses from personas
    if (persona && state.phase === 'refinement') {
      const firstLine = text.split('\n')[0].trim()
      const expectedTag = `[${persona.name}→thread]`
      if (!firstLine.startsWith(expectedTag)) return

      // Dedup: skip if this persona already responded for current divergence
      if (state.refinementRespondedIds.has(persona.sessionId)) return
      state.refinementRespondedIds.add(persona.sessionId)
      state.refinementResponses++
      process.stderr.write(`daemon: design: ${persona.name} refined (${state.refinementResponses}/${state.refinementExpected})\n`)

      if (state.refinementResponses >= state.refinementExpected) {
        if (state.timeout) clearTimeout(state.timeout)
        void processNextDivergence(state)
      }
      return
    }

    // Auditor posting
    if (state.auditorSessionId === sessionId && state.phase === 'audit') {
      const firstLine = text.split('\n')[0].trim()
      if (!firstLine.startsWith('[auditor→thread]')) return

      if (state.timeout) clearTimeout(state.timeout)
      process.stderr.write(`daemon: design: auditor posted findings\n`)

      const result = designMachine.transition(state.phase, 'audited')
      if (result.ok) {
        state.phase = result.to
        void autoCompleteDesign(state)
      }
      return
    }
  }
}


// ---------------------------------------------------------------------------
// Exports for state machine testing
// ---------------------------------------------------------------------------

export { designMachine }
