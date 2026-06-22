import { describe, test, expect } from 'bun:test'
import { computeToolsForSession, MAIN_ONLY_TOOLS, BRIDGE_TOOLS } from '../bridge-dispatch.js'

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

  test('MAIN_ONLY_TOOLS contains expected tools', () => {
    expect(MAIN_ONLY_TOOLS.has('spawn_session')).toBe(true)
    expect(MAIN_ONLY_TOOLS.has('list_sessions')).toBe(true)
    expect(MAIN_ONLY_TOOLS.has('kill_session')).toBe(true)
    expect(MAIN_ONLY_TOOLS.has('reply')).toBe(false)
  })

  test('all BRIDGE_TOOLS have required schema fields', () => {
    for (const tool of BRIDGE_TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
    }
  })
})
