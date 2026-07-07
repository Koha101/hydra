import { describe, test, expect } from 'bun:test'

import { mechanicsBlock } from '../prompts/mechanics.js'
import { designPersonaPrompt, PERSONA_SPECS, PERSONA_NAMES, personaQuestionsTag, personaProposalTag } from '../prompts/design-personas.js'
import { designSynthesizerPrompt } from '../prompts/design-synthesizer.js'
import { designAuditorPrompt } from '../prompts/design-auditor.js'
import { designBriefPrompt } from '../prompts/design-brief.js'
import { buildCriticPrompt } from '../prompts/build-critic.js'
import { reviewCriticPrompt } from '../prompts/review-critic.js'

// Drift guard, in both directions. Routing mechanics (sentinel, untagged rule,
// reply(), wait) must be byte-identical across every protocol seed — a seed
// that stops consuming mechanicsBlock() fails here instead of silently stalling
// a run into the 15-minute timeout. Orientation is the opposite: illumination
// order is position, so the five pool personas' orient lines must be pairwise
// DISTINCT; only singleton roles share the uniform read-everything-first line.

const base = { sessionId: 'sid-1', tmuxName: 'hydra-x', topic: 'test topic', threadId: 't1' }
const names = PERSONA_NAMES

function personaPrompts(): Array<{ role: string; tag: string; text: string }> {
  return PERSONA_NAMES.map(persona => ({
    role: persona,
    tag: `[${persona}→thread]`,
    text: designPersonaPrompt({ ...base, persona, cutoffTs: '2026-01-01T00:00:00Z' }),
  }))
}

function singletonPrompts(): Array<{ role: string; tag: string; text: string }> {
  return [
    { role: 'synthesizer', tag: '[synthesizer→thread]', text: designSynthesizerPrompt({ ...base, personaNames: names }) },
    { role: 'auditor', tag: '[auditor→thread]', text: designAuditorPrompt({ ...base, personaNames: names }) },
    { role: 'brief', tag: '[brief→thread]', text: designBriefPrompt({ ...base, personaNames: names }) },
    { role: 'build-critic', tag: '[critic→builder]', text: buildCriticPrompt({ ...base, rounds: 3, task: 'build it' }) },
    { role: 'review-critic', tag: '[critic→owner]', text: reviewCriticPrompt({ ...base, rounds: 3 }) },
  ]
}

function allPrompts(): Array<{ role: string; tag: string; text: string }> {
  return [...personaPrompts(), ...singletonPrompts()]
}

describe('shared mechanics — uniform across all protocol seeds', () => {
  test('singleton sentinel rule is strong and byte-identical (drift item 1)', () => {
    for (const p of singletonPrompts()) {
      expect(p.text).toContain(`A protocol message's FIRST LINE must be exactly \`${p.tag}\` — the daemon routes on the first line only.`)
    }
  })

  test('persona sentinel grammar is per-phase and matches design.ts routing tags', () => {
    for (const persona of PERSONA_NAMES) {
      const text = designPersonaPrompt({ ...base, persona })
      // design.ts routes questions on personaQuestionsTag, proposals/refinement on personaProposalTag
      expect(text).toContain(`Questions phase: \`${personaQuestionsTag(persona)}\``)
      expect(text).toContain(`Proposal & refinement phases: \`${personaProposalTag(persona)}\``)
      // no contradictory universal single-tag rule alongside the per-phase grammar
      expect(text).not.toContain('FIRST LINE must be exactly')
      expect(text).toContain('routes on the FIRST LINE only')
    }
    // freeze the exact strings the daemon parses (design.ts imports these same builders)
    expect(personaQuestionsTag('x')).toBe('[x→questions]')
    expect(personaProposalTag('x')).toBe('[x→thread]')
  })

  test('untagged=conversational rule present everywhere the parser applies (drift item 4)', () => {
    for (const p of allPrompts()) {
      expect(p.text).toContain('Untagged messages are conversational: humans see them; the protocol does not advance.')
    }
  })

  test('reply() instruction present everywhere (drift item 3)', () => {
    for (const p of allPrompts()) {
      expect(p.text).toContain(`post to the thread with reply(chat_id="t1")`)
    }
  })

  test('singleton read-context line uniform, wiki articles included (drift item 2)', () => {
    for (const p of singletonPrompts()) {
      expect(p.text).toContain('Read every code file, wiki article, config, or document it references before forming a view.')
    }
  })

  test('fetch_messages tool named in every seed', () => {
    for (const p of allPrompts()) {
      expect(p.text).toContain('fetch_messages(channel="t1", limit=100)')
    }
  })

  test('cutoff line renders only when cutoffTs given', () => {
    const withCutoff = designPersonaPrompt({ ...base, persona: 'subtractor', cutoffTs: '2026-01-01T00:00:00Z' })
    const without = designPersonaPrompt({ ...base, persona: 'subtractor' })
    expect(withCutoff).toContain('Only read messages posted BEFORE 2026-01-01T00:00:00Z.')
    expect(without).not.toContain('Only read messages posted BEFORE')
  })

  test('cadence renders per option', () => {
    const one = mechanicsBlock({ ...base, role: 'r', protocol: 'p', tag: '[a→b]', cadence: 'one-message' })
    const round = mechanicsBlock({ ...base, role: 'r', protocol: 'p', tag: '[a→b]', cadence: 'per-round' })
    const phase = mechanicsBlock({ ...base, role: 'r', protocol: 'p', tag: '[a→b]', cadence: 'per-phase' })
    expect(one).toContain('Post exactly ONE protocol message.')
    expect(round).toContain('One protocol message per round.')
    expect(phase).toContain('Exactly ONE protocol message per phase.')
  })
})

describe('persona specs — counter-steering invariants', () => {
  test('five personas, unique names', () => {
    expect(PERSONA_SPECS.length).toBe(5)
    expect(new Set(PERSONA_SPECS.map(s => s.name)).size).toBe(5)
  })

  test('no two personas share orient, first move, evidence, or form', () => {
    for (const axis of ['orient', 'firstMove', 'evidence', 'form'] as const) {
      expect(new Set(PERSONA_SPECS.map(s => s[axis])).size).toBe(5)
    }
  })

  test('persona orient lines are pairwise distinct and free of the uniform illumination mandate', () => {
    const orientLines = personaPrompts().map(p => {
      const line = p.text.split('\n').find(l => l.startsWith('**Orient:**'))
      expect(line).toBeDefined()
      return line!
    })
    expect(new Set(orientLines).size).toBe(5)
    for (const line of orientLines) {
      expect(line).not.toContain('Read every code file, wiki article, config, or document it references before forming a view.')
    }
  })

  test('persona seed carries the questions-phase tag', () => {
    for (const persona of PERSONA_NAMES) {
      const text = designPersonaPrompt({ ...base, persona })
      expect(text).toContain(`[${persona}→questions]`)
    }
  })

  test('unknown persona is rejected at the boundary', () => {
    expect(() => designPersonaPrompt({ ...base, persona: 'ghost' as never })).toThrow('unknown persona')
  })
})

describe('brief seed — cast comes from parameters (drift item 5)', () => {
  const RETIRED_CAST = ['adversary', 'pragmatist', 'systems_thinker', 'operator', 'historian']

  test('names every persona passed in, no hardcoded cast retired or current', () => {
    const text = designBriefPrompt({ ...base, personaNames: ['alpha', 'beta'] })
    expect(text).toContain('alpha, beta')
    for (const name of [...RETIRED_CAST, ...PERSONA_NAMES]) expect(text).not.toContain(name)
  })
})
