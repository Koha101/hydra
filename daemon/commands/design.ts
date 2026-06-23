import { gateway } from '../config.js'
import { startDesign, getDesignByThread, cancelDesign } from '../design.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleDesignIntercept(msg: InboundMessage, topic: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🎨').catch(() => {})

  const threadId = msg.channelId

  const existing = getDesignByThread(threadId)
  if (existing) {
    await gateway.send(threadId, `A design session is already in progress in this thread.`, { replyTo: msg.id })
    return
  }

  try {
    await startDesign(threadId, topic)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(threadId, `Design failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelDesignIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const existing = getDesignByThread(msg.channelId)
  if (!existing) {
    await gateway.send(msg.channelId, `No design session in progress.`, { replyTo: msg.id })
    return
  }

  await cancelDesign(msg.channelId)
}
