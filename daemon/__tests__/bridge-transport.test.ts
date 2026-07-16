import { describe, test, expect, beforeEach } from 'bun:test'
import { BridgeTransport } from '../bridge-transport.js'
import { STATE_DIR } from '../config.js'
import { threadRegistry } from '../sessions.js'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Suppress stderr
process.stderr.write = (() => true) as any

// Mock socket that records writes
function mockSocket(): { written: string[]; socket: any } {
  const written: string[] = []
  const socket = {
    write(data: string) { written.push(data) },
    end() {},
    destroyed: false,
  }
  return { written, socket }
}

// BridgeTransport reads from config.js STATE_DIR which may not exist in test.
// We test the class methods that don't depend on persistence by creating instances
// and intercepting the constructor's file load (it silently catches ENOENT).

describe('BridgeTransport', () => {
  let bt: BridgeTransport

  beforeEach(() => {
    bt = new BridgeTransport()
  })

  test('sendToBridge writes JSON + newline', () => {
    const { written, socket } = mockSocket()
    const conn = { sessionId: 'test', socket, buf: '' }
    bt.sendToBridge(conn, { type: 'hello', data: 42 })
    expect(written).toHaveLength(1)
    expect(written[0]).toEndWith('\n')
    expect(JSON.parse(written[0])).toEqual({ type: 'hello', data: 42 })
  })

  test('sendOrQueue delivers to connected bridge', () => {
    const { written, socket } = mockSocket()
    const conn = { sessionId: 's1', socket, buf: '' }
    bt.set('s1', conn)
    bt.sendOrQueue('s1', { type: 'notification', content: 'hello' })
    expect(written).toHaveLength(1)
    expect(bt.messageQueues.has('s1')).toBe(false)
  })

  test('holds messages for a connected session until release', () => {
    const { written, socket } = mockSocket()
    bt.set('held', { sessionId: 'held', socket, buf: '' })
    bt.hold('held')
    bt.sendOrQueue('held', { content: 'during transition' })
    expect(written).toHaveLength(0)
    expect(bt.messageQueues.get('held')).toEqual([{ content: 'during transition' }])
    bt.release('held')
    expect(written).toHaveLength(1)
    expect(bt.messageQueues.has('held')).toBe(false)
  })

  test('sendOrQueue queues when no bridge connected', () => {
    bt.sendOrQueue('s2', { type: 'notification', content: 'queued' })
    const queue = bt.messageQueues.get('s2')
    expect(queue).toBeDefined()
    expect(queue!).toHaveLength(1)
    expect(queue![0]).toEqual({ type: 'notification', content: 'queued' })
  })

  test('tool bridge is not an agent transport', () => {
    const { written, socket } = mockSocket()
    bt.setTool('tool-session', { sessionId: 'tool-session', socket, buf: '', bridgeRole: 'tool' })
    expect(bt.has('tool-session')).toBe(false)
    bt.sendOrQueue('tool-session', { type: 'notification', content: 'queued' })
    expect(written).toHaveLength(0)
    expect(bt.messageQueues.get('tool-session')).toHaveLength(1)
  })

  test('queue respects max size (50)', () => {
    for (let i = 0; i < 60; i++) {
      bt.sendOrQueue('s3', { type: 'notification', content: `msg-${i}` })
    }
    const queue = bt.messageQueues.get('s3')
    expect(queue!).toHaveLength(50)
    // First 50 should be preserved, rest dropped
    expect((queue![0] as any).content).toBe('msg-0')
    expect((queue![49] as any).content).toBe('msg-49')
  })

  test('flushQueue delivers all queued messages and returns the count', () => {
    bt.sendOrQueue('s4', { type: 'notification', content: 'a' })
    bt.sendOrQueue('s4', { type: 'notification', content: 'b' })
    bt.sendOrQueue('s4', { type: 'notification', content: 'c' })
    expect(bt.messageQueues.get('s4')).toHaveLength(3)

    const { written, socket } = mockSocket()
    const conn = { sessionId: 's4', socket, buf: '' }
    bt.set('s4', conn)
    expect(bt.flushQueue('s4')).toBe(3)

    expect(written).toHaveLength(3)
    expect(bt.messageQueues.has('s4')).toBe(false)
  })

  test('flushQueue does nothing without bridge', () => {
    bt.sendOrQueue('s5', { type: 'notification', content: 'x' })
    expect(bt.flushQueue('s5')).toBe(0) // no bridge connected
    expect(bt.messageQueues.get('s5')).toHaveLength(1) // still queued
  })

  test('transfers queued messages to a replacement session', () => {
    bt.sendOrQueue('old', { content: 'queued' })
    expect(bt.transferQueue('old', 'new')).toBe(1)
    expect(bt.messageQueues.get('old')).toBeUndefined()
    expect(bt.messageQueues.get('new')).toEqual([{ content: 'queued' }])
  })

  test('restored pending-continuity queues survive another restart', () => {
    const threadId = 'queue-restart-thread'
    const sessionId = 'queue-restart-source'
    const queueFile = join(STATE_DIR, 'message-queue.json')
    threadRegistry.set(threadId, {
      threadId, topic: 'test', respawnCount: 0, createdAt: Date.now(), lastActive: Date.now(),
      totalMessages: 0, sessionHistory: [], pendingContinuitySessionId: sessionId,
    })
    writeFileSync(queueFile, JSON.stringify({ [sessionId]: [{ content: 'preserve me' }] }))

    const first = new BridgeTransport()
    first.restoreQueues()
    expect(first.messageQueues.get(sessionId)).toEqual([{ content: 'preserve me' }])
    expect(existsSync(queueFile)).toBe(true)
    expect(JSON.parse(readFileSync(queueFile, 'utf8'))[sessionId]).toEqual([{ content: 'preserve me' }])

    const second = new BridgeTransport()
    second.restoreQueues()
    expect(second.messageQueues.get(sessionId)).toEqual([{ content: 'preserve me' }])
    second.messageQueues.clear()
    second.persistQueues()
    threadRegistry.delete(threadId)
  })

  test('disconnect closes socket and removes bridge', () => {
    let ended = false
    const socket = { write() {}, end() { ended = true }, destroyed: false }
    const conn = { sessionId: 's6', socket: socket as any, buf: '' }
    bt.set('s6', conn)
    expect(bt.has('s6')).toBe(true)

    bt.disconnect('s6')
    expect(bt.has('s6')).toBe(false)
    expect(ended).toBe(true)
  })

  test('disconnect is safe when no bridge exists', () => {
    expect(() => bt.disconnect('nonexistent')).not.toThrow()
  })

  test('clear removes all bridges', () => {
    const { socket } = mockSocket()
    bt.set('a', { sessionId: 'a', socket, buf: '' })
    bt.set('b', { sessionId: 'b', socket, buf: '' })
    bt.setTool('c', { sessionId: 'c', socket, buf: '', bridgeRole: 'tool' })
    expect(bt.bridges.size).toBe(2)
    bt.clear()
    expect(bt.bridges.size).toBe(0)
    expect(bt.toolBridges.size).toBe(0)
  })
})
