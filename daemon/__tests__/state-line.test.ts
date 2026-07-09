import { describe, test, expect } from 'bun:test'
import { formatStateLine, formatRoundBadge } from '../anchor-state.js'

describe('formatStateLine', () => {
  test('blockquoted, caps, badge position, plain action', () => {
    expect(formatStateLine('⚔️', 'review', formatRoundBadge('', 'top', 2, 3), '🟦 pixel (owner) is defending'))
      .toBe('> **⚔️ REVIEW ²▲₃** — 🟦 pixel (owner) is defending')
  })

  test('no position renders without gap', () => {
    expect(formatStateLine('🔨', 'build', '', 'critic is reviewing'))
      .toBe('> **🔨 BUILD** — critic is reviewing')
  })
})
