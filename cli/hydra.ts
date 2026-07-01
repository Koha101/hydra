#!/usr/bin/env bun

import { connect } from 'net'
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'

// ---------------------------------------------------------------------------
// Socket discovery
// ---------------------------------------------------------------------------

function discoverSockets(): Record<string, string> {
  const channelsDir = join(homedir(), '.claude', 'channels')
  const found: Record<string, string> = {}
  try {
    for (const name of readdirSync(channelsDir)) {
      const sockPath = join(channelsDir, name, 'daemon.sock')
      try {
        if (existsSync(sockPath) && statSync(sockPath).isSocket()) {
          found[name] = sockPath
        }
      } catch {}
    }
  } catch {}
  return found
}

function resolveSocket(daemonName?: string): string {
  const discovered = discoverSockets()
  const keys = Object.keys(discovered)

  if (daemonName) {
    if (discovered[daemonName]) return discovered[daemonName]
    console.error(`error: daemon "${daemonName}" not found`)
    console.error(`discovered: ${keys.join(', ') || '(none)'}`)
    process.exit(1)
  }

  if (keys.length === 1) return discovered[keys[0]]
  if (keys.length === 0) {
    console.error('error: no running daemons found')
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
    process.exit(typeof response.exitCode === 'number' ? response.exitCode : 1)
  }

  const data = response.data as any
  const command = response.command as string | undefined

  if (!data) {
    console.log('ok')
    return
  }

  switch (command) {
    case 'list': {
      const items = data as any[]
      if (items.length === 0) { console.log('(none)'); return }
      for (const item of items) {
        const status = item.status === 'connected' ? '●' : '○'
        const ctx = item.context ? ` [${item.context}]` : ''
        console.log(`${status} ${item.name}  ${item.description ?? ''}  (${item.running_for}${ctx})`)
      }
      return
    }
    case 'spawn':
      console.log(`spawned: ${data.name} (${data.sessionId})`)
      if (data.url) console.log(`thread:  ${data.url}`)
      if (data.idempotencyKey) console.log(`key:     ${data.idempotencyKey}`)
      return
    case 'kill':
      console.log(`killed: ${data.killed}`)
      return
    case 'health':
      console.log(`sessions: ${data.sessions.total} (${data.sessions.connected} connected, ${data.sessions.disconnected} disconnected)`)
      console.log(`tmux: ${data.tmux}`)
      console.log(`idempotency: ${data.idempotency.active} active keys`)
      return
    case 'status':
      console.log(`${data.name} (${data.sessionId})`)
      console.log(`  topic:   ${data.topic}`)
      if (data.description) console.log(`  desc:    ${data.description}`)
      console.log(`  bridge:  ${data.bridge}`)
      console.log(`  tmux:    ${data.tmux}`)
      console.log(`  uptime:  ${data.running_for}`)
      if (data.context) console.log(`  context: ${data.context}`)
      if (data.url) console.log(`  url:     ${data.url}`)
      if (data.origin) console.log(`  origin:  ${data.origin}`)
      return
    case 'clear-key':
      console.log(`cleared: ${data.cleared}`)
      return
    default:
      console.log(JSON.stringify(data, null, 2))
  }
}

// ---------------------------------------------------------------------------
// Lifecycle commands — manage daemon/byte processes directly (no socket needed)
// ---------------------------------------------------------------------------

const HYDRA_DIR = join(import.meta.dir, '..')

function requirePlatform(args: string[]): string {
  const p = args[0]
  if (!p) {
    console.error('error: platform is required (e.g. slack, discord)')
    process.exit(1)
  }
  return p
}

function runScript(script: string, env: Record<string, string>): boolean {
  try {
    execFileSync('bash', [join(HYDRA_DIR, script)], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
      cwd: HYDRA_DIR,
    })
    return true
  } catch {
    return false
  }
}

function byteScript(_platform: string): string {
  const script = 'start-byte.sh'
  if (existsSync(join(HYDRA_DIR, script))) return script
  console.error(`error: ${script} not found at ${join(HYDRA_DIR, script)}`)
  process.exit(1)
}

function hasOrphanBytes(platform: string): boolean {
  const sockPath = join(homedir(), '.claude', 'channels', platform, 'daemon.sock')
  try {
    const result = execSync(
      `pgrep -f "claude.*--channels" 2>/dev/null | while read pid; do ps eww -p "$pid" 2>/dev/null | grep -q "DAEMON_SOCK=${sockPath}" && echo found; done`,
      { encoding: 'utf-8', shell: '/bin/bash' },
    )
    return result.includes('found')
  } catch {
    return false
  }
}

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name} 2>/dev/null`)
    return true
  } catch {
    return false
  }
}

async function waitForSocket(platform: string, timeoutMs = 15_000): Promise<boolean> {
  const sockPath = join(homedir(), '.claude', 'channels', platform, 'daemon.sock')
  const start = Date.now()
  process.stdout.write('waiting for socket')
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sockPath)) {
      try {
        if (statSync(sockPath).isSocket()) {
          process.stdout.write(' ready\n')
          return true
        }
      } catch {}
    }
    process.stdout.write('.')
    await Bun.sleep(500)
  }
  process.stdout.write(' timeout\n')
  return false
}

async function lifecycleUp(platform: string): Promise<void> {
  const daemonTmux = `${platform}-daemon`
  const byteTmux = `${platform}-byte`

  const aliveSessions = [daemonTmux, byteTmux].filter(tmuxSessionExists)
  if (aliveSessions.length > 0) {
    console.error(`error: ${platform} is already running (${aliveSessions.join(', ')})`)
    console.error(`use 'hydra restart ${platform}' to restart the daemon, or 'hydra down ${platform}' first`)
    process.exit(1)
  }

  if (hasOrphanBytes(platform)) {
    console.error(`error: orphaned claude processes found for ${platform}`)
    console.error(`run 'hydra down ${platform}' first to clean them up`)
    process.exit(1)
  }

  // Validate byte script exists before starting daemon
  byteScript(platform)

  const stateDir = join(homedir(), '.claude', 'channels', platform)
  const spawnCwd = process.env.SPAWN_CWD ?? join(homedir(), 'Documents', 'angellist')

  console.log(`starting ${platform} daemon...`)
  const daemonOk = runScript('start-daemon.sh', {
    CHAT_PLATFORM: platform,
    HYDRA_STATE_DIR: stateDir,
    SPAWN_CWD: spawnCwd,
  })
  if (!daemonOk) {
    console.error(`error: ${platform} daemon failed to start`)
    process.exit(1)
  }

  if (!await waitForSocket(platform)) {
    console.error(`error: ${platform} daemon socket did not appear`)
    process.exit(1)
  }

  console.log(`starting ${platform} byte...`)
  const byteOk = runScript(byteScript(platform), {
    CHAT_PLATFORM: platform,
    BYTE_CWD: spawnCwd,
    DAEMON_SOCK: join(stateDir, 'daemon.sock'),
  })
  if (!byteOk) {
    console.error(`error: ${platform} byte failed to start`)
    process.exit(1)
  }

  console.log(`${platform} is up`)
}

function lifecycleDown(platform: string): void {
  const daemonTmux = `${platform}-daemon`
  const stateDir = join(homedir(), '.claude', 'channels', platform)

  console.log(`stopping ${platform}...`)
  runScript('stop-byte.sh', {
    CHAT_PLATFORM: platform,
    DAEMON_SOCK: join(stateDir, 'daemon.sock'),
  })

  try { execSync(`tmux kill-session -t ${daemonTmux} 2>/dev/null`) } catch {}

  // Clean up state files so discoverSockets() doesn't show a phantom daemon
  for (const f of ['daemon.sock', 'daemon.pid']) {
    try { unlinkSync(join(stateDir, f)) } catch {}
  }

  console.log(`${platform} is down`)
}

function lifecycleRestart(platform: string): void {
  const stateDir = join(homedir(), '.claude', 'channels', platform)
  const spawnCwd = process.env.SPAWN_CWD ?? join(homedir(), 'Documents', 'angellist')

  console.log(`restarting ${platform} daemon...`)
  const ok = runScript('restart-daemon.sh', {
    CHAT_PLATFORM: platform,
    HYDRA_STATE_DIR: stateDir,
    SPAWN_CWD: spawnCwd,
    TMUX_SESSION: `${platform}-daemon`,
  })
  if (!ok) {
    console.error(`error: ${platform} daemon restart failed`)
    process.exit(1)
  }
  console.log(`${platform} daemon restarted`)
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const USAGE = `hydra — programmatic interface to hydra daemons

Usage:
  hydra up <platform>                  Start daemon + byte
  hydra down <platform>                Stop byte + daemon
  hydra restart <platform>             Restart daemon (picks up code changes)

  hydra spawn <prompt>                 Spawn a new session
  hydra list                           List active sessions
  hydra status <name>                  Session details
  hydra kill <name>                    Kill a session
  hydra health                         Daemon diagnostics
  hydra clear-key <key>                Clear a stuck idempotency key

Platform: slack | discord (required for up/down/restart)

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

  // Lifecycle commands don't need a running daemon
  if (command === 'up' || command === 'down' || command === 'restart') {
    const platform = requirePlatform(filtered.slice(1))
    switch (command) {
      case 'up': lifecycleUp(platform); break
      case 'down': lifecycleDown(platform); break
      case 'restart': lifecycleRestart(platform); break
    }
    process.exit(0)
  }

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
