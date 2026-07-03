#!/usr/bin/env bun

import { randomUUID } from 'crypto'
import { resolveSocket, sendRequest, printResponse } from './helpers.js'
import {
  lifecycleUp, lifecycleDown, lifecycleRestart,
  lifecycleWatchdog, lifecyclePreflight,
} from './lifecycle.js'

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const USAGE = `hydra — manage hydra daemons and sessions

Lifecycle:
  hydra up <platform>                  Start daemon + byte
  hydra down <platform>                Stop byte + daemon
  hydra restart <platform>             Restart daemon (picks up code changes)
  hydra watchdog <platform>            Single watchdog tick (for launchd)
  hydra preflight <platform>           Verify deployment is ready

Session management:
  hydra spawn <prompt>                 Spawn a new session
  hydra list                           List active sessions
  hydra status <name>                  Session details
  hydra kill <name>                    Kill a session
  hydra health                         Daemon diagnostics
  hydra clear-key <key>                Clear a stuck idempotency key

Platform: slack | discord (required for lifecycle commands)

Spawn options (required):
  --initiator <name>                   Who triggered this spawn
  --idempotency-key <key>              Prevent duplicate spawns

Global options:
  --daemon <name>                      Target a specific daemon
  --json                               Output raw JSON
  -h, --help                           Show this help
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(USAGE)
    process.exit(0)
  }

  let daemonName: string | undefined
  let json = false
  const filtered: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--daemon' && i + 1 < args.length) {
      daemonName = args[++i]
    } else if (args[i] === '--json') {
      json = true
    } else {
      filtered.push(args[i])
    }
  }

  const command = filtered[0]

  // Lifecycle commands
  if (['up', 'down', 'restart', 'watchdog', 'preflight'].includes(command)) {
    const platform = filtered[1]
    if (!platform) {
      console.error('error: platform is required (e.g. discord, slack)')
      process.exit(1)
    }
    switch (command) {
      case 'up': await lifecycleUp(platform); break
      case 'down': await lifecycleDown(platform); break
      case 'restart': await lifecycleRestart(platform); break
      case 'watchdog': await lifecycleWatchdog(platform); break
      case 'preflight': await lifecyclePreflight(platform); break
    }
    process.exit(0)
  }

  // Session management commands (require running daemon)
  const socketPath = resolveSocket(daemonName)

  switch (command) {
    case 'spawn': {
      let idempotencyKey: string | undefined
      let initiator: string | undefined
      const promptParts: string[] = []

      for (let i = 1; i < filtered.length; i++) {
        if (filtered[i] === '--idempotency-key' && i + 1 < filtered.length) {
          idempotencyKey = filtered[++i]
        } else if (filtered[i] === '--initiator' && i + 1 < filtered.length) {
          initiator = filtered[++i]
        } else {
          promptParts.push(filtered[i])
        }
      }

      const prompt = promptParts.join(' ')
      if (!prompt) {
        console.error('error: prompt is required')
        process.exit(1)
      }
      if (!idempotencyKey) {
        console.error('error: --idempotency-key is required')
        process.exit(1)
      }
      if (!initiator) {
        console.error('error: --initiator is required')
        process.exit(1)
      }

      const response = await sendRequest(socketPath, {
        type: 'cli',
        command: 'spawn',
        id: randomUUID(),
        params: { prompt, idempotencyKey, initiator },
      })
      printResponse(response, json)
      break
    }

    case 'list': {
      const response = await sendRequest(socketPath, {
        type: 'cli', command: 'list', id: randomUUID(), params: {},
      })
      printResponse(response, json)
      break
    }

    case 'status': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath, {
        type: 'cli', command: 'status', id: randomUUID(), params: { name },
      })
      printResponse(response, json)
      break
    }

    case 'kill': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath, {
        type: 'cli', command: 'kill', id: randomUUID(), params: { name },
      })
      printResponse(response, json)
      break
    }

    case 'health': {
      const response = await sendRequest(socketPath, {
        type: 'cli', command: 'health', id: randomUUID(), params: {},
      })
      printResponse(response, json)
      break
    }

    case 'clear-key': {
      const key = filtered[1]
      if (!key) {
        console.error('error: idempotency key required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath, {
        type: 'cli', command: 'clear-key', id: randomUUID(), params: { key },
      })
      printResponse(response, json)
      break
    }

    default:
      console.error(`error: unknown command "${command}"`)
      console.error(USAGE)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`fatal: ${err.message}`)
  process.exit(1)
})
