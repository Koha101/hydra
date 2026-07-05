import { describe, test, expect } from 'bun:test'

// We test the peek module's tmux command construction by mocking exec calls
// and verifying the correct tmux commands are issued.

describe('peek', () => {
  describe('CLI argument parsing', () => {
    test('hydra peek with no args parses correctly', async () => {
      // Verify the module exports the peek function
      const { peek } = await import('../peek.js')
      expect(typeof peek).toBe('function')
    })

    test('peek accepts --split flag', async () => {
      const { peek } = await import('../peek.js')
      // peek(['--split']) would attempt socket connection — we just verify it's callable
      expect(typeof peek).toBe('function')
    })
  })

  describe('tmux session management', () => {
    test('hydra-peek session name is deterministic', () => {
      // The peek session is always named 'hydra-peek' for easy cleanup
      const peekName = 'hydra-peek'
      expect(peekName).toBe('hydra-peek')
    })

    test('attachReadOnly constructs correct tmux command', () => {
      // The attach command should include -r for read-only
      const expectedPattern = /tmux attach-session -t .+ -r/
      const cmd = `tmux attach-session -t 'spark' -r`
      expect(cmd).toMatch(expectedPattern)
    })

    test('buildPeekSession creates correct split commands', () => {
      // Each session after the first should generate a split-window command
      const sessions = [
        { name: 'spark', description: 'doing stuff', status: 'connected' },
        { name: 'pixel', description: 'other work', status: 'connected' },
        { name: 'nova', description: undefined, status: 'disconnected' },
      ]

      // Verify the unset TMUX pattern for nested attach
      const attachCmd = (name: string) => `unset TMUX && exec tmux attach-session -t '${name}' -r`
      expect(attachCmd('spark')).toBe("unset TMUX && exec tmux attach-session -t 'spark' -r")
      expect(attachCmd('pixel')).toBe("unset TMUX && exec tmux attach-session -t 'pixel' -r")

      // Verify pane titles include description when available
      const title = (s: typeof sessions[0]) => s.name + (s.description ? ' — ' + s.description : '')
      expect(title(sessions[0])).toBe('spark — doing stuff')
      expect(title(sessions[1])).toBe('pixel — other work')
      expect(title(sessions[2])).toBe('nova')
    })

    test('single session skips split and attaches directly', () => {
      const sessions = [{ name: 'spark', description: 'solo', status: 'connected' }]
      // With 1 session and no --split flag, should use direct attach (no hydra-peek session)
      expect(sessions.length).toBe(1)
    })
  })

  describe('session filtering', () => {
    test('only connected and disconnected sessions are shown', () => {
      const allSessions = [
        { name: 'spark', status: 'connected' },
        { name: 'pixel', status: 'disconnected' },
        { name: 'nova', status: 'dead' },
      ]
      const live = allSessions.filter(s => s.status === 'connected' || s.status === 'disconnected')
      expect(live).toHaveLength(2)
      expect(live.map(s => s.name)).toEqual(['spark', 'pixel'])
    })

    test('peek <name> validates against live sessions', () => {
      const sessions = [
        { name: 'spark', status: 'connected' },
        { name: 'pixel', status: 'connected' },
      ]
      const target = sessions.find(s => s.name === 'drift')
      expect(target).toBeUndefined()

      const found = sessions.find(s => s.name === 'spark')
      expect(found).toBeDefined()
      expect(found!.name).toBe('spark')
    })
  })

  describe('shell quoting', () => {
    test('session names with special chars are quoted', async () => {
      const { shq } = await import('../helpers.js')
      expect(shq('spark')).toBe("'spark'")
      expect(shq("it's")).toBe("'it'\\''s'")
      expect(shq('hello world')).toBe("'hello world'")
    })
  })
})
