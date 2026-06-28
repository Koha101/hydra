import { describe, test, expect } from 'bun:test'

// Re-implement ThrottledQueue here for unit testing (the real one is in
// discord-gateway.ts which pulls in discord.js — too heavy for unit tests)
class ThrottledQueue<V> {
  private queue = new Map<string, { value: V; priority: 'high' | 'normal' }>()
  draining = false
  drained: Array<{ key: string; value: V }> = []

  constructor(
    private action: (key: string, value: V) => Promise<void>,
    private drainMs: number,
  ) {}

  enqueue(key: string, value: V, priority: 'high' | 'normal' = 'normal'): void {
    const existing = this.queue.get(key)
    const effectivePriority = priority === 'high' ? 'high' : (existing?.priority ?? 'normal')
    this.queue.set(key, { value, priority: effectivePriority })
    if (!this.draining) this.drain()
  }

  private drain(): void {
    if (this.queue.size === 0) { this.draining = false; return }
    this.draining = true

    let nextKey: string | undefined
    for (const [key, entry] of this.queue) {
      if (entry.priority === 'high') { nextKey = key; break }
    }
    if (!nextKey) nextKey = this.queue.keys().next().value!
    const { value } = this.queue.get(nextKey)!
    this.queue.delete(nextKey)

    this.action(nextKey, value).catch(() => {}).finally(() => {
      this.drained.push({ key: nextKey!, value })
      setTimeout(() => this.drain(), this.drainMs)
    })
  }

  get pending(): number { return this.queue.size }
}

describe('ThrottledQueue', () => {
  test('processes items in FIFO order', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      results.push(`${key}:${value}`)
    }, 10)

    q.enqueue('a', 'first')
    q.enqueue('b', 'second')
    q.enqueue('c', 'third')

    await new Promise(r => setTimeout(r, 100))
    expect(results).toEqual(['a:first', 'b:second', 'c:third'])
  })

  test('coalesces same key — latest value wins', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (key === 'filler') await new Promise(r => setTimeout(r, 30))
      results.push(`${key}:${value}`)
    }, 10)

    q.enqueue('filler', 'busy')
    await new Promise(r => setTimeout(r, 5))
    q.enqueue('thread-1', 'old name')
    q.enqueue('thread-1', 'new name')
    q.enqueue('thread-1', 'newest name')

    await new Promise(r => setTimeout(r, 200))
    expect(results.filter(r => r.startsWith('thread-1'))).toEqual(['thread-1:newest name'])
  })

  test('high priority items drain before normal', async () => {
    const results: string[] = []
    let gate = false
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (!gate) { gate = true; await new Promise(r => setTimeout(r, 20)) }
      results.push(`${key}:${value}`)
    }, 10)

    q.enqueue('normal-1', 'desc change', 'normal')
    // While normal-1 is in flight, enqueue a high and another normal
    await new Promise(r => setTimeout(r, 5))
    q.enqueue('normal-2', 'badge update', 'normal')
    q.enqueue('high-1', 'session killed', 'high')

    await new Promise(r => setTimeout(r, 200))
    // First item drained was normal-1 (already in flight). After that, high-1 jumps ahead.
    expect(results[0]).toBe('normal-1:desc change')
    expect(results[1]).toBe('high-1:session killed')
    expect(results[2]).toBe('normal-2:badge update')
  })

  test('high priority preserved even if re-enqueued as normal', async () => {
    const results: string[] = []
    let gate = false
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (!gate) { gate = true; await new Promise(r => setTimeout(r, 20)) }
      results.push(value)
    }, 10)

    // Enqueue a filler to keep the queue busy
    q.enqueue('filler', 'filler')
    await new Promise(r => setTimeout(r, 5))
    // Now these get queued while filler is draining
    q.enqueue('thread-1', 'killed', 'high')
    q.enqueue('thread-1', 'still killed', 'normal')
    q.enqueue('thread-2', 'other', 'normal')

    await new Promise(r => setTimeout(r, 200))
    // thread-1 coalesced to latest value but kept high priority, drains before thread-2
    expect(results[1]).toBe('still killed')
    expect(results[2]).toBe('other')
  })

  test('action errors do not stop the drain', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (key === 'bad') throw new Error('fail')
      results.push(value)
    }, 10)

    q.enqueue('bad', 'will fail')
    q.enqueue('good', 'will succeed')

    await new Promise(r => setTimeout(r, 100))
    expect(results).toEqual(['will succeed'])
  })

  test('coalescing across drain cycles', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      results.push(value)
    }, 50)

    q.enqueue('t1', 'v1')
    await new Promise(r => setTimeout(r, 10))
    q.enqueue('t1', 'v2')

    await new Promise(r => setTimeout(r, 150))
    expect(results).toContain('v1')
    expect(results).toContain('v2')
    expect(results.length).toBe(2)
  })
})
