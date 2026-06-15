#!/usr/bin/env bun
/**
 * Chat routing daemon — orchestrator.
 *
 * Platform-agnostic message router that holds a single chat gateway connection
 * (Discord or Slack) and routes messages to/from Claude sessions via unix sockets.
 *
 * This file wires the decomposed modules together. Domain logic lives in daemon/.
 */

import { join } from 'path'
import { copyFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'

import { gateway, TOKEN, PLATFORM, STATE_DIR, CLAUDE_CONFIG, SOCK_PATH } from './daemon/config.js'
import { registry } from './daemon/sessions.js'
import { transport } from './daemon/bridge-transport.js'
import { loadAccess } from './daemon/access.js'
import { setupPermissionHandler } from './daemon/permission.js'
import { socketServer } from './daemon/bridge-server.js'
import { announceRestartComplete } from './daemon/commands/global.js'

// Importing router wires up gateway.onMessage / onThreadDelete / onMessageDelete
import './daemon/router.js'

// ---------------------------------------------------------------------------
// Recovery report on reconnect
// ---------------------------------------------------------------------------

if (gateway.onReconnectAfterOutage !== undefined) {
  gateway.onReconnectAfterOutage = (gapMs: number) => {
    const hrs = Math.floor(gapMs / 3_600_000)
    const mins = Math.floor((gapMs % 3_600_000) / 60_000)
    const duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`
    const connected = [...registry.values()].filter(s => transport.has(s.sessionId)).length
    const disconnected = [...registry.values()].filter(s => !transport.has(s.sessionId)).length
    const queuedMsgCount = [...transport.messageQueues.values()].reduce((sum, q) => sum + q.length, 0)
    const report = [
      `**Recovery report** — back online after ${duration} outage`,
      `• Sessions: ${registry.size} total (${connected} connected, ${disconnected} disconnected)`,
      `• Queued messages: ${queuedMsgCount}`,
    ].join('\n')
    const access = loadAccess()
    for (const userId of access.allowFrom) {
      void gateway.sendDM(userId, report).catch(e =>
        process.stderr.write(`daemon: recovery report DM failed: ${e}\n`),
      )
    }
    process.stderr.write(`daemon: sent recovery report (offline ${duration})\n`)
  }
}

// ---------------------------------------------------------------------------
// Permission UI
// ---------------------------------------------------------------------------

setupPermissionHandler(gateway)

// ---------------------------------------------------------------------------
// Bridge sync — keep plugin cache in sync with repo bridge.ts
// ---------------------------------------------------------------------------

try {
  const bridgeSrc = join(import.meta.dir, 'bridge.ts')
  const discordCache = join(CLAUDE_CONFIG, 'plugins', 'cache', 'claude-plugins-official', 'discord')
  const daemonConfig = JSON.stringify({ socket: SOCK_PATH, platform: PLATFORM })
  const versionDirs = readdirSync(discordCache, { withFileTypes: true }).filter(d => d.isDirectory())
  for (const d of versionDirs) {
    const targetDir = join(discordCache, d.name)
    copyFileSync(bridgeSrc, join(targetDir, 'server.ts'))
    writeFileSync(join(targetDir, 'daemon.json'), daemonConfig)
  }
  process.stderr.write(`daemon: synced bridge.ts + daemon.json into ${discordCache}/*/\n`)
} catch (err) {
  process.stderr.write(`daemon: bridge sync skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
}

// ---------------------------------------------------------------------------
// Gateway start & graceful shutdown
// ---------------------------------------------------------------------------

gateway.start(TOKEN!).then(() => {
  process.stderr.write(`daemon: ${PLATFORM} gateway started\n`)
  void announceRestartComplete()
}).catch(err => {
  process.stderr.write(`daemon: gateway start failed: ${err}\n`)
  process.exit(1)
})

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('daemon: shutting down\n')

  transport.persistQueues()
  socketServer.close()
  try { unlinkSync(SOCK_PATH) } catch {}

  for (const [, bridge] of transport.bridges) {
    try { bridge.socket.end() } catch {}
  }
  transport.clear()

  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(gateway.stop()).finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
