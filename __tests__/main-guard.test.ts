import { describe, test, expect } from 'bun:test'
import { shouldHoldIncumbentMain } from '../daemon/main-guard.js'

describe('shouldHoldIncumbentMain', () => {
  test('no incumbent → never hold (first/only main registers normally)', () => {
    expect(shouldHoldIncumbentMain({ hasOtherIncumbent: false, flapping: true, now: 100, cooldownUntil: 9999 })).toBe(false)
  })

  test('incumbent present but calm → do not hold (legit single byte restart replaces normally)', () => {
    expect(shouldHoldIncumbentMain({ hasOtherIncumbent: true, flapping: false, now: 100, cooldownUntil: 0 })).toBe(false)
  })

  test('incumbent present and flapping → hold (the ping-pong case)', () => {
    expect(shouldHoldIncumbentMain({ hasOtherIncumbent: true, flapping: true, now: 100, cooldownUntil: 0 })).toBe(true)
  })

  test('incumbent present, not flapping this instant, but within cooldown → still hold', () => {
    expect(shouldHoldIncumbentMain({ hasOtherIncumbent: true, flapping: false, now: 100, cooldownUntil: 200 })).toBe(true)
  })

  test('incumbent present, cooldown expired, not flapping → release (allow newcomer)', () => {
    expect(shouldHoldIncumbentMain({ hasOtherIncumbent: true, flapping: false, now: 300, cooldownUntil: 200 })).toBe(false)
  })

  test('no incumbent overrides cooldown → never hold without a rival socket', () => {
    expect(shouldHoldIncumbentMain({ hasOtherIncumbent: false, flapping: false, now: 100, cooldownUntil: 999 })).toBe(false)
  })
})
