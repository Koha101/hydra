import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { peek, type PeekOverrides } from '../peek.js'

const mockExecSync = mock(() => '')
const mockSendRequest = mock(async () => ({ ok: true, data: [] }))
const mockTmuxExists = mock(() => true)
const mockTmuxKill = mock(() => {})
const mockExit = mock(() => { throw new Error('exit') })

const deps = {
  execSync: mockExecSync,
  resolveSocket: () => '/tmp/fake.sock',
  sendRequest: mockSendRequest,
  shq: (s: string) => "'" + s.replace(/'/g, "'\\''") + "'",
  tmuxExists: mockTmuxExists,
  tmuxKill: mockTmuxKill,
  exit: mockExit,
} as unknown as PeekOverrides

const runPeek = (args: string[]) => peek(args, undefined, deps)

beforeEach(() => {
  mockExecSync.mockClear()
  mockSendRequest.mockClear()
  mockTmuxExists.mockClear()
  mockTmuxKill.mockClear()
  mockExit.mockClear()
})

describe('peek', () => {
  describe('no live sessions', () => {
    test('exits cleanly when no sessions are live', async () => {
      mockSendRequest.mockResolvedValueOnce({ ok: true, data: [] })
      try { await runPeek([]) } catch {}
      expect(mockExit).toHaveBeenCalledWith(0)
    })
  })

  describe('single session — direct attach', () => {
    test('attaches read-only to the sole session', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true,
        data: [{ name: 'spark', status: 'connected', description: 'test' }],
      })
      await runPeek([])
      const attachCall = mockExecSync.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('attach-session') && c[0].includes("'spark'")
      )
      expect(attachCall).toBeDefined()
    })

    test('validates session name exists', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true,
        data: [{ name: 'spark', status: 'connected' }],
      })
      try { await runPeek(['drift']) } catch {}
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('multiple sessions — window view', () => {
    test('creates hydra-peek session with windows for each', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true,
        data: [
          { name: 'spark', status: 'connected', description: 'alpha' },
          { name: 'pixel', status: 'connected', description: 'beta' },
          { name: 'nova', status: 'disconnected' },
        ],
      })
      await runPeek([])

      // Should kill existing peek session
      expect(mockTmuxKill).toHaveBeenCalledWith('hydra-peek')

      // Should create new session with first window
      const newSessionCall = mockExecSync.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('new-session') && c[0].includes('hydra-peek')
      )
      expect(newSessionCall).toBeDefined()

      // Should link-window for each session
      const linkCalls = mockExecSync.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('link-window')
      )
      expect(linkCalls).toHaveLength(3) // spark + pixel + nova

      // Should attach to peek session
      const attachCall = mockExecSync.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('attach-session') && c[0].includes('hydra-peek')
      )
      expect(attachCall).toBeDefined()
    })

    test('attaches to the peek session (not read-only, to allow navigation)', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'connected' },
        ],
      })
      await runPeek([])

      const attachCall = mockExecSync.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('attach-session') && c[0].includes('hydra-peek')
      )
      expect(attachCall).toBeDefined()
      // Should NOT be read-only — -r blocks ctrl+b n/p navigation
      expect(attachCall![0]).not.toContain(' -r')
    })

    test('does not modify global tmux key bindings', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'connected' },
        ],
      })
      await runPeek([])

      const bindCalls = mockExecSync.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('bind-key')
      )
      expect(bindCalls).toHaveLength(0)
    })
  })


  describe('session filtering', () => {
    test('excludes dead sessions', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'dead' },
        ],
      })
      await runPeek([])

      // Only spark is live — should direct-attach, not split
      const attachCall = mockExecSync.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('attach-session') && c[0].includes("'spark'")
      )
      expect(attachCall).toBeDefined()
      // No hydra-peek session created
      expect(mockTmuxKill).not.toHaveBeenCalled()
    })
  })

  describe('named peek', () => {
    test('attaches to specific named session', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'connected' },
        ],
      })
      await runPeek(['pixel'])

      const attachCall = mockExecSync.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('attach-session') && c[0].includes("'pixel'")
      )
      expect(attachCall).toBeDefined()
      // Should NOT create hydra-peek
      expect(mockTmuxKill).not.toHaveBeenCalled()
    })
  })
})
