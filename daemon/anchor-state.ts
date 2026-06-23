import { gateway } from './config.js'

export type AnchorState = 'live' | 'crashed' | 'killed' | 'zombie'

// Lazy import to avoid circular dependency — sessions.ts imports AnchorState from here
let _threadRegistry: { get(id: string): { anchorState: AnchorState | null } | undefined; persist(): void } | null = null
async function getThreadRegistry() {
  if (!_threadRegistry) {
    const mod = await import('./sessions.js')
    _threadRegistry = mod.threadRegistry
  }
  return _threadRegistry!
}

const COUNT_EMOJI = ['2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '👨‍👩‍👦‍👦']

export async function setAnchorState(
  threadId: string,
  state: AnchorState,
  respawnCount?: number,
): Promise<void> {
  const anchor = gateway.getThreadAnchor(threadId)
  if (!anchor) return

  await Promise.allSettled([
    gateway.unreact(anchor.channelId, anchor.messageId, '🚀'),
    gateway.unreact(anchor.channelId, anchor.messageId, '☠️'),
    gateway.unreact(anchor.channelId, anchor.messageId, '💥'),
    gateway.unreact(anchor.channelId, anchor.messageId, '🧟'),
  ])

  switch (state) {
    case 'live':
      await gateway.react(anchor.channelId, anchor.messageId, '🚀')
      break
    case 'killed':
      await gateway.react(anchor.channelId, anchor.messageId, '☠️')
      break
    case 'crashed':
      await gateway.react(anchor.channelId, anchor.messageId, '💥')
      break
    case 'zombie':
      await gateway.react(anchor.channelId, anchor.messageId, '🚀')
      await gateway.react(anchor.channelId, anchor.messageId, '🧟')
      if (respawnCount && respawnCount > 0) {
        const idx = Math.min(respawnCount - 1, COUNT_EMOJI.length - 1)
        await gateway.react(anchor.channelId, anchor.messageId, COUNT_EMOJI[idx])
        if (respawnCount > 1) {
          await gateway.unreact(anchor.channelId, anchor.messageId,
            COUNT_EMOJI[Math.min(respawnCount - 2, COUNT_EMOJI.length - 1)])
        }
      }
      break
  }

  // Co-update ThreadRegistry
  try {
    const tr = await getThreadRegistry()
    const thread = tr.get(threadId)
    if (thread) {
      thread.anchorState = state
      tr.persist()
    }
  } catch {}
}
