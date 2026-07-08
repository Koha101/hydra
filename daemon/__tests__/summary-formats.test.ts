import { describe, test, expect } from 'bun:test'
import { SUMMARY_FORMATS, DEFAULT_SUMMARY_FORMAT, resolveSummaryFormat } from '../prompts/summary-formats.js'

describe('resolveSummaryFormat', () => {
  test('undefined resolves to the default', () => {
    expect(resolveSummaryFormat(undefined)).toBe(SUMMARY_FORMATS[DEFAULT_SUMMARY_FORMAT])
  })

  test('every named format resolves to itself', () => {
    for (const name of Object.keys(SUMMARY_FORMATS)) {
      expect(resolveSummaryFormat(name)).toBe(SUMMARY_FORMATS[name])
    }
  })

  test('unknown name falls back to the default without throwing', () => {
    const w = process.stderr.write
    process.stderr.write = (() => true) as any
    try {
      expect(resolveSummaryFormat('vibes')).toBe(SUMMARY_FORMATS[DEFAULT_SUMMARY_FORMAT])
    } finally {
      process.stderr.write = w
    }
  })

  test('all formats carry a preamble and at least one section', () => {
    for (const f of Object.values(SUMMARY_FORMATS)) {
      expect(f.preamble.length).toBeGreaterThan(0)
      expect(f.lines.length).toBeGreaterThan(0)
    }
  })
})
