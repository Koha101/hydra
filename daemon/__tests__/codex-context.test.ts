import { describe, expect, test } from 'bun:test'
import { buildCodexWorkspaceContext, claudeProjectSlug } from '../codex-context.js'

describe('Codex workspace context', () => {
  test('uses Claude project slug format', () => {
    expect(claudeProjectSlug('/Users/me/Development')).toBe('-Users-me-Development')
  })

  test('returns empty context when files are absent', () => {
    const priorInstructions = process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE
    const priorMemory = process.env.CODEX_CLAUDE_MEMORY_FILE
    process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE = '/tmp/hydra-no-such-claude-file'
    process.env.CODEX_CLAUDE_MEMORY_FILE = '/tmp/hydra-no-such-memory-file'
    try {
      expect(buildCodexWorkspaceContext('/tmp/hydra-no-such-workspace')).toBe('')
    } finally {
      if (priorInstructions === undefined) delete process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE
      else process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE = priorInstructions
      if (priorMemory === undefined) delete process.env.CODEX_CLAUDE_MEMORY_FILE
      else process.env.CODEX_CLAUDE_MEMORY_FILE = priorMemory
    }
  })
})
