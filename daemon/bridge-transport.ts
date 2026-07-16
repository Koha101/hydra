import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'net'
import { STATE_DIR } from './config.js'
import { registry, threadRegistry } from './sessions.js'
import { atomicWriteFileSync } from './util.js'
import type { CodexEngine } from './codex-engine.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BridgeConn = {
  sessionId: string
  socket: Socket
  buf: string
  bridgeRole?: 'agent' | 'tool'
  mainCloseRecorded?: boolean // guards double 'error'+'end' from recording twice
}

// ---------------------------------------------------------------------------
// BridgeTransport — owns bridges + messageQueues Maps
// ---------------------------------------------------------------------------

export class BridgeTransport {
  readonly bridges = new Map<string, BridgeConn>()
  readonly toolBridges = new Map<string, BridgeConn>()
  readonly messageQueues = new Map<string, Array<Record<string, unknown>>>()
  private readonly heldSessions = new Set<string>()
  private readonly maxQueueSize = 50
  private readonly queueFile: string
  private codexEngine: CodexEngine | null = null

  constructor() {
    this.queueFile = join(STATE_DIR, 'message-queue.json')
  }

  setCodexEngine(engine: CodexEngine): void {
    this.codexEngine = engine
  }

  get(sessionId: string): BridgeConn | undefined {
    return this.bridges.get(sessionId)
  }

  getTool(sessionId: string): BridgeConn | undefined {
    return this.toolBridges.get(sessionId)
  }

  has(sessionId: string): boolean {
    if (this.bridges.has(sessionId)) return true
    if (this.codexEngine?.isConnected(sessionId)) return true
    return false
  }

  set(sessionId: string, conn: BridgeConn): void {
    this.bridges.set(sessionId, conn)
  }

  setTool(sessionId: string, conn: BridgeConn): void {
    this.toolBridges.set(sessionId, conn)
  }

  delete(sessionId: string): void {
    this.bridges.delete(sessionId)
  }

  deleteTool(sessionId: string): void {
    this.toolBridges.delete(sessionId)
  }

  clear(): void {
    this.bridges.clear()
    this.toolBridges.clear()
    this.heldSessions.clear()
  }

  hold(sessionId: string): void {
    this.heldSessions.add(sessionId)
  }

  release(sessionId: string): void {
    this.heldSessions.delete(sessionId)
    this.flushCodexQueue(sessionId)
    this.flushQueue(sessionId)
  }

  sendToBridge(bridge: BridgeConn, msg: Record<string, unknown>): void {
    try {
      bridge.socket.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to write to bridge ${bridge.sessionId}: ${err}\n`)
    }
  }

  sendOrQueue(sessionId: string, msg: Record<string, unknown>): void {
    if (this.heldSessions.has(sessionId)) {
      this.enqueue(sessionId, msg)
      return
    }

    // Route to Codex engine if this session is connected via codex
    if (this.codexEngine?.isConnected(sessionId)) {
      const content = msg.content
      if (typeof content === 'string' && content) {
        // Enrich with attachment paths so codex can view images/files
        const meta = msg.meta as Record<string, string> | undefined
        const downloadedFiles = meta?.downloaded_files
        let steerText = content
        if (downloadedFiles) {
          steerText += `\n\n[attachments: ${downloadedFiles}]`
        }
        this.codexEngine.steer(sessionId, steerText)
      } else if (content !== undefined) {
        process.stderr.write(`daemon: codex ${sessionId}: non-string content (${typeof content}) dropped: ${JSON.stringify(msg).slice(0, 200)}\n`)
      }
      return
    }

    // Claude path (or disconnected codex session) — send via bridge socket or queue
    const bridge = this.bridges.get(sessionId)
    if (bridge) {
      this.sendToBridge(bridge, msg)
    } else {
      this.enqueue(sessionId, msg)
    }
  }

  flushQueue(sessionId: string): void {
    if (this.heldSessions.has(sessionId)) return
    const queue = this.messageQueues.get(sessionId)
    if (!queue || queue.length === 0) return
    const bridge = this.bridges.get(sessionId)
    if (!bridge) return
    process.stderr.write(`daemon: flushing ${queue.length} queued message(s) for ${sessionId}\n`)
    for (const msg of queue) {
      this.sendToBridge(bridge, msg)
    }
    this.messageQueues.delete(sessionId)
    this.persistQueues()
  }

  flushCodexQueue(sessionId: string): void {
    if (this.heldSessions.has(sessionId)) return
    if (!this.codexEngine?.isConnected(sessionId)) return
    const queue = this.messageQueues.get(sessionId)
    if (!queue || queue.length === 0) return
    this.messageQueues.delete(sessionId)
    this.persistQueues()
    for (const msg of queue) this.sendOrQueue(sessionId, msg)
  }

  transferQueue(fromSessionId: string, toSessionId: string): number {
    const source = this.messageQueues.get(fromSessionId)
    if (!source?.length || fromSessionId === toSessionId) return 0
    const target = this.messageQueues.get(toSessionId) ?? []
    const combined = [...source, ...target].slice(-this.maxQueueSize)
    this.messageQueues.delete(fromSessionId)
    this.messageQueues.set(toSessionId, combined)
    this.persistQueues()
    return source.length
  }

  disconnect(sessionId: string): void {
    const bridge = this.bridges.get(sessionId)
    if (bridge) {
      try { bridge.socket.end() } catch {}
      this.bridges.delete(sessionId)
    }
  }

  persistQueues(): void {
    try {
      const data: Record<string, Array<Record<string, unknown>>> = {}
      for (const [sid, queue] of this.messageQueues) {
        if (queue.length > 0) data[sid] = queue
      }
      if (Object.keys(data).length > 0) {
        atomicWriteFileSync(this.queueFile, JSON.stringify(data) + '\n')
      } else {
        try { unlinkSync(this.queueFile) } catch {}
      }
    } catch (err) {
      process.stderr.write(`daemon: failed to persist message queues: ${err}\n`)
    }
  }

  private enqueue(sessionId: string, msg: Record<string, unknown>): void {
    let queue = this.messageQueues.get(sessionId)
    if (!queue) {
      queue = []
      this.messageQueues.set(sessionId, queue)
    }
    if (queue.length < this.maxQueueSize) {
      queue.push(msg)
      this.persistQueues()
    }
  }

  restoreQueues(): void {
    try {
      const raw = readFileSync(this.queueFile, 'utf8')
      const data = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>
      const pendingContinuityIds = new Set([...threadRegistry.values()]
        .map(thread => thread.pendingContinuitySessionId)
        .filter((sessionId): sessionId is string => !!sessionId))
      let total = 0
      for (const [sid, msgs] of Object.entries(data)) {
        if ((registry.has(sid) || pendingContinuityIds.has(sid)) && msgs.length > 0) {
          this.messageQueues.set(sid, msgs)
          total += msgs.length
        }
      }
      if (total > 0) process.stderr.write(`daemon: restored ${total} queued message(s)\n`)
      this.persistQueues()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load queued messages: ${err}\n`)
      }
    }
  }
}

export const transport = new BridgeTransport()
