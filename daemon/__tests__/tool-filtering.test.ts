import { describe, test, expect } from 'bun:test'
import { computeToolsForSession, MAIN_ONLY_TOOLS, BRIDGE_TOOLS } from '../bridge-tools.js'

// Suppress stderr
process.stderr.write = (() => true) as any

describe('computeToolsForSession', () => {
  test('main session gets all tools', () => {
    const tools = computeToolsForSession('main')
    expect(tools).toBe(BRIDGE_TOOLS) // same reference
    const names = tools.map(t => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('spawn_session')
    expect(names).toContain('list_sessions')
    expect(names).toContain('kill_session')
    expect(names).toContain('send_to_thread')
    expect(names).toContain('peek_session')
  })

  test('worker session excludes main-only tools', () => {
    const tools = computeToolsForSession('some-worker-id')
    const names = tools.map(t => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('react')
    expect(names).toContain('fetch_messages')
    expect(names).toContain('set_description')
    for (const mainOnly of MAIN_ONLY_TOOLS) {
      expect(names).not.toContain(mainOnly)
    }
  })

  test('worker session gets orchestration tools', () => {
    const tools = computeToolsForSession('some-worker-id')
    const names = tools.map(t => t.name)
    expect(names).toContain('send_to_thread')
    expect(names).toContain('peek_session')
    expect(names).toContain('list_sessions')
  })

  test('MAIN_ONLY_TOOLS contains expected tools', () => {
    expect(MAIN_ONLY_TOOLS.has('spawn_session')).toBe(true)
    expect(MAIN_ONLY_TOOLS.has('kill_session')).toBe(true)
    expect(MAIN_ONLY_TOOLS.has('list_sessions')).toBe(false)
    expect(MAIN_ONLY_TOOLS.has('reply')).toBe(false)
    expect(MAIN_ONLY_TOOLS.has('send_to_thread')).toBe(false)
    expect(MAIN_ONLY_TOOLS.has('peek_session')).toBe(false)
  })

  test('all BRIDGE_TOOLS have required schema fields', () => {
    for (const tool of BRIDGE_TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  test('spawn_session exposes Claude and Codex providers with phase budgets', () => {
    const spawn = BRIDGE_TOOLS.find(t => t.name === 'spawn_session')!
    expect((spawn.inputSchema.properties as any).provider.enum).toEqual(['claude', 'codex'])
    expect(spawn.inputSchema.properties).toHaveProperty('phase_budget')
  })

  test('send_to_thread schema has required fields including type', () => {
    const tool = BRIDGE_TOOLS.find(t => t.name === 'send_to_thread')!
    expect(tool).toBeDefined()
    expect(tool.inputSchema.required).toContain('target')
    expect(tool.inputSchema.required).toContain('type')
    expect(tool.inputSchema.required).toContain('text')
    expect(tool.inputSchema.properties).toHaveProperty('target')
    expect(tool.inputSchema.properties).toHaveProperty('type')
    expect(tool.inputSchema.properties).toHaveProperty('text')
    expect(tool.inputSchema.properties).toHaveProperty('files')
    expect((tool.inputSchema.properties as any).type.enum).toEqual(['progress', 'question', 'result'])
  })

  test('peek_session schema has required fields', () => {
    const tool = BRIDGE_TOOLS.find(t => t.name === 'peek_session')!
    expect(tool).toBeDefined()
    expect(tool.inputSchema.required).toContain('name')
    expect(tool.inputSchema.properties).toHaveProperty('name')
    expect(tool.inputSchema.properties).toHaveProperty('lines')
  })
})
