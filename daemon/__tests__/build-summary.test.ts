import { describe, test, expect } from 'bun:test'
import { buildSummaryFormat } from '../prompts/build-summary.js'
import { buildMachine } from '../build.js'

describe('buildSummaryFormat', () => {
  test('carries the three build sections and the shared Where-we-are ending', () => {
    const out = buildSummaryFormat(2, []).join('\n')
    expect(out).toContain('**Build Summary** (2 rounds)')
    expect(out).toContain('**What was built**')
    expect(out).toContain('**PRs / artifacts**')
    expect(out).toContain('**Key tensions**')
    expect(out).toContain('**Where we are**')
    expect(out).toContain('present tense')
  })

  test('pre-seeds detected PR links', () => {
    const out = buildSummaryFormat(1, ['https://github.com/x/y/pull/1']).join('\n')
    expect(out).toContain('detected this run: https://github.com/x/y/pull/1')
  })
})

describe('build state machine closing phase', () => {
  test('LGTM and final feedback both route through closing', () => {
    expect(buildMachine.transition('reviewing', 'critic_lgtm')).toMatchObject({ ok: true, to: 'closing' })
    expect(buildMachine.transition('reviewing', 'critic_final')).toMatchObject({ ok: true, to: 'closing' })
  })

  test('closing completes on summary or timeout, never hangs', () => {
    expect(buildMachine.transition('closing', 'summary_posted')).toMatchObject({ ok: true, to: 'complete' })
    expect(buildMachine.transition('closing', 'timeout')).toMatchObject({ ok: true, to: 'complete' })
  })
})
