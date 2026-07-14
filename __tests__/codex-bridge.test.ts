import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyCodexSessionConfig,
  buildCodexArgs,
  claudeProjectSlug,
  loadClaudeMemoryIndex,
  loadWorkspaceClaudeInstructions,
  notificationPrompt,
  parseCodexContextUsage,
  parseCodexEvents,
} from '../codex-bridge.js'

describe('Codex bridge event parsing', () => {
  test('extracts thread identity and the last completed agent message', () => {
    const output = [
      JSON.stringify({ type: 'thread.started', thread_id: '019abc' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'git status' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 500, reasoning_output_tokens: 100 } }),
    ].join('\n')

    expect(parseCodexEvents(output)).toEqual({
      threadId: '019abc',
      finalMessage: 'final answer',
      usage: {
        inputTokens: 12000,
        cachedInputTokens: 8000,
        outputTokens: 500,
        reasoningOutputTokens: 100,
        usedTokens: 12500,
      },
    })
  })

  test('ignores non-JSON diagnostic lines', () => {
    expect(parseCodexEvents('warning\n{"type":"turn.completed"}\n')).toEqual({})
  })

  test('extracts context-window usage from a saved Codex rollout', () => {
    const output = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 42000, cached_input_tokens: 30000, output_tokens: 1000, reasoning_output_tokens: 250, total_tokens: 43000 },
        model_context_window: 258400,
      } } }),
    ].join('\n')

    expect(parseCodexContextUsage(output)).toEqual({
      inputTokens: 42000,
      cachedInputTokens: 30000,
      outputTokens: 1000,
      reasoningOutputTokens: 250,
      usedTokens: 43000,
      contextWindow: 258400,
    })
  })
})

describe('Codex bridge runtime configuration', () => {
  test('adds model and reasoning effort to new exec turns', () => {
    expect(buildCodexArgs('Review this', { model: 'gpt-5.6', effort: 'high' })).toEqual([
      'codex',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.6',
      '--config',
      'model_reasoning_effort="high"',
      'Review this',
    ])
  })

  test('adds model and reasoning effort to resumed turns', () => {
    expect(buildCodexArgs('Continue', { model: 'gpt-5.6-sol', effort: 'xhigh' }, 'thread-123')).toEqual([
      'codex',
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="xhigh"',
      'thread-123',
      'Continue',
    ])
  })

  test('updates and clears per-session overrides', () => {
    const updated = applyCodexSessionConfig({}, { model: 'gpt-5.6', effort: 'medium' })
    expect(updated).toEqual({ model: 'gpt-5.6', effort: 'medium' })
    expect(applyCodexSessionConfig(updated, { model: null, effort: null })).toEqual({})
  })

  test('rejects unsupported effort values', () => {
    expect(() => applyCodexSessionConfig({}, { effort: 'extreme' })).toThrow('effort must be one of')
  })
})

describe('Claude context compatibility', () => {
  test('maps a workspace path to Claude Code project storage', () => {
    expect(claudeProjectSlug('/Users/example/Development')).toBe('-Users-example-Development')
    expect(claudeProjectSlug('/Users/example/Development/options_bot')).toBe('-Users-example-Development-options-bot')
  })

  test('loads the Claude memory index and injects it only on the initial turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hydra-codex-memory-'))
    const instructionPath = join(dir, 'CLAUDE.md')
    const memoryPath = join(dir, 'MEMORY.md')
    const previousInstructions = process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE
    const previousMemory = process.env.CODEX_CLAUDE_MEMORY_FILE
    try {
      writeFileSync(instructionPath, '# Instructions\n- required rule')
      writeFileSync(memoryPath, '# Memory\n- durable fact')
      process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE = instructionPath
      process.env.CODEX_CLAUDE_MEMORY_FILE = memoryPath

      expect(loadWorkspaceClaudeInstructions('/workspace', instructionPath)).toEqual({ path: instructionPath, content: '# Instructions\n- required rule' })
      expect(loadClaudeMemoryIndex('/workspace', memoryPath)).toEqual({ path: memoryPath, content: '# Memory\n- durable fact' })
      const initial = notificationPrompt({ content: 'start', meta: { hydra_initial: 'true' } })
      expect(initial).toContain('required rule')
      expect(initial).toContain('durable fact')
      const continuation = notificationPrompt({ content: 'continue', meta: {} })
      expect(continuation).not.toContain('required rule')
      expect(continuation).not.toContain('durable fact')
    } finally {
      if (previousInstructions === undefined) delete process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE
      else process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE = previousInstructions
      if (previousMemory === undefined) delete process.env.CODEX_CLAUDE_MEMORY_FILE
      else process.env.CODEX_CLAUDE_MEMORY_FILE = previousMemory
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
