import { describe, test, expect } from 'bun:test'
import { createStateMachine } from '../state-machine.js'
import { getReviewByThread, getActiveReviews } from '../adversarial.js'
import { getBuildByThread, getActiveBuilds } from '../build.js'
import { getDesignByThread, getActiveDesigns } from '../design.js'

process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// State machine transition tests (these use the real state machine factory)
// ---------------------------------------------------------------------------

type ReviewPhase = 'critic_turn' | 'owner_turn' | 'cleanup' | 'complete' | 'cancelled'
type ReviewEvent = 'critic_posted' | 'owner_posted' | 'final_round' | 'summary_posted' | 'timeout' | 'cancel'

type BuildPhase = 'implementing' | 'reviewing' | 'complete' | 'cancelled'
type BuildEvent = 'owner_impl' | 'critic_lgtm' | 'critic_feedback' | 'timeout' | 'cancel'

const reviewMachine = createStateMachine<ReviewPhase, ReviewEvent>('review', {
  critic_turn: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' },
  owner_turn:  { owner_posted: 'critic_turn', final_round: 'cleanup', timeout: 'cancelled', cancel: 'cancelled' },
  cleanup:     { summary_posted: 'complete', timeout: 'complete' },
  complete:    {},
  cancelled:   {},
})

const buildMachine = createStateMachine<BuildPhase, BuildEvent>('build', {
  implementing: { owner_impl: 'reviewing',    timeout: 'cancelled', cancel: 'cancelled' },
  reviewing:    { critic_lgtm: 'complete', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' },
  complete:     {},
  cancelled:    {},
})

describe('state machine transitions', () => {
  test('review: critic_turn -> owner_turn -> cleanup -> complete', () => {
    const r1 = reviewMachine.transition('critic_turn', 'critic_posted')
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.to).toBe('owner_turn')

    const r2 = reviewMachine.transition('owner_turn', 'final_round')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.to).toBe('cleanup')

    const r3 = reviewMachine.transition('cleanup', 'summary_posted')
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.to).toBe('complete')
  })

  test('review: cancel from any phase', () => {
    for (const phase of ['critic_turn', 'owner_turn'] as ReviewPhase[]) {
      const r = reviewMachine.transition(phase, 'cancel')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.to).toBe('cancelled')
    }
  })

  test('build: implementing -> reviewing -> complete', () => {
    const r1 = buildMachine.transition('implementing', 'owner_impl')
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.to).toBe('reviewing')

    const r2 = buildMachine.transition('reviewing', 'critic_lgtm')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.to).toBe('complete')
  })

  test('build: feedback loops back', () => {
    const r = buildMachine.transition('reviewing', 'critic_feedback')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('implementing')
  })

  test('invalid transitions rejected', () => {
    expect(reviewMachine.transition('complete', 'critic_posted').ok).toBe(false)
    expect(buildMachine.transition('complete', 'owner_impl').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutual exclusion — uses real getXByThread lookups from production modules
// ---------------------------------------------------------------------------

describe('mutual exclusion (real module lookups)', () => {
  test('no active protocols at baseline', () => {
    expect(getReviewByThread('test-thread-mutex')).toBeUndefined()
    expect(getBuildByThread('test-thread-mutex')).toBeUndefined()
    expect(getDesignByThread('test-thread-mutex')).toBeUndefined()
  })

  test('getActiveReviews/Builds/Designs return arrays', () => {
    expect(Array.isArray(getActiveReviews())).toBe(true)
    expect(Array.isArray(getActiveBuilds())).toBe(true)
    expect(Array.isArray(getActiveDesigns())).toBe(true)
  })
})
