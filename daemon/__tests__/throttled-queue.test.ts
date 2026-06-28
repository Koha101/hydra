import { describe, test, expect } from 'bun:test'
import { ThrottledQueue } from '../../throttled-queue.js'

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
    await new Promise(r => setTimeout(r, 5))
    q.enqueue('normal-2', 'badge update', 'normal')
    q.enqueue('high-1', 'session killed', 'high')

    await new Promise(r => setTimeout(r, 200))
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

    q.enqueue('filler', 'filler')
    await new Promise(r => setTimeout(r, 5))
    q.enqueue('thread-1', 'killed', 'high')
    q.enqueue('thread-1', 'still killed', 'normal')
    q.enqueue('thread-2', 'other', 'normal')

    await new Promise(r => setTimeout(r, 200))
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
