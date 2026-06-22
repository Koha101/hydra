import { describe, test, expect } from 'bun:test'
import { chunk, formatDuration, fallbackDescription } from '../util.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// chunk()
// ---------------------------------------------------------------------------

describe('chunk', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('exact limit returns single chunk', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('length mode splits at limit boundary', () => {
    const text = 'a'.repeat(250)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBe(3)
    expect(result[0].length).toBe(100)
    expect(result[1].length).toBe(100)
    expect(result[2].length).toBe(50)
  })

  test('newline mode prefers paragraph break', () => {
    const text = 'first paragraph\n\nsecond paragraph that is very long and keeps going'
    const result = chunk(text, 30, 'newline')
    // First chunk includes text up to the paragraph break point
    expect(result[0]).toContain('first paragraph')
    expect(result.length).toBeGreaterThan(1)
    // Second chunk should have the continuation
    expect(result.slice(1).join('')).toContain('second paragraph')
  })

  test('newline mode falls back to line break', () => {
    const text = 'line one\nline two\nline three is here'
    const result = chunk(text, 20, 'newline')
    expect(result.length).toBeGreaterThan(1)
  })

  test('newline mode splits long text without newlines', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const result = chunk(text, 30, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // All content should be preserved
    expect(result.join('').replace(/\s+/g, ' ').trim()).toContain('one two three')
  })

  test('empty text returns single empty chunk', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })

  test('all content preserved across chunks', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    const result = chunk(text, 50, 'newline')
    const reassembled = result.join('')
    // Content should be preserved (minus stripped leading newlines between chunks)
    expect(reassembled.length).toBeLessThanOrEqual(text.length)
    expect(reassembled.length).toBeGreaterThan(text.length * 0.95)
  })
})

// ---------------------------------------------------------------------------
// formatDuration()
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('minutes only', () => {
    expect(formatDuration(5 * 60_000)).toBe('5m')
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  test('hours and minutes', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(60 * 60_000)).toBe('1h')
    expect(formatDuration(23 * 60 * 60_000)).toBe('23h')
  })

  test('days and hours', () => {
    expect(formatDuration(25 * 60 * 60_000)).toBe('1d 1h')
    expect(formatDuration(48 * 60 * 60_000)).toBe('2d')
    expect(formatDuration(49 * 60 * 60_000)).toBe('2d 1h')
  })
})

// ---------------------------------------------------------------------------
// fallbackDescription()
// ---------------------------------------------------------------------------

describe('fallbackDescription', () => {
  test('strips leading slash command', () => {
    expect(fallbackDescription('/spawn some topic')).toBe('some topic')
  })

  test('uses first line only', () => {
    expect(fallbackDescription('first line\nsecond line')).toBe('first line')
  })

  test('truncates long descriptions', () => {
    const long = 'a'.repeat(150)
    const result = fallbackDescription(long)
    expect(result.length).toBe(100)
    expect(result.endsWith('...')).toBe(true)
  })

  test('short description passes through', () => {
    expect(fallbackDescription('hello world')).toBe('hello world')
  })

  test('empty string', () => {
    expect(fallbackDescription('')).toBe('')
  })
})
