#!/usr/bin/env bun

import { connect } from 'net'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { parseArgs } from 'util'

// ---------------------------------------------------------------------------
// Config discovery
// ---------------------------------------------------------------------------

type DaemonEntry = { socket: string; label?: string }
type HydraConfig = { default_daemon?: string; daemons: Record<string, DaemonEntry> }

function loadConfig(): HydraConfig | null {
  const paths = [
    join(homedir(), '.config', 'hydra.json'),
    join(homedir(), '.claude', 'hydra.json'),
  ]
  for (const p of paths) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
    } catch {}
  }
  return null
}

function discoverSockets(): Record<string, DaemonEntry> {
  const channelsDir = join(homedir(), '.claude', 'channels')
  const found: Record<string, DaemonEntry> = {}
  try {
    for (const name of readdirSync(channelsDir)) {
      const sockPath = join(channelsDir, name, 'daemon.sock')
      try {
        if (existsSync(sockPath) && statSync(sockPath).isSocket()) {
          found[name] = { socket: sockPath, label: name }
        }
      } catch {}
    }
  } catch {}
  return found
}

function resolveSocket(daemonName?: string): string {
  const config = loadConfig()

  if (config && daemonName) {
    const entry = config.daemons[daemonName]
    if (!entry) {
      console.error(`error: daemon "${daemonName}" not found in config`)
      console.error(`available: ${Object.keys(config.daemons).join(', ')}`)
      process.exit(1)
    }
    return entry.socket.replace('~', homedir())
  }

  if (config) {
    const name = daemonName ?? config.default_daemon
    if (name && config.daemons[name]) {
      return config.daemons[name].socket.replace('~', homedir())
    }
    const keys = Object.keys(config.daemons)
    if (keys.length === 1) return config.daemons[keys[0]].socket.replace('~', homedir())
  }

  const discovered = discoverSockets()
  const keys = Object.keys(discovered)

  if (daemonName) {
    if (discovered[daemonName]) return discovered[daemonName].socket
    console.error(`error: daemon "${daemonName}" not found`)
    console.error(`discovered: ${keys.join(', ') || '(none)'}`)
    process.exit(1)
  }

  if (keys.length === 1) return discovered[keys[0]].socket
  if (keys.length === 0) {
    console.error('error: no running daemons found')
    console.error('start a daemon first, or create ~/.config/hydra.json')
    process.exit(1)
  }

  console.error(`error: multiple daemons found: ${keys.join(', ')}`)
  console.error('use --daemon <name> to select one')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Socket communication
// ---------------------------------------------------------------------------

function sendRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buf = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('connection timed out'))
    }, 10_000)

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n')
    })

    socket.on('data', (data: Buffer) => {
      buf += data.toString()
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        clearTimeout(timeout)
        const line = buf.slice(0, nl)
        socket.end()
        try {
          resolve(JSON.parse(line))
        } catch {
          reject(new Error(`invalid response: ${line.slice(0, 200)}`))
        }
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`socket error: ${err.message}`))
    })

    socket.on('end', () => {
      clearTimeout(timeout)
      if (!buf.trim()) reject(new Error('daemon closed connection without response'))
    })
  })
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResponse(response: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(response, null, 2))
    return
  }

  if (!response.ok) {
    console.error(`error: ${response.error}`)
    process.exit(1)
  }

  const data = response.data as any
  if (!data) {
    console.log('ok')
    return
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('(none)')
      return
    }
    for (const item of data) {
      const status = item.status === 'connected' ? '●' : '○'
      const ctx = item.context ? ` [${item.context}]` : ''
      const src = item.cliSource ? ` via:${item.cliSource}` : ''
      console.log(`${status} ${item.name}  ${item.description ?? ''}  (${item.running_for}${ctx}${src})`)
    }
    return
  }

  if (data.sessionId) {
    console.log(`spawned: ${data.name} (${data.sessionId})`)
    if (data.url) console.log(`thread:  ${data.url}`)
    if (data.idempotencyKey) console.log(`key:     ${data.idempotencyKey}`)
    return
  }

  if (data.killed) {
    console.log(`killed: ${data.killed}`)
    return
  }

  if (data.sessions) {
    console.log(`sessions: ${data.sessions.total} (${data.sessions.connected} connected, ${data.sessions.disconnected} disconnected)`)
    console.log(`tmux: ${data.tmux}`)
    console.log(`idempotency: ${data.idempotency.active} active keys`)
    return
  }

  if (data.name && data.bridge) {
    console.log(`${data.name} (${data.sessionId})`)
    console.log(`  topic:   ${data.topic}`)
    if (data.description) console.log(`  desc:    ${data.description}`)
    console.log(`  bridge:  ${data.bridge}`)
    console.log(`  tmux:    ${data.tmux}`)
    console.log(`  uptime:  ${data.running_for}`)
    if (data.context) console.log(`  context: ${data.context}`)
    if (data.url) console.log(`  url:     ${data.url}`)
    return
  }

  console.log(JSON.stringify(data, null, 2))
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const USAGE = `hydra — programmatic interface to hydra daemons

Usage:
  hydra spawn <prompt>                 Spawn a new session
  hydra list                           List active sessions
  hydra status <name>                  Session details
  hydra kill <name>                    Kill a session
  hydra health                         Daemon diagnostics
  hydra clear-key <key>                Clear a stuck idempotency key

Spawn options:
  --purpose <name>                     Semantic label for the session
  --idempotency-key <key>              Prevent duplicate spawns
  --auth-source <source>               Auth source (validated by daemon)
  --timeout <minutes>                  Auto-kill after timeout

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
  const socketPath = resolveSocket(daemonName)

  switch (command) {
    case 'spawn': {
      let purpose: string | undefined
      let idempotencyKey: string | undefined
      let authSource: string | undefined
      let timeoutMinutes: number | undefined
      const promptParts: string[] = []

      for (let i = 1; i < filtered.length; i++) {
        if (filtered[i] === '--purpose' && i + 1 < filtered.length) {
          purpose = filtered[++i]
        } else if (filtered[i] === '--idempotency-key' && i + 1 < filtered.length) {
          idempotencyKey = filtered[++i]
        } else if (filtered[i] === '--auth-source' && i + 1 < filtered.length) {
          authSource = filtered[++i]
        } else if (filtered[i] === '--timeout' && i + 1 < filtered.length) {
          timeoutMinutes = parseInt(filtered[++i], 10)
        } else {
          promptParts.push(filtered[i])
        }
      }

      const prompt = promptParts.join(' ')
      if (!prompt) {
        console.error('error: prompt is required')
        console.error('usage: hydra spawn "your prompt here"')
        process.exit(1)
      }

      const response = await sendRequest(socketPath, {
        type: 'cli',
        command: 'spawn',
        id: randomUUID(),
        authSource,
        params: { prompt, purpose, idempotencyKey, timeoutMinutes },
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
