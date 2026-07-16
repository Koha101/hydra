import { describe, expect, test } from 'bun:test'
import { HYDRA_SLASH_COMMANDS, slashToText } from '../../discord-gateway.js'

function interaction(commandName: string, values: Record<string, string | undefined>) {
  const data = Object.entries(values).filter(([, value]) => value !== undefined).map(([name, value]) => ({ name, value }))
  return {
    commandName,
    options: {
      data,
      getString(name: string) { return values[name] ?? null },
    },
  } as any
}

describe('Discord slash commands', () => {
  test('registers Codex controls', () => {
    const names = HYDRA_SLASH_COMMANDS.map(command => command.name)
    for (const name of ['model', 'effort', 'provider', 'context', 'clear', 'fork', 'ultracode', 'waiting']) {
      expect(names).toContain(name)
    }
  })

  test('maps provider-aware spawn and fork', () => {
    expect(slashToText(interaction('spawn', { topic: 'fix it', provider: 'codex', model: 'gpt-5.5' })))
      .toBe('/spawn codex gpt-5.5: fix it')
    expect(slashToText(interaction('fork', { focus: 'tests' }))).toBe('/fork: tests')
    expect(slashToText(interaction('provider', { provider: 'claude' }))).toBe('/provider claude')
    expect(slashToText(interaction('waiting', { date: '2026-07-20' }))).toBe('/waiting 2026-07-20')
    expect(slashToText(interaction('waiting', {}))).toBe('/waiting')
  })
})
