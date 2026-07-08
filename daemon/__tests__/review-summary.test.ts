import { describe, test, expect } from 'bun:test'
import { reviewSummaryFormat } from '../prompts/review-summary.js'

describe('reviewSummaryFormat', () => {
  test('keeps the disposition checklist intact', () => {
    const out = reviewSummaryFormat(3).join('\n')
    expect(out).toContain('- ✅ issue — fixed/will fix')
    expect(out).toContain('- ⚠️ issue — acknowledged, deferred')
    expect(out).toContain('- ❌ issue — rebutted')
  })

  test('adds the present-tense orientation section', () => {
    const out = reviewSummaryFormat(3).join('\n')
    expect(out).toContain('**Where we are**')
    expect(out).toContain('present tense')
    expect(out).toContain('needs the human')
  })

  test('orientation comes after the checklist', () => {
    const out = reviewSummaryFormat(1).join('\n')
    expect(out.indexOf('rebutted')).toBeLessThan(out.indexOf('Where we are'))
  })

  test('round count pluralizes', () => {
    expect(reviewSummaryFormat(1)[0]).toBe('**Review Summary** (1 round)')
    expect(reviewSummaryFormat(3)[0]).toBe('**Review Summary** (3 rounds)')
  })

  test('no configuration surface: format is a pure function of rounds', () => {
    expect(reviewSummaryFormat(2)).toEqual(reviewSummaryFormat(2))
  })
})
