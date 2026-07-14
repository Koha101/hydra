import { describe, expect, test } from 'bun:test'
import type { ChatInputCommandInteraction } from 'discord.js'
import { HYDRA_SLASH_COMMANDS, slashToText } from '../discord-gateway.js'

function interaction(commandName: string, values: Record<string, string | undefined>): ChatInputCommandInteraction {
  return {
    commandName,
    options: {
      getString(name: string) { return values[name] },
      data: [],
    },
  } as unknown as ChatInputCommandInteraction
}

describe('Discord slash commands', () => {
  test('registers fork with an optional focus', () => {
    const fork = HYDRA_SLASH_COMMANDS.find(command => command.name === 'fork')
    expect(fork).toBeDefined()
    expect(fork?.options?.[0]).toMatchObject({ name: 'focus', required: false })
  })

  test('maps fork focus to Hydra fork syntax', () => {
    expect(slashToText(interaction('fork', { focus: 'investigate parser' })))
      .toBe('/fork: investigate parser')
    expect(slashToText(interaction('fork', {}))).toBe('/fork')
  })
})
