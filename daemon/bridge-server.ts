import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'fs'
import { execSync } from 'child_process'
import { createServer, type Socket } from 'net'
import { gateway, SOCK_PATH, STATE_DIR, PLATFORM } from './config.js'
import { registry, threadRegistry } from './sessions.js'
import { transport, type BridgeConn } from './bridge-transport.js'
import { executeTool, computeToolsForSession, MAIN_ONLY_TOOLS, SPAWN_MODEL } from './bridge-dispatch.js'
import { pendingPermissions } from './permission.js'
import { discoverClaudeSessionId } from './session-lifecycle.js'
import { loadAccess } from './access.js'
import { isReviewParticipant, onReviewReply, onParticipantDisconnect, onParticipantReconnect } from './adversarial.js'
import { isBuildParticipant, onBuildReply, onBuildParticipantDisconnect, onBuildParticipantReconnect } from './build.js'
import { isDesignParticipant, onDesignReply, onDesignParticipantDisconnect, onDesignParticipantReconnect } from './design.js'
import { refreshSessionVisual } from './anchor-state.js'
import { handleCLIRequest, type CLIRequest } from './cli-handler.js'
import { watchPr, getWatchesBySession } from './pr-watch.js'
import { shouldHoldIncumbentMain } from './main-guard.js'
import type { ButtonDef } from '../gateway.js'

const DEATH_DETECT_DELAY_MS = 3_000

// ---------------------------------------------------------------------------
// Auto-watch: scan session replies for GitHub PR URLs
// ---------------------------------------------------------------------------

const PR_URL_RE = /https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g

function autoWatchPrUrls(sessionId: string, text: string): void {
  if (!text) return
  const info = registry.get(sessionId)
  if (!info) return

  const urls = text.match(PR_URL_RE)
  if (!urls) return

  const existingWatches = new Set(getWatchesBySession(sessionId).map(w => w.prUrl))

  for (const url of new Set(urls)) {
    if (existingWatches.has(url)) continue

    watchPr(url, sessionId, info.threadId).then(msg => {
      process.stderr.write(`daemon: auto-watch: ${msg}\n`)
      if (!msg.startsWith('already watching')) {
        gateway.send(info.threadId, `_Auto-watching ${url}_`).catch(() => {})
      }
    }).catch(err => {
      process.stderr.write(`daemon: auto-watch failed for ${url}: ${err instanceof Error ? err.message : err}\n`)
    })
  }
}

// ---------------------------------------------------------------------------
// Bridge flap circuit breaker — kill sessions that reconnect too rapidly
// ---------------------------------------------------------------------------

const FLAP_WINDOW_MS = 60_000
const MAIN_COOLDOWN_MS = 10_000
const FLAP_THRESHOLD = 10
const flapTracker = new Map<string, number[]>()

const mainBridge = {
  cycleCount: 0,
  lastConnectedAt: 0,
  lastLoggedAt: 0,
  connect() {
    this.cycleCount++
    this.lastConnectedAt = Date.now()
    if (this.cycleCount === 1) {
      process.stderr.write('daemon: main bridge connected\n')
    } else {
      const uptime = this.lastConnectedAt - (this._lastDisconnectAt || this.lastConnectedAt)
      const now = Date.now()
      if (now - this.lastLoggedAt > 60_000 || this.cycleCount <= 3) {
        process.stderr.write(`daemon: main bridge reconnected (cycle ${this.cycleCount}, last uptime ${Math.round(uptime / 1000)}s)\n`)
        this.lastLoggedAt = now
      }
    }
  },
  disconnect() {
    this._lastDisconnectAt = Date.now()
  },
  _lastDisconnectAt: 0,
}

function trackRegistration(sessionId: string): boolean {
  const now = Date.now()
  const timestamps = flapTracker.get(sessionId) ?? []
  timestamps.push(now)
  const recent = timestamps.filter(t => now - t < FLAP_WINDOW_MS)
  flapTracker.set(sessionId, recent)
  if (recent.length >= FLAP_THRESHOLD) {
    flapTracker.delete(sessionId)
    return true
  }
  return false
}

// Refuse newcomer 'main' bridges until this time once a duplicate-'main' flap is
// detected (see main-guard.ts). 'main' is exempt from the kill path above, so the
// guard holds the incumbent instead.
let duplicateMainCooldownUntil = 0
let duplicateMainIncumbentSocket: import('net').Socket | undefined

// ---------------------------------------------------------------------------
// Bridge protocol handler
// ---------------------------------------------------------------------------

function handleBridgeMessage(conn: BridgeConn, raw: string): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    process.stderr.write(`daemon: invalid JSON from bridge: ${raw.slice(0, 200)}\n`)
    return
  }

  switch (msg.type) {
    case 'register': {
      const sessionId = msg.sessionId as string
      conn.sessionId = sessionId

      const claudeSessionId = msg.claudeSessionId as string | undefined
      const info = registry.get(sessionId)
      if (info) {
        const resolved = claudeSessionId || discoverClaudeSessionId(info.tmuxName)
        if (resolved) {
          info.claudeSessionId = resolved
          registry.persist()

          // Flow claudeSessionId to thread history
          const thread = threadRegistry.get(info.threadId)
          if (thread) {
            const histEntry = thread.sessionHistory.find(h => h.sessionId === sessionId)
            if (histEntry) histEntry.claudeSessionId = resolved
            threadRegistry.persist()
          }
        }
      }

      if (sessionId !== 'main' && trackRegistration(sessionId)) {
        process.stderr.write(`daemon: circuit breaker: ${info?.tmuxName ?? sessionId} flapping (${FLAP_THRESHOLD}+ registrations in ${FLAP_WINDOW_MS / 1000}s) — killing session\n`)
        try { execSync(`tmux kill-session -t '${info?.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {}
        if (info) {
          info.deadAt = Date.now()
          registry.persist()
          void gateway.send(info.threadId, `⚠️ **${info.tmuxName}** killed by circuit breaker — bridge was flapping (${FLAP_THRESHOLD}+ reconnects in ${FLAP_WINDOW_MS / 1000}s). Use \`respawn\` to start fresh.`).catch(() => {})
        }
        try { conn.socket.end() } catch {}
        break
      }

      // Duplicate-'main' guard. The circuit breaker above exempts 'main' (never
      // tmux-kill the control session), but 'main' is the id every bridge defaults
      // to without HYDRA_SESSION_ID — so two byte processes can both claim it and
      // evict each other unboundedly via the socket replacement below. When 'main'
      // flaps, hold the incumbent and refuse the newcomer instead. A single
      // legitimate byte restart (no recent flap) falls through to normal replace.
      if (sessionId === 'main') {
        const incumbent = transport.get('main')
        const hasOtherIncumbent = !!incumbent && incumbent.socket !== conn.socket
        const now = Date.now()

        // Cooldown refusal — do NOT track this registration. Refused
        // registrations must not feed the flap detector, or the guard's own
        // enforcement generates the signal that perpetuates it.
        if (hasOtherIncumbent && now < duplicateMainCooldownUntil) {
          if (duplicateMainIncumbentSocket !== transport.get('main')?.socket) {
            duplicateMainCooldownUntil = 0
            duplicateMainIncumbentSocket = undefined
            process.stderr.write(`daemon: duplicate 'main' cooldown cleared — incumbent died, accepting newcomer\n`)
          } else {
            process.stderr.write(`daemon: duplicate 'main' — cooldown active (${Math.ceil((duplicateMainCooldownUntil - now) / 1000)}s remaining), refusing newcomer\n`)
            try { conn.socket.end() } catch {}
            break
          }
        }

        // Flap detection — only reached by registrations that passed the
        // cooldown check, so the count reflects real registration attempts.
        const flapping = trackRegistration('main')
        if (shouldHoldIncumbentMain({ hasOtherIncumbent, flapping, now, cooldownUntil: duplicateMainCooldownUntil })) {
          duplicateMainCooldownUntil = now + MAIN_COOLDOWN_MS
          duplicateMainIncumbentSocket = transport.get('main')?.socket
          process.stderr.write(`daemon: duplicate 'main' bridge flapping — holding incumbent, refusing newcomer. A second byte/main process is running; kill the extra and keep one.\n`)
          try { conn.socket.end() } catch {}
          break
        }
      }

      const existing = transport.get(sessionId)
      if (existing && existing.socket !== conn.socket) {
        if (sessionId !== 'main') process.stderr.write(`daemon: replacing bridge for session ${sessionId}\n`)
        try { existing.socket.end() } catch {}
      }

      transport.set(sessionId, conn)
      if (sessionId === 'main') flapTracker.delete('main')
      const tools = computeToolsForSession(sessionId)
      transport.sendToBridge(conn, {
        type: 'registered',
        sessionId,
        tools,
        platform: PLATFORM,
        capabilities: info?.capabilities ?? {
          role: sessionId === 'main' ? 'main' : 'worker',
          tools: tools.map(t => t.name),
          model: SPAWN_MODEL,
          cwd: process.env.SPAWN_CWD ?? '(unknown)',
          platform: PLATFORM,
        },
      })
      transport.flushQueue(sessionId)
      if (isReviewParticipant(sessionId)) onParticipantReconnect(sessionId)
      if (isBuildParticipant(sessionId)) onBuildParticipantReconnect(sessionId)
      if (isDesignParticipant(sessionId)) onDesignParticipantReconnect(sessionId)
      if (info && !info.isJoinMember) refreshSessionVisual(info.threadId)
      if (sessionId === 'main') {
        mainBridge.connect()
      } else {
        process.stderr.write(`daemon: bridge registered for session ${sessionId}\n`)
      }
      break
    }

    case 'tool_call': {
      const { id, name, args } = msg as { id: string; name: string; args: Record<string, unknown> }

      if (MAIN_ONLY_TOOLS.has(name) && conn.sessionId !== 'main') {
        transport.sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: [{ type: 'text', text: `${name} is only available to the main session` }],
          isError: true,
        })
        return
      }

      if (conn.sessionId !== 'main') {
        const info = registry.get(conn.sessionId)
        if (info) info.lastActive = Date.now()
      }

      void executeTool(name, args, conn.sessionId).then(result => {
        transport.sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        })

        // Auto-watch: detect PR URLs in session replies
        if (name === 'reply' && !result.isError && conn.sessionId) {
          autoWatchPrUrls(conn.sessionId, args.text as string)
        }

        // Adversarial review: detect reply from any review participant
        if (name === 'reply' && !result.isError && conn.sessionId && isReviewParticipant(conn.sessionId)) {
          onReviewReply(conn.sessionId, args.text as string, args.chat_id as string, result.sentIds ?? [])
        }
        // Build: detect reply from any build participant
        if (name === 'reply' && !result.isError && conn.sessionId && isBuildParticipant(conn.sessionId)) {
          onBuildReply(conn.sessionId, args.text as string, args.chat_id as string, result.sentIds ?? [])
        }
        // Design: detect reply from any design participant
        if (name === 'reply' && !result.isError && conn.sessionId && isDesignParticipant(conn.sessionId)) {
          onDesignReply(conn.sessionId, args.text as string, args.chat_id as string, result.sentIds ?? [])
        }
      }).catch(err => {
        transport.sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: [{ type: 'text', text: `internal error: ${err}` }],
          isError: true,
        })
      })
      break
    }

    case 'permission_response': {
      break
    }

    case 'permission_request': {
      const { request_id, tool_name, description, input_preview } = msg
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const access = loadAccess()
      const text = `Permission: ${tool_name}`
      const buttons: ButtonDef[] = [
        { id: `perm:more:${request_id}`, label: 'See more', style: 'secondary' },
        { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '✅' },
        { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '❌' },
      ]
      for (const userId of access.allowFrom) {
        void gateway.sendDM(userId, text, buttons).catch(e => {
          process.stderr.write(`daemon: permission_request send to ${userId} failed: ${e}\n`)
        })
      }
      break
    }

    case 'cli': {
      void handleCLIRequest(msg as CLIRequest).then(response => {
        conn.socket.write(JSON.stringify(response) + '\n')
      }).catch(err => {
        conn.socket.write(JSON.stringify({
          type: 'cli-response',
          id: msg.id ?? '',
          ok: false,
          error: `internal error: ${err instanceof Error ? err.message : String(err)}`,
        }) + '\n')
      })
      break
    }

    default:
      process.stderr.write(`daemon: unknown message type from bridge: ${msg.type}\n`)
  }
}

// ---------------------------------------------------------------------------
// Session death detection
// ---------------------------------------------------------------------------

async function checkSessionDeath(sessionId: string): Promise<void> {
  if (transport.has(sessionId)) return

  const info = registry.get(sessionId)
  if (!info) return

  let tmuxAlive = false
  try { execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}

  if (!tmuxAlive) {
    process.stderr.write(`daemon: session ${info.tmuxName} crashed (tmux dead, bridge disconnected)\n`)

    const thread = threadRegistry.get(info.threadId)
    if (thread) {
      const histEntry = thread.sessionHistory.find(h => h.sessionId === sessionId && !h.endedAt)
      if (histEntry) {
        histEntry.endedAt = Date.now()
        histEntry.messageCount = info.messageCount ?? 0
        histEntry.claudeSessionId = info.claudeSessionId
      }
      threadRegistry.persist()
    }

    info.deadAt = Date.now()
    registry.persist()

    try {
      await gateway.send(info.threadId, `💀 **${info.tmuxName}** crashed — use \`resume\` to reconnect or \`respawn\` to start fresh.`)
    } catch {}
    refreshSessionVisual(info.threadId, { state: 'crashed' })
  }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

export const socketServer = createServer((socket: Socket) => {
  const conn: BridgeConn = {
    sessionId: '',
    socket,
    buf: '',
  }

  socket.on('data', (data: Buffer) => {
    conn.buf += data.toString()
    let nl: number
    while ((nl = conn.buf.indexOf('\n')) !== -1) {
      const line = conn.buf.slice(0, nl).trim()
      conn.buf = conn.buf.slice(nl + 1)
      if (line) handleBridgeMessage(conn, line)
    }
  })

  socket.on('end', () => {
    if (conn.sessionId) {
      if (conn.sessionId === 'main') {
        mainBridge.disconnect()
      } else {
        process.stderr.write(`daemon: bridge disconnected for session ${conn.sessionId}\n`)
      }
      if (transport.get(conn.sessionId) === conn) {
        transport.delete(conn.sessionId)
      }
      if (conn.sessionId !== 'main') {
        const sid = conn.sessionId
        setTimeout(() => checkSessionDeath(sid), DEATH_DETECT_DELAY_MS)
      }
      // Adversarial review: handle participant disconnect
      if (isReviewParticipant(conn.sessionId)) {
        onParticipantDisconnect(conn.sessionId)
      }
      // Build: handle participant disconnect
      if (isBuildParticipant(conn.sessionId)) {
        onBuildParticipantDisconnect(conn.sessionId)
      }
      // Design: handle participant disconnect
      if (isDesignParticipant(conn.sessionId)) {
        onDesignParticipantDisconnect(conn.sessionId)
      }
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`daemon: bridge socket error: ${err}\n`)
    if (conn.sessionId && transport.get(conn.sessionId) === conn) {
      transport.delete(conn.sessionId)
      if (conn.sessionId !== 'main') {
        const sid = conn.sessionId
        setTimeout(() => checkSessionDeath(sid), DEATH_DETECT_DELAY_MS)
      }
    }
  })
})

export function startBridgeServer(): void {
  // Clean up stale socket and ensure state dir exists — must happen here
  // (not at module level) so the socket probe in daemon.ts can test the
  // incumbent's socket before we delete it.
  try {
    if (existsSync(SOCK_PATH)) {
      unlinkSync(SOCK_PATH)
    }
  } catch {}
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

  socketServer.listen(SOCK_PATH, () => {
    try { chmodSync(SOCK_PATH, 0o700) } catch {}
    process.stderr.write(`daemon: listening on ${SOCK_PATH}\n`)
  })
}
