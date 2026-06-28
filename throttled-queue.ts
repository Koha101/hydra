// ---------------------------------------------------------------------------
// ThrottledQueue — generic rate-limit-respecting coalescing queue.
//
// Coalesces by key (latest value wins), drains one item per interval,
// respects priority ordering (high before normal).
// ---------------------------------------------------------------------------

export class ThrottledQueue<V> {
  private queue = new Map<string, { value: V; priority: 'high' | 'normal' }>()
  private draining = false

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

    this.action(nextKey, value).catch(err => {
      process.stderr.write(`throttled-queue: action failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }).finally(() => {
      setTimeout(() => this.drain(), this.drainMs)
    })
  }
}
