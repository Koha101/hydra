import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { resolveSocket, sendRequest, shq, tmuxExists, tmuxKill } from './helpers.js'

type SessionEntry = {
  name: string
  description?: string
  status: string
}

type PeekDeps = {
  execSync: typeof execSync
  resolveSocket: typeof resolveSocket
  sendRequest: typeof sendRequest
  shq: typeof shq
  tmuxExists: typeof tmuxExists
  tmuxKill: typeof tmuxKill
  exit: (code: number) => void
}

export type PeekOverrides = Partial<PeekDeps>

const defaultDeps: PeekDeps = {
  execSync,
  resolveSocket,
  sendRequest,
  shq,
  tmuxExists,
  tmuxKill,
  exit: code => process.exit(code),
}

const tmux = (cmd: string, deps: PeekDeps) => deps.execSync(cmd, { stdio: 'pipe' })
const tmuxRead = (cmd: string, deps: PeekDeps) => deps.execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

async function getLiveSessions(socketPath: string, deps: PeekDeps): Promise<SessionEntry[]> {
  const response = await deps.sendRequest(socketPath, {
    type: 'cli', command: 'list', id: randomUUID(), params: {},
  })
  if (!response.ok) return []
  const data = response.data as SessionEntry[]
  return data.filter(s => s.status === 'connected' || s.status === 'disconnected')
}

function attachSession(name: string, deps: PeekDeps): void {
  if (!deps.tmuxExists(name)) {
    console.error(`error: tmux session "${name}" not found`)
    deps.exit(1)
    return
  }
  console.log(`\x1b[2m(detach: ctrl+b d)\x1b[0m`)
  try {
    deps.execSync(`tmux attach-session -t ${deps.shq(name)}`, { stdio: 'inherit' })
  } catch {}
}

function buildPeekSession(sessions: SessionEntry[], deps: PeekDeps): void {
  const peekName = 'hydra-peek'
  const p = deps.shq(peekName)

  // Kill existing peek session
  deps.tmuxKill(peekName)

  const windowName = (s: SessionEntry) => s.description ? `${s.name}: ${s.description}` : s.name

  // Create peek session and set window-size so linked windows expand to peek's terminal size
  tmux(`tmux new-session -d -s ${p}`, deps)
  tmux(`tmux set-option -t ${p} window-size largest`, deps)

  // Link each session's window, tracking which ones succeed and their tmux window index
  const linked: Array<{ session: SessionEntry; windowIndex: string }> = []
  for (const s of sessions) {
    if (!deps.tmuxExists(s.name)) continue
    try {
      tmux(`tmux link-window -s ${deps.shq(s.name)}:0 -t ${p}`, deps)
      const idx = tmuxRead(`tmux list-windows -t ${p} -F '#{window_index}' | tail -1`, deps)
      linked.push({ session: s, windowIndex: idx })
    } catch {}
  }

  // Remove the empty initial window (only if we linked at least one)
  if (linked.length > 0) {
    try { tmux(`tmux kill-window -t ${p}:0`, deps) } catch {}
  }

  if (linked.length === 0) {
    deps.tmuxKill(peekName)
    console.log('no live tmux sessions to peek')
    deps.exit(0)
    return
  }

  // Rename windows using the tracked indices (avoids index/name mismatch)
  for (const { session, windowIndex } of linked) {
    try { tmux(`tmux rename-window -t ${p}:${windowIndex} ${deps.shq(windowName(session))}`, deps) } catch {}
  }

  tmux(`tmux set-option -t ${p} allow-rename off`, deps)

  // Set window-size largest on source sessions so shared windows expand
  for (const { session } of linked) {
    try { tmux(`tmux set-option -t ${deps.shq(session.name)} window-size largest`, deps) } catch {}
  }

  // Custom status bar
  tmux(`tmux set-option -t ${p} status-style 'bg=colour235,fg=colour248'`, deps)
  tmux(`tmux set-option -t ${p} status-left '#[fg=colour16,bg=colour214,bold] PEEK #[default] '`, deps)
  tmux(`tmux set-option -t ${p} status-left-length 10`, deps)
  tmux(`tmux set-option -t ${p} status-right ' #[fg=colour248]n/p:switch  w:list  d:exit '`, deps)
  tmux(`tmux set-option -t ${p} status-right-length 30`, deps)
  tmux(`tmux set-option -t ${p} window-status-format ' #[fg=colour248]#W '`, deps)
  tmux(`tmux set-option -t ${p} window-status-current-format ' #[fg=colour214,bold]#W '`, deps)

  // Select first window (most recently active)
  tmux(`tmux select-window -t ${p}:${linked[0].windowIndex}`, deps)

  // Attach and open chooser (filtered to only peek windows)
  // Not using -r (read-only) because it blocks all keybindings including ctrl+b n/p navigation.
  // link-window shares the PTY, but Claude reads from the bridge socket not stdin, so input
  // from the peek client has no effect on agent behavior.
  console.log(`\x1b[2m(${linked.length} sessions · sorted by most recent)\x1b[0m`)
  try {
    deps.execSync(`tmux attach-session -t ${p} \\; choose-tree -wf '#{==:#{session_name},hydra-peek}'`, { stdio: 'inherit' })
  } catch (err) {
    process.stderr.write(`peek: attach failed: ${err instanceof Error ? err.message : String(err)}\n`)
  } finally {
    for (const { session } of linked) {
      try { tmux(`tmux set-option -u -t ${deps.shq(session.name)} window-size`, deps) } catch {}
    }
    deps.tmuxKill(peekName)
  }
}

export async function peek(args: string[], daemonName?: string, overrides: PeekOverrides = {}): Promise<void> {
  const deps: PeekDeps = { ...defaultDeps, ...overrides }
  const socketPath = deps.resolveSocket(daemonName)
  const sessions = await getLiveSessions(socketPath, deps)

  if (sessions.length === 0) {
    console.log('no live sessions')
    deps.exit(0)
    return
  }

  // hydra peek <name> — attach to specific session
  if (args.length > 0) {
    const target = sessions.find(s => s.name === args[0])
    if (!target) {
      console.error(`error: no live session named "${args[0]}"`)
      console.error(`live: ${sessions.map(s => s.name).join(', ')}`)
      deps.exit(1)
      return
    }
    attachSession(target.name, deps)
    return
  }

  // hydra peek (no args) — single session: attach directly, multiple: chooser
  if (sessions.length === 1) {
    attachSession(sessions[0].name, deps)
    return
  }

  buildPeekSession(sessions, deps)
}
