import { execSync, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { resolveSocket, sendRequest, shq } from './helpers.js'

type SessionEntry = {
  name: string
  description?: string
  status: string
}

async function getLiveSessions(socketPath: string): Promise<SessionEntry[]> {
  const response = await sendRequest(socketPath, {
    type: 'cli', command: 'list', id: randomUUID(), params: {},
  })
  if (!response.ok) return []
  const data = response.data as SessionEntry[]
  return data.filter(s => s.status === 'connected' || s.status === 'disconnected')
}

function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'pipe' })
    return true
  } catch { return false }
}

function attachReadOnly(name: string): void {
  if (!tmuxSessionExists(name)) {
    console.error(`error: tmux session "${name}" not found`)
    process.exit(1)
  }
  console.log(`\x1b[2m(read-only · detach: ctrl+b d)\x1b[0m`)
  try {
    execSync(`tmux attach-session -t ${shq(name)} -r`, { stdio: 'inherit' })
  } catch {}
}

function buildPeekSession(sessions: SessionEntry[]): void {
  const peekName = 'hydra-peek'

  // Kill existing peek session
  try { execFileSync('tmux', ['kill-session', '-t', peekName], { stdio: 'pipe' }) } catch {}

  // Create peek session with first pane
  const first = sessions[0]
  const attachCmd = (name: string) => `unset TMUX && exec tmux attach-session -t ${shq(name)} -r`

  execFileSync('tmux', ['new-session', '-d', '-s', peekName, '-x', '200', '-y', '50', attachCmd(first.name)], { stdio: 'pipe' })

  // Set pane border to show session names
  execSync(`tmux set-option -t ${shq(peekName)} pane-border-status top`, { stdio: 'pipe' })
  execSync(`tmux set-option -t ${shq(peekName)} pane-border-format ' #{pane_index}: #{pane_title} '`, { stdio: 'pipe' })
  execSync(`tmux select-pane -t ${shq(peekName)} -T ${shq(first.name + (first.description ? ' — ' + first.description : ''))}`, { stdio: 'pipe' })

  // Add remaining sessions as split panes
  for (let i = 1; i < sessions.length; i++) {
    const s = sessions[i]
    execSync(`tmux split-window -t ${shq(peekName)} ${shq(attachCmd(s.name))}`, { stdio: 'pipe' })
    execSync(`tmux select-pane -t ${shq(peekName)} -T ${shq(s.name + (s.description ? ' — ' + s.description : ''))}`, { stdio: 'pipe' })
  }

  // Tiled layout for even distribution
  execSync(`tmux select-layout -t ${shq(peekName)} tiled`, { stdio: 'pipe' })

  // Bind q to kill the peek session (quick exit)
  execSync(`tmux bind-key -T prefix q kill-session -t ${shq(peekName)}`, { stdio: 'pipe' })

  // Attach
  console.log(`\x1b[2m(read-only · ${sessions.length} sessions · switch panes: ctrl+b arrows · detach: ctrl+b d · quit: ctrl+b q)\x1b[0m`)
  try {
    execSync(`tmux attach-session -t ${shq(peekName)}`, { stdio: 'inherit' })
  } catch {}
}

export async function peek(args: string[], daemonName?: string): Promise<void> {
  const socketPath = resolveSocket(daemonName)
  const sessions = await getLiveSessions(socketPath)

  if (sessions.length === 0) {
    console.log('no live sessions')
    process.exit(0)
  }

  // hydra peek <name> — attach to specific session
  let split = false
  const names: string[] = []
  for (const arg of args) {
    if (arg === '--split' || arg === '-s') {
      split = true
    } else {
      names.push(arg)
    }
  }

  if (names.length > 0) {
    const target = sessions.find(s => s.name === names[0])
    if (!target) {
      console.error(`error: no live session named "${names[0]}"`)
      console.error(`live: ${sessions.map(s => s.name).join(', ')}`)
      process.exit(1)
      return
    }
    attachReadOnly(target.name)
    return
  }

  // hydra peek (no args)
  if (sessions.length === 1 && !split) {
    attachReadOnly(sessions[0].name)
    return
  }

  // Multiple sessions: tiled split view
  buildPeekSession(sessions)
}
