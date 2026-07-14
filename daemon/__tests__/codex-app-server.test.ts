import { describe, expect, test } from 'bun:test'
import {
  buildCodexForkParams,
  forkCodexSession,
  type CodexAppServerProcess,
} from '../codex-app-server.js'
import { buildCodexForkPrompt } from '../prompts/session.js'

function fakeProcess(messages: Record<string, unknown>[]): {
  process: CodexAppServerProcess
  writes: string[]
} {
  const writes: string[] = []
  const output = messages.map(message => JSON.stringify(message)).join('\n') + '\n'
  return {
    writes,
    process: {
      stdin: {
        write(data) { writes.push(String(data)) },
        flush() {},
        end() {},
      },
      stdout: new Blob([output]).stream(),
      stderr: new Blob([]).stream(),
      kill() {},
    },
  }
}

describe('Codex app-server fork', () => {
  test('builds fork parameters with Hydra runtime overrides', () => {
    expect(buildCodexForkParams('source-thread', {
      cwd: '/workspace',
      model: 'gpt-5.6',
    })).toEqual({
      threadId: 'source-thread',
      cwd: '/workspace',
      model: 'gpt-5.6',
      sandbox: 'workspace-write',
    })
  })

  test('initializes the app server and returns the forked conversation ID', async () => {
    const fake = fakeProcess([
      { id: 0, result: { userAgent: 'codex-test' } },
      { id: 1, result: { thread: { id: 'forked-thread' } } },
    ])

    await expect(forkCodexSession(
      'source-thread',
      { cwd: '/workspace', model: 'gpt-5.6' },
      () => fake.process,
    )).resolves.toBe('forked-thread')

    expect(fake.writes.map(line => JSON.parse(line))).toEqual([
      {
        method: 'initialize',
        id: 0,
        params: { clientInfo: { name: 'hydra', title: 'Hydra', version: '1' } },
      },
      { method: 'initialized', params: {} },
      {
        method: 'thread/fork',
        id: 1,
        params: { threadId: 'source-thread', cwd: '/workspace', model: 'gpt-5.6', sandbox: 'workspace-write' },
      },
    ])
  })

  test('surfaces app-server fork errors', async () => {
    const fake = fakeProcess([
      { id: 0, result: { userAgent: 'codex-test' } },
      { id: 1, error: { code: -32000, message: 'source thread not found' } },
    ])

    await expect(forkCodexSession('missing-thread', {}, () => fake.process))
      .rejects.toThrow('source thread not found')
  })

  test('orients the fork without asking Codex to call Discord tools', () => {
    const prompt = buildCodexForkPrompt({
      sessionId: 'hydra-child',
      tmuxName: 'qubit',
      threadId: 'discord-child',
      topic: 'investigate parser',
      originFrom: 'spark',
    })
    expect(prompt).toContain('forked from spark')
    expect(prompt).toContain('investigate parser')
    expect(prompt).toContain('parent conversation remains unchanged')
    expect(prompt).not.toContain('reply(chat_id=')
  })
})
