/**
 * Codex Engine Bootstrap — initializes the CodexEngine singleton and wires
 * its events into the daemon's protocol dispatch system.
 *
 * Process model is identical to Claude: codex runs in tmux, daemon connects
 * to its unix socket. This module handles the event plumbing.
 */

import { CodexEngine, codexSocketPath } from './codex-engine.js'
import { transport } from './bridge-transport.js'
import { registry, threadRegistry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { dispatchDisconnect } from './protocol-registry.js'
import { appendFileSync } from 'fs'
import { tmuxHasSession, safeSend } from './util.js'
import { buildCodexWorkspaceContext } from './codex-context.js'
import { completePendingContinuityForConnectedSession } from './session-continuity.js'
import { killCodexProcessTree } from './codex-process.js'

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const codexEngine = new CodexEngine()

// Register with transport so sendOrQueue can route to it
transport.setCodexEngine(codexEngine)

export async function replayPendingInitialPrompt(
  info: SessionInfo,
  startTurn: (sessionId: string, prompt: string) => Promise<void> = (sessionId, prompt) => codexEngine.startTurn(sessionId, prompt),
  disconnect: (sessionId: string) => void = sessionId => codexEngine.disconnect(sessionId),
): Promise<boolean> {
  if (!info.pendingInitialPrompt) return true
  try {
    await startTurn(info.sessionId, info.pendingInitialPrompt)
    delete info.pendingInitialPrompt
    registry.persist()
    return true
  } catch (err: any) {
    process.stderr.write(`codex-bootstrap: initial handoff prompt failed for ${info.tmuxName}: ${err?.message || err}\n`)
    try { disconnect(info.sessionId) } catch {}
    return false
  }
}

// ---------------------------------------------------------------------------
// Event wiring — Codex engine events → daemon protocol dispatch
// ---------------------------------------------------------------------------

codexEngine.on('message', (sessionId: string, _text: string) => {
  // Agent text output — update activity tracking only.
  // The agent posts to Discord via the `reply` MCP tool (same as Claude).
  // dispatchReply is triggered by the reply tool call handler in bridge-server.ts.
  const info = registry.get(sessionId)
  if (!info) return
  info.lastActive = Date.now()
})

codexEngine.on('autoApproved', (sessionId: string, method: string) => {
  const info = registry.get(sessionId)
  if (info?.spawnLogPath) {
    try { appendFileSync(info.spawnLogPath, `[${new Date().toISOString()}] auto-approved: ${method}\n`) } catch {}
  }
})

codexEngine.on('turnStalled', (sessionId: string) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `\u26a0\ufe0f Turn stalled (no activity for 20 minutes) — interrupted.`)
})

codexEngine.on('usageWarning', (sessionId: string, usedPercent: number) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `\u26a0\ufe0f Codex usage at **${usedPercent}%** of monthly limit.`)
})

codexEngine.on('disconnected', (sessionId: string) => {
  const info = registry.get(sessionId)
  if (info && !info.deadAt) {
    killCodexProcessTree(info)
    try { Bun.spawnSync(['tmux', 'kill-session', '-t', info.tmuxName], { stdout: 'ignore', stderr: 'ignore' }) } catch {}
    threadRegistry.recordKill(info.threadId, info.sessionId, info.messageCount ?? 0, info.claudeSessionId, info.codexThreadId)
    info.deadAt = Date.now()
    registry.persist()
    if (!info.ephemeral) void safeSend(info.threadId, `⚠️ Codex connection lost for **${info.tmuxName}**. Use \`resume\` to recover the conversation.`)
  }
  dispatchDisconnect(sessionId)
})

// ---------------------------------------------------------------------------
// Reconnection — on daemon startup, reconnect persisted codex sessions
// ---------------------------------------------------------------------------

export async function reconnectCodexSessions(): Promise<void> {
  const codexSessions = [...registry.values()].filter(s => s.engine === 'codex' && !s.deadAt)
  if (codexSessions.length === 0) return

  let reconnected = 0
  for (const info of codexSessions) {
    if (!tmuxHasSession(info.tmuxName)) {
      killCodexProcessTree(info)
      info.deadAt = Date.now()
      continue
    }
    const sockPath = codexSocketPath(info.tmuxName)
    const runtimeConfig = {
      model: info.capabilities?.model === 'codex-default' ? undefined : info.capabilities?.model,
      effort: info.capabilities?.effort,
      developerInstructions: buildCodexWorkspaceContext(process.env.SPAWN_CWD ?? info.capabilities?.cwd ?? process.cwd()) || undefined,
    }
    let connected = false

    // Strategy 1: resume existing thread (preserves conversation)
    if (info.codexThreadId) {
      try {
        await codexEngine.connectAndResume(info.sessionId, sockPath, info.codexThreadId, runtimeConfig)
        connected = true
        process.stderr.write(`codex-bootstrap: reconnected ${info.tmuxName} (resumed)\n`)
      } catch (err: any) {
        process.stderr.write(`codex-bootstrap: resume failed for ${info.tmuxName}: ${err?.message || err}\n`)
        try { codexEngine.disconnect(info.sessionId) } catch {}
        await new Promise(r => setTimeout(r, 2000)) // cooldown before fresh connect
      }
    }

    // Strategy 2: fresh thread (resume failed or no threadId)
    if (!connected) {
      const hadPriorThread = !!info.codexThreadId
      try {
        const result = await codexEngine.connect(info.sessionId, sockPath, runtimeConfig)
        info.codexThreadId = result.threadId
        connected = true
        if (hadPriorThread) {
          void safeSend(info.threadId, `\u26a0\ufe0f Session resumed but conversation history was lost. The agent is starting fresh.`)
        }
        process.stderr.write(`codex-bootstrap: reconnected ${info.tmuxName} (new thread)\n`)
      } catch (err: any) {
        process.stderr.write(`codex-bootstrap: fresh connect failed for ${info.tmuxName}: ${err?.message || err}\n`)
        try { codexEngine.disconnect(info.sessionId) } catch {}
      }
    }

    if (connected) connected = await replayPendingInitialPrompt(info)

    if (!connected) {
      killCodexProcessTree(info)
      try { Bun.spawnSync(['tmux', 'kill-session', '-t', info.tmuxName], { stdout: 'ignore', stderr: 'ignore' }) } catch {}
      info.deadAt = Date.now()
    } else {
      completePendingContinuityForConnectedSession(info.sessionId)
      transport.flushCodexQueue(info.sessionId)
      reconnected++
    }
  }
  registry.persist()
  if (reconnected > 0) process.stderr.write(`codex-bootstrap: reconnected ${reconnected} codex session(s)\n`)
}
