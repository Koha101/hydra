import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'
import { marketplaceName } from '../shared/constants.js'
import { isGoneError } from '../shared/discord-errors.js'

import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG, SOCK_PATH, STATE_DIR } from './config.js'
import { safeSend, formatSpawnLine, tmuxHasSession } from './util.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { SessionInfo, SessionCapabilities, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession } from './bridge-tools.js'
import { extractPhaseBudget } from './util.js'
import { startPhaseBudget, clearPhaseBudget } from './phase-budget.js'
import { isKnownModel, resolveModelAlias, spawnModel } from '../shared/constants.js'
import { buildSpawnPrompt, buildForkPrompt, buildHandoffPrompt, buildResurrectPrompt } from './prompts/session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { unwatchBySession } from './pr-watch.js'
import { completeSessionContinuity, transferSessionContinuity } from './session-continuity.js'
import { loadAccess } from './access.js'
import { codexEngine } from './codex-bootstrap.js'
import { codexSocketPath } from './codex-engine.js'
import { buildCodexWorkspaceContext } from './codex-context.js'
import { applyCodexSpawnMetadata, captureLstart, getDescendants, killCodexProcessTree } from './codex-process.js'

// ---------------------------------------------------------------------------
// Session death events
// ---------------------------------------------------------------------------

export type SessionDeathEvent = {
  sessionId: string
  threadId: string
  wasOwner: boolean
  tmuxName: string
}

export const sessionDeathEmitter = new EventEmitter()

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

function removeOwnedWorktree(ref: { repo: string; path: string; branch: string; name: string }, tmuxName: string): void {
  const cleanupScript = `${ref.path}/bin/dev/on-worktree-remove.sh`
  try {
    execSync(`test -x ${shq(cleanupScript)} && ${shq(cleanupScript)} ${shq(ref.name)}`, { stdio: 'pipe' })
    process.stderr.write(`daemon: ran worktree cleanup hook for ${tmuxName}\n`)
  } catch {}
  try {
    execSync(`git -C ${shq(ref.repo)} worktree remove ${shq(ref.path)} --force`, { stdio: 'pipe' })
    process.stderr.write(`daemon: removed worktree ${ref.path}\n`)
  } catch {
    if (ref.path.includes('/.worktrees/') && existsSync(ref.path)) {
      execSync(`rm -rf ${shq(ref.path)}`, { stdio: 'pipe' })
      process.stderr.write(`daemon: rm -rf worktree ${ref.path} (git remove failed)\n`)
    }
  }
  try { execSync(`git -C ${shq(ref.repo)} worktree prune`, { stdio: 'pipe' }) } catch {}
  try {
    execSync(`git -C ${shq(ref.repo)} branch -D ${shq(ref.branch)}`, { stdio: 'pipe' })
    process.stderr.write(`daemon: deleted branch ${ref.branch}\n`)
  } catch {}
}

// Per-session pane logfile — `tmux pipe-pane` captures each spawn's output so a
// crash still leaves it on disk.

const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

// ---------------------------------------------------------------------------
// Listen state resolution: thread override → channel group → global → false
// ---------------------------------------------------------------------------

export function resolveListenState(threadId: string, channelId?: string): boolean {
  const thread = threadRegistry.get(threadId)
  return resolveListenStatePure(channelId, loadAccess(), thread?.listenOverride, thread?.parentChannelId)
}

export function resolveListenStatePure(
  channelId: string | undefined,
  access: { groups: Record<string, { defaultListen?: boolean }>; defaultListen?: boolean },
  listenOverride?: boolean,
  parentChannelId?: string,
): boolean {
  if (listenOverride !== undefined) return listenOverride
  for (const id of [channelId, parentChannelId]) {
    if (id) {
      const group = access.groups[id]
      if (group?.defaultListen !== undefined) return group.defaultListen
    }
  }
  return access.defaultListen ?? false
}

// ---------------------------------------------------------------------------
// Kill guard
// ---------------------------------------------------------------------------

export const killsInProgress = new Set<string>()

// ---------------------------------------------------------------------------
// Kill session
// ---------------------------------------------------------------------------

export type KillSessionOpts = {
  silent?: boolean
  preserveWorktree?: boolean
  preserveWatches?: boolean
  emitDeath?: boolean
}

export async function killSession(info: SessionInfo, reason: string, opts: KillSessionOpts = {}): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  try {
    // Join members and ephemeral sessions don't own the thread — skip death message and anchor reactions
    if (!opts.silent && !info.isJoinMember && !info.ephemeral) {
      try {
        await gateway.send(info.threadId, `_${reason}_`)
      } catch (err) {
        if (!isGoneError(err)) process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
      }

      refreshSessionVisual(info.threadId, { state: 'killed' })
    }

    // Notify parent session when a child dies (createdAt guard prevents name-recycling mismatch)
    if (!opts.silent && info.originFrom && !info.isJoinMember) {
      const parent = [...registry.values()].find(s => s.tmuxName === info.originFrom && s.createdAt < info.createdAt)
      if (parent) {
        const msgs = info.messageCount ?? 0
        const emoji = sessionEmoji(info.tmuxName)
        void gateway.send(parent.threadId, `${emoji} \`${info.tmuxName}\` died — _${reason}_ (${msgs} msgs)`).catch(err => {
          process.stderr.write(`daemon: failed to notify parent of child death: ${err}\n`)
        })
      }
    }

    // Edit spawn announce to show completion
    if (info.spawnAnnounceId && info.isJoinMember) {
      const elapsed = Math.round((Date.now() - info.createdAt) / 60_000)
      const spawnLine = formatSpawnLine({
        roleLabel: undefined,
        emoji: sessionEmoji(info.tmuxName),
        name: info.tmuxName,
        model: info.capabilities?.model ?? 'unknown',
        trigger: info.originType ?? 'spawn',
        initiator: info.initiator,
      })
      const completionNote = `\n_↳ guest agent in thread_\n_↳ ${reason} after ${elapsed}m_`
      void gateway.edit(info.threadId, info.spawnAnnounceId, spawnLine + completionNote).catch(() => {})
    }

    const tmuxName = info.tmuxName
    if (info.engine === 'codex') {
      try {
        codexEngine.disconnect(info.sessionId)
      } catch {}
      killCodexProcessTree(info)
    }
    try {
      execSync(`tmux kill-session -t ${shq(tmuxName)}`, { stdio: 'pipe' })
    } catch {}

    transport.disconnect(info.sessionId)
    clearPhaseBudget(info.sessionId)

    if (!opts.preserveWorktree && info.worktreePath && info.worktreeRepo) {
      removeOwnedWorktree({
        repo: info.worktreeRepo,
        path: info.worktreePath,
        branch: info.worktreeBranch ?? `wt/${info.tmuxName}`,
        name: info.worktreeName ?? info.tmuxName,
      }, info.tmuxName)
    }

    // Update thread metadata before deleting session
    if (!info.isJoinMember) {
      threadRegistry.recordKill(info.threadId, info.sessionId, info.messageCount ?? 0, info.claudeSessionId, info.codexThreadId ?? info.codexSessionId)
      registry.deleteThread(info.threadId)
    }
    registry.delete(info.sessionId)
    registry.persist()

    if (!opts.preserveWatches) {
      const removedWatches = unwatchBySession(info.sessionId)
      if (removedWatches > 0) {
        process.stderr.write(`daemon: removed ${removedWatches} PR watch(es) for session ${info.sessionId}\n`)
      }
    }

    if (info.isJoinMember) {
      registry.removeMember(info.threadId, info.sessionId)
    }

    if (opts.emitDeath !== false) {
      sessionDeathEmitter.emit('death', {
        sessionId: info.sessionId,
        threadId: info.threadId,
        wasOwner: !info.isJoinMember,
        tmuxName: info.tmuxName,
      } satisfies SessionDeathEvent)
    }

    setTimeout(() => {
      try {
        // Only kill if the tmux session isn't owned by a new session (name recycling)
        const currentOwner = [...registry.values()].find(s => s.tmuxName === tmuxName)
        if (!currentOwner) {
          execSync(`tmux has-session -t "${tmuxName}"`, { stdio: 'pipe' })
          execSync(`tmux kill-session -t ${shq(tmuxName)}`, { stdio: 'pipe' })
          process.stderr.write(`daemon: deferred kill caught lingering tmux session "${tmuxName}"\n`)
        }
      } catch {}
      killsInProgress.delete(info.sessionId)
    }, 3000)
  } catch (err) {
    killsInProgress.delete(info.sessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

/** Unified session creation -- spawn, fork, and handoff all flow through here via SpawnOpts. */
// ---------------------------------------------------------------------------
// Codex spawn helper — tmux setup + engine connect
// ---------------------------------------------------------------------------

async function spawnCodexSession(p: {
  tmuxName: string; sessionId: string; effectiveCwd: string;
  model?: string; effort?: string; forkFromThread?: string; resumeFromThread?: string;
  developerInstructions?: string;
}): Promise<{ sockPath: string; spawnLogPath?: string; codexThreadId: string; codexPaneRoots: Array<{ pid: number; lstart: string }>; codexAppServerPid?: number; codexAppServerLstart?: string }> {
  const sockPath = codexSocketPath(p.tmuxName)
  const codexHomeDir = join(process.env.HOME!, '.codex', `hydra-${p.tmuxName}`)
  const mcpServerPath = join(new URL('.', import.meta.url).pathname, 'codex-mcp-server.ts')
  const requestedModel = p.model && p.model !== 'default' && p.model !== 'codex-default' ? p.model : undefined
  const codexModel = requestedModel ? `-c model=${shq(requestedModel)}` : ''
  const codexEffort = p.effort ? `-c model_reasoning_effort=${shq(p.effort)}` : ''
  const fullPerms = `-c 'sandbox_permissions=["disk-full-read-access","disk-full-write-access","network-full-access"]'`
  const serverCmd = `codex app-server --listen 'unix://' ${codexModel} ${codexEffort} ${fullPerms}`.trim()

  // Window 0: durable app-server
  const serverInner = [
    `cd ${shq(p.effectiveCwd)}`,
    `export CODEX_HOME=${shq(codexHomeDir)}`,
    `mkdir -p ${shq(codexHomeDir)} && chmod 700 ${shq(codexHomeDir)}`,
    `ln -sf ~/.codex/auth.json ${shq(codexHomeDir)}/auth.json`,
    `test -e ${shq(codexHomeDir)}/sessions || ln -s ~/.codex/sessions ${shq(codexHomeDir)}/sessions`,
    `test ! -f ~/.codex/config.toml || cp ~/.codex/config.toml ${shq(codexHomeDir)}/config.toml`,
    `test -e ${shq(codexHomeDir)}/skills || ln -s ~/.codex/skills ${shq(codexHomeDir)}/skills`,
    `codex mcp remove hydra 2>/dev/null; CODEX_HOME=${shq(codexHomeDir)} codex mcp add hydra --env DAEMON_SOCK=${shq(SOCK_PATH)} --env HYDRA_SESSION_ID=${shq(p.sessionId)} -- bun ${shq(mcpServerPath)}`,
    serverCmd,
  ].join(' && ')

  process.stderr.write(`daemon: codex spawning ${p.tmuxName}\n`)
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', p.tmuxName, serverInner], { stdio: 'pipe' })
  } catch (err) {
    throw new Error(`failed to spawn codex tmux: ${err instanceof Error ? err.message : err}`)
  }

  // Capture server pane PID + lstart for process tree cleanup on kill/crash
  const codexPaneRoots: Array<{ pid: number; lstart: string }> = []
  try {
    const pidStr = execSync(`tmux display-message -p -t ${shq(p.tmuxName)}:0 '#{pane_pid}'`, { stdio: 'pipe' }).toString().trim()
    const pid = parseInt(pidStr, 10)
    if (pid) {
      const lstart = captureLstart(pid)
      if (lstart) codexPaneRoots.push({ pid, lstart })
    }
  } catch {}

  const cleanupFailedStartup = () => {
    try { codexEngine.disconnect(p.sessionId) } catch {}
    killCodexProcessTree({ tmuxName: p.tmuxName, codexPaneRoots })
    try { execFileSync('tmux', ['kill-session', '-t', p.tmuxName], { stdio: 'pipe' }) } catch {}
  }

  // Capture server pane for crash diagnostics
  let spawnLogPath: string | undefined
  try {
    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    const logPath = join(SPAWN_LOGS_DIR, `${p.tmuxName}-${p.sessionId}.log`)
    execFileSync('tmux', ['pipe-pane', '-o', '-t', `${p.tmuxName}:0`, `cat >> ${shq(logPath)}`], { stdio: 'pipe' })
    spawnLogPath = logPath
  } catch {}

  // Connect to the app-server socket with retry
  const start = Date.now()
  let codexThreadId: string | null = null
  let lastErr = ''
  while (Date.now() - start < 15_000) {
    try {
      const runtimeConfig = {
        model: requestedModel,
        effort: p.effort,
        developerInstructions: p.developerInstructions,
      }
      if (p.forkFromThread) {
        const r = await codexEngine.connectAndFork(p.sessionId, sockPath, p.forkFromThread, runtimeConfig)
        codexThreadId = r.threadId
      } else if (p.resumeFromThread) {
        await codexEngine.connectAndResume(p.sessionId, sockPath, p.resumeFromThread, runtimeConfig)
        codexThreadId = p.resumeFromThread
      } else {
        const r = await codexEngine.connect(p.sessionId, sockPath, runtimeConfig)
        codexThreadId = r.threadId
      }
      transport.flushCodexQueue(p.sessionId)
      break
    } catch (err: any) {
      lastErr = err?.message || String(err)
      try { codexEngine.disconnect(p.sessionId) } catch {}
      if (!tmuxHasSession(p.tmuxName)) {
        cleanupFailedStartup()
        throw new Error(`codex tmux ${p.tmuxName} died during startup`)
      }
      await new Promise(r => setTimeout(r, 500))
    }
  }
  if (!codexThreadId) {
    cleanupFailedStartup()
    throw new Error(`codex socket not ready after 15s (last: ${lastErr})`)
  }
  process.stderr.write(`daemon: codex connected for ${p.tmuxName}, thread=${codexThreadId}\n`)

  // Attachable TUI — must use `resume` with the daemon's thread ID, not bare
  // `codex --remote` which creates a second thread and duplicate MCP bridge.
  const tuiInner = [
    `export CODEX_HOME=${shq(codexHomeDir)}`,
    `exec codex resume --remote ${shq(`unix://${sockPath}`)} ${shq(codexThreadId)}`,
  ].join(' && ')
  try {
    execFileSync('tmux', ['new-window', '-t', p.tmuxName, '-n', 'codex', tuiInner], { stdio: 'pipe' })
    // Capture TUI pane PID for cleanup
    const tuiPidStr = execSync(`tmux display-message -p -t ${shq(p.tmuxName)}:codex '#{pane_pid}'`, { stdio: 'pipe' }).toString().trim()
    const tuiPid = parseInt(tuiPidStr, 10)
    if (tuiPid) {
      const tuiLstart = captureLstart(tuiPid)
      if (tuiLstart) codexPaneRoots.push({ pid: tuiPid, lstart: tuiLstart })
    }
  } catch {
    process.stderr.write(`daemon: codex TUI window failed for ${p.tmuxName} (non-fatal)\n`)
  }

  // Discover app-server PID from the first pane root's descendant tree
  let codexAppServerPid: number | undefined
  let codexAppServerLstart: string | undefined
  const serverRoot = codexPaneRoots[0]
  if (serverRoot) {
    const descendants = getDescendants(serverRoot.pid)
    for (const d of descendants) {
      try {
        const cmd = execSync(`ps -p ${d} -o args= 2>/dev/null`, { stdio: 'pipe' }).toString().trim()
        if (cmd.includes('codex') && cmd.includes('app-server')) {
          codexAppServerPid = d
          codexAppServerLstart = captureLstart(d)
          break
        }
      } catch {}
    }
  }

  return { sockPath, spawnLogPath, codexThreadId, codexPaneRoots, codexAppServerPid, codexAppServerLstart }
}

// ---------------------------------------------------------------------------
// Main spawn orchestrator
// ---------------------------------------------------------------------------

/** Thread → session pre-registration. A comment in a freshly created spawn thread
 * must queue for the spawning session (delivered when its bridge registers), not
 * fall through to the byte. Entries expire instead of being deleted on every exit
 * path; after registration the live thread mapping wins anyway. */
export const spawnsInFlight = new Map<string, string>()
const SPAWN_IN_FLIGHT_TTL_MS = 180_000 // outlasts worktree creation + codex socket connect + CC boot
function markSpawnInFlight(threadId: string, sessionId: string): void {
  spawnsInFlight.set(threadId, sessionId)
  setTimeout(() => {
    if (spawnsInFlight.get(threadId) === sessionId) spawnsInFlight.delete(threadId)
  }, SPAWN_IN_FLIGHT_TTL_MS)
}

export async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  let threadId: string | undefined
  let anchorMessageId: string | undefined
  let anchorChannelId: string | undefined

  // Parse worktree:repo_name prefix early so it doesn't leak into thread names/prompts
  let worktreeTarget: string | undefined
  topic = topic || 'session'
  const worktreeMatch = topic.match(/^(?:worktree|wt):(\S+)\s+/)
  if (worktreeMatch) {
    worktreeTarget = worktreeMatch[1]
    topic = topic.slice(worktreeMatch[0].length)
  }

  // Parse --phase-budget from the topic (works for every spawn form); an
  // explicit opts value (bridge tool) wins over the inline flag.
  const budgetExtract = extractPhaseBudget(topic)
  topic = budgetExtract.topic || 'session'
  const phaseBudgetMs = opts?.phaseBudgetMs ?? budgetExtract.budgetMs

  const sessionId = randomUUID()
  const tmuxName = registry.pickSessionName()
  const cleanTopic = topic.replace(/\*\*/g, '').replace(/\*/g, '').replace(/[\[\]<>]/g, '').replace(/\s+/g, ' ').trim()
  const threadName = `${sessionEmoji(tmuxName)} ${cleanTopic || tmuxName} · ${tmuxName}`.slice(0, 100)
  const isFork = !!opts?.forkFrom
  const isHandoff = !!opts?.handedOffFrom
  const isResume = !!opts?.resumeFrom
  const isResurrect = !!opts?.resurrectFrom
  const engine = opts?.engine ?? 'claude'
  if (isFork) {
    const sourceId = engine === 'codex' ? opts?.forkFrom?.codexThreadId : opts?.forkFrom?.claudeSessionId
    if (!sourceId) throw new Error(`${engine} fork source conversation ID is required`)
  }
  const originType: 'spawn' | 'fork' | 'handoff' | 'resurrect' = isFork ? 'fork' : isHandoff ? 'handoff' : isResurrect ? 'resurrect' : 'spawn'
  const originFrom = opts?.forkFrom?.parentName ?? opts?.handedOffFrom ?? opts?.resurrectFrom

  if (opts?.existingThreadId) {
    threadId = opts.existingThreadId
  }

  // Join an existing thread as a member (skip thread creation entirely)
  const isJoin = !!opts?.joinThread
  let respawnCount = 0
  if (isJoin) {
    threadId = opts!.joinThread!
  }

  // Determine where to create the thread
  let targetChannelId = chatId
  let parentChannelId: string | undefined
  if (!threadId) {
    if (targetChannelId) {
      try {
        const ch = await gateway.fetchChannel(targetChannelId)
        if (ch.isThread) {
          threadId = ch.id
          parentChannelId = ch.parentId ?? undefined
        } else if (ch.isDM && !gateway.canThreadInDM) {
          targetChannelId = DEFAULT_SESSION_CHANNEL
        }
      } catch {
        targetChannelId = DEFAULT_SESSION_CHANNEL
      }
    } else {
      targetChannelId = DEFAULT_SESSION_CHANNEL
    }

    // Clean up dead session in this thread before spawning
    if (threadId) {
      const staleId = registry.getByThread(threadId)
      if (staleId) {
        const stale = registry.get(staleId)
        if (stale && (!tmuxHasSession(stale.tmuxName) || stale.deadAt)) {
          respawnCount = (stale.respawnCount ?? 0) + 1
          await killSession(stale, 'replaced by new spawn', {
            preserveWorktree: !!stale.worktreePath && stale.worktreePath === opts?.reuseWorktree?.path,
            preserveWatches: stale.sessionId === opts?.replacesSessionId,
          })
        }
      }
    }

    // Create thread if we don't have one yet
    if (!threadId) {
      if (messageId && targetChannelId === chatId) {
        try {
          const thread = await gateway.createThread(targetChannelId!, threadName, {
            messageId,
            archiveDuration: 1440,
          })
          threadId = thread.id
          anchorMessageId = messageId
          anchorChannelId = targetChannelId!
        } catch (err: any) {
          // If thread already exists on this message, join it.
          // Discord thread IDs equal the parent message ID when created via startThread on a message.
          if (err?.code === 'MessageExistingThread') {
            threadId = messageId
            anchorMessageId = messageId
            anchorChannelId = targetChannelId!
            process.stderr.write(`daemon: joined existing thread ${threadId} on message ${messageId}\n`)
          } else if (!isGoneError(err)) {
            process.stderr.write(`daemon: createThread on message failed: ${err}\n`)
          }
        }
      }

      if (!threadId) {
        const anchorText = originFrom
          ? `${threadName} — ${originType} from **${originFrom}**`
          : threadName
        const anchor = await gateway.send(targetChannelId!, anchorText)
        anchorMessageId = anchor.id
        anchorChannelId = targetChannelId!
        const thread = await gateway.createThread(targetChannelId!, threadName, {
          messageId: anchor.id,
          archiveDuration: 1440,
        })
        threadId = thread.id
      }
    }
  }

  // Clean up dead session in this thread before spawning
  // Runs for all paths: existingThreadId, channel lookup, or spawn-in-dead-thread
  if (threadId && !isJoin) {
    const staleId = registry.getByThread(threadId)
    if (staleId) {
      const stale = registry.get(staleId)
      if (stale) {
        let staleAlive = false
        try { execSync(`tmux has-session -t '${stale.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); staleAlive = true } catch {}
        if (!staleAlive || stale.deadAt) {
          respawnCount = (stale.respawnCount ?? 0) + 1
          if (!anchorMessageId && stale.anchorMessageId) {
            anchorMessageId = stale.anchorMessageId
            anchorChannelId = stale.anchorChannelId
          }
          await killSession(stale, 'replaced by new spawn', {
            preserveWorktree: !!stale.worktreePath && stale.worktreePath === opts?.reuseWorktree?.path,
            preserveWatches: stale.sessionId === opts?.replacesSessionId,
          })
        }
      }
    }
    if (!anchorMessageId) {
      const thread = threadRegistry.get(threadId)
      if (thread?.anchorMessageId) {
        anchorMessageId = thread.anchorMessageId
        anchorChannelId = thread.anchorChannelId
      }
    }
  }

  if (!isJoin) markSpawnInFlight(threadId!, sessionId)

  const channelFlag = `plugin:discord@${marketplaceName()}`
  const spawnCwd = process.env.SPAWN_CWD
  if (!spawnCwd) throw new Error('SPAWN_CWD env var is required -- set it to the working directory for spawned sessions')

  let worktreeRepo = opts?.reuseWorktree?.repo
  let worktreePath = opts?.reuseWorktree?.path
  let worktreeBranch = opts?.reuseWorktree?.branch
  let worktreeName = opts?.reuseWorktree?.name
  let createdWorktree = false
  let effectiveCwd = worktreePath ?? spawnCwd
  if (worktreeTarget || opts?.forkWorktreeFrom) {
    const repoName = worktreeTarget ?? basename(opts!.forkWorktreeFrom!.repo)
    const repoDir = worktreeTarget ? resolve(spawnCwd, repoName) : opts!.forkWorktreeFrom!.repo

    // Verify the target is a git repo
    try {
      execSync(`git -C ${shq(repoDir)} rev-parse --git-dir`, { stdio: 'pipe' })
    } catch {
      throw new Error(`worktree target "${repoName}" is not a git repo at ${repoDir}`)
    }

    const wtDir = resolve(repoDir, '..', `.worktrees`, `${repoName}-${tmuxName}`)
    const branch = `wt/${tmuxName}`

    // Clean up stale worktree/branch from previous runs
    try { execSync(`git -C ${shq(repoDir)} worktree remove ${shq(wtDir)} --force 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} worktree prune 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} branch -D ${shq(branch)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}

    let baseRef = opts?.forkWorktreeFrom?.branch
    if (!baseRef) {
      baseRef = 'main'
      try {
        baseRef = execSync(`git -C ${shq(repoDir)} symbolic-ref refs/remotes/origin/HEAD`, { stdio: 'pipe' }).toString().trim().replace('refs/remotes/origin/', '')
      } catch {
        try {
          execSync(`git -C ${shq(repoDir)} rev-parse --verify main`, { stdio: 'pipe' })
        } catch {
          baseRef = 'master'
        }
      }
    }

    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, wtDir, baseRef], { stdio: 'pipe' })
      process.stderr.write(`daemon: created worktree ${wtDir} (branch ${branch}) from ${baseRef}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to create worktree: ${msg}`)
    }

    worktreeRepo = repoDir
    worktreePath = wtDir
    worktreeBranch = branch
    worktreeName = tmuxName
    createdWorktree = true
    effectiveCwd = wtDir

    const claudeJsonPath = join(CLAUDE_CONFIG, '.claude.json')
    try {
      const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
      if (!claudeJson.projects) claudeJson.projects = {}
      const trustEntry = {
        allowedTools: [] as string[],
        mcpContextUris: [] as string[],
        mcpServers: {} as Record<string, unknown>,
        enabledMcpjsonServers: [] as string[],
        disabledMcpjsonServers: [] as string[],
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 0,
      }
      let changed = false
      for (const p of [wtDir, repoDir]) {
        const existing = claudeJson.projects[p]
        if (!existing || !existing.hasClaudeMdExternalIncludesApproved) {
          claudeJson.projects[p] = { ...existing, ...trustEntry }
          changed = true
        }
      }
      if (changed) {
        writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n')
        process.stderr.write(`daemon: pre-approved trust for worktree paths\n`)
      }
    } catch (err) {
      process.stderr.write(`daemon: trust pre-approval failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  const promptParams = { sessionId, tmuxName, threadId: threadId!, topic }
  let prompt: string
  if (opts?.promptBuilder) {
    prompt = opts.promptBuilder(sessionId, tmuxName)
  } else if (isHandoff) {
    prompt = buildHandoffPrompt({ ...promptParams, originFrom: originFrom!, artifact: opts?.artifact })
  } else if (isFork) {
    prompt = buildForkPrompt({ ...promptParams, originFrom: originFrom! })
  } else if (isResurrect) {
    prompt = buildResurrectPrompt(promptParams)
  } else {
    prompt = buildSpawnPrompt(promptParams)
  }

  if (opts?.promptPrefix) {
    prompt = `${opts.promptPrefix}\n\n${prompt}`
  }

  // Central model resolution: alias → full ID → validate. All callers can pass
  // raw aliases (e.g. "sonnet") or full IDs (e.g. "claude-sonnet-4-6[1m]").
  const rawModel = opts?.model
  const model = rawModel ? (resolveModelAlias(rawModel) ?? rawModel) : spawnModel()

  if (engine === 'claude' && !isKnownModel(model)) {
    process.stderr.write(`daemon: unrecognized model ${model} — may be a new release or typo. Spawning anyway.\n`)
    if (threadId) void gateway.send(threadId, `\u26a0\ufe0f Unrecognized model \`${model}\` — may be a new release or typo. Spawning anyway.`).catch(() => {})
  }

  let handoffProvisional = false
  const discardHandoffProvisional = (): void => {
    if (!handoffProvisional) return
    if (registry.getByThread(threadId!) === sessionId) registry.deleteThread(threadId!)
    registry.delete(sessionId)
    registry.persist()
    handoffProvisional = false
  }
  if (isHandoff && !isJoin) {
    const now = Date.now()
    const provisionalCapabilities: SessionCapabilities = {
      role: 'worker',
      tools: [],
      model: engine === 'codex' ? opts?.model ?? 'codex-default' : model,
      ...(engine === 'codex' && opts?.effort && opts.effort !== 'default' ? { effort: opts.effort } : {}),
      cwd: effectiveCwd,
      platform: PLATFORM,
    }
    registry.set(sessionId, {
      sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
      tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom,
      capabilities: provisionalCapabilities, engine,
      threadUrl: threadRegistry.get(threadId!)?.threadUrl,
      ...(worktreeRepo ? { worktreeRepo, worktreePath, worktreeBranch, worktreeName } : {}),
      initiator: opts?.initiator,
      ephemeral: opts?.ephemeral,
      ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
      ...(engine === 'codex' ? { pendingInitialPrompt: prompt } : {}),
    })
    registry.setThread(threadId!, sessionId)
    registry.persist()
    handoffProvisional = true
  }

  // --- Codex engine: spawn in tmux, connect via unix socket ---
  if (engine === 'codex') {
    const requestedEffort = opts?.effort && opts.effort !== 'default' ? opts.effort : undefined
    const workspaceContext = buildCodexWorkspaceContext(spawnCwd)
    let spawned: Awaited<ReturnType<typeof spawnCodexSession>>
    try {
      spawned = await spawnCodexSession({
        tmuxName,
        sessionId,
        effectiveCwd,
        model: opts?.model,
        effort: requestedEffort,
        forkFromThread: opts?.forkFrom?.codexThreadId,
        resumeFromThread: isResume ? opts?.resumeFrom : undefined,
        developerInstructions: workspaceContext || undefined,
      })
    } catch (error) {
      discardHandoffProvisional()
      if (createdWorktree && worktreeRepo && worktreePath) {
        removeOwnedWorktree({ repo: worktreeRepo, path: worktreePath, branch: worktreeBranch!, name: worktreeName! }, tmuxName)
      }
      throw error
    }
    const { codexThreadId } = spawned
    const context = codexEngine.getContext(sessionId)
    const provisional = registry.get(sessionId)
    if (provisional) {
      applyCodexSpawnMetadata(provisional, spawned)
      registry.persist()
    }
    if (isHandoff) {
      try {
        await codexEngine.startTurn(sessionId, prompt)
        if (provisional) {
          delete provisional.pendingInitialPrompt
          registry.persist()
        }
      } catch (error) {
        try { codexEngine.disconnect(sessionId) } catch {}
        if (provisional) killCodexProcessTree(provisional)
        try { Bun.spawnSync(['tmux', 'kill-session', '-t', tmuxName], { stdout: 'ignore', stderr: 'ignore' }) } catch {}
        discardHandoffProvisional()
        throw error
      }
    } else {
      void codexEngine.startTurn(sessionId, prompt).catch(err => {
        process.stderr.write(`daemon: codex startTurn failed for ${tmuxName}: ${err}\n`)
      })
    }

    // SYNC: keep in sync with Claude registration block (~line 655+)
    const now = Date.now()
    const capabilities: SessionCapabilities = {
      role: 'worker',
      tools: [],
      model: context.model ?? opts?.model ?? 'codex-default',
      ...(context.effort ? { effort: context.effort } : {}),
      cwd: effectiveCwd,
      platform: PLATFORM,
    }
    const url = await gateway.getThreadUrl(threadId!)
    const sessionInfo: SessionInfo = {
      sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
      tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, capabilities,
      threadUrl: url || undefined, engine: 'codex',
      ...(respawnCount > 0 ? { respawnCount } : {}),
      ...(worktreeRepo ? { worktreeRepo, worktreePath, worktreeBranch, worktreeName } : {}),
      ...(isJoin ? { isJoinMember: true } : {}),
      initiator: opts?.initiator,
      ephemeral: opts?.ephemeral,
      ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
    }
    applyCodexSpawnMetadata(sessionInfo, spawned)
    registry.set(sessionId, sessionInfo)
    if (phaseBudgetMs) startPhaseBudget(sessionId)
    if (!isJoin) registry.setThread(threadId!, sessionId)
    else registry.addMember(threadId!, sessionId, opts?.memberLabel)
    registry.persist()
    if (opts?.replacesSessionId) {
      transferSessionContinuity(opts.replacesSessionId, sessionId)
    }

    if (!isJoin) {
      threadRegistry.recordSpawn(threadId!, {
        anchorMessageId, threadUrl: url || undefined, topic, respawnCount,
        sessionId, tmuxName, originType, originFrom,
        model: capabilities.model,
        effort: capabilities.effort,
        engine,
        codexThreadId,
        parentChannelId,
        worktreeRepo,
        worktreePath,
        worktreeBranch,
        worktreeName,
      })
    }
    refreshSessionVisual(threadId!, { state: respawnCount > 0 ? 'zombie' : 'live' })

    const spawnLine = formatSpawnLine({
      emoji: sessionEmoji(tmuxName), name: tmuxName, model: capabilities.model,
      trigger: opts?.trigger ?? originType ?? 'spawn',
    })
    const announceIds = await safeSend(threadId!, spawnLine)
    const info = registry.get(sessionId)
    if (info && announceIds.length > 0) { info.spawnAnnounceId = announceIds[0]; registry.persist() }

    return { name: tmuxName, sessionId, threadId: threadId!, url: url || '' }
  }

  // Build claude command — fork adds --resume --fork-session, resume uses --resume without fork
  let claudeArgs: string
  if (isFork) {
    claudeArgs = [
      `claude`,
      `--resume ${shq(opts!.forkFrom!.claudeSessionId!)}`,
      `--fork-session`,
      `--model ${shq(model)}`,
      `--dangerously-skip-permissions`,
      shq(prompt),
      `--channels ${shq(channelFlag)}`,
    ].join(' ')
  } else if (isResume) {
    claudeArgs = [
      `claude`,
      `--resume ${shq(opts!.resumeFrom!)}`,
      `--model ${shq(model)}`,
      `--dangerously-skip-permissions`,
      ...(isHandoff ? [shq(prompt)] : []),
      `--channels ${shq(channelFlag)}`,
    ].join(' ')
  } else {
    claudeArgs = `claude --model ${shq(model)} --dangerously-skip-permissions ${shq(prompt)} --channels ${shq(channelFlag)}`
  }

  // Detached sessions can't unlock the macOS keychain, so auth via a long-lived
  // CLAUDE_CODE_OAUTH_TOKEN (from .env) instead. Written to a file to keep the
  // secret out of the tmux command string; same convention as the byte.
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const tokenFile = join(STATE_DIR, '.byte-token')
  let authExport: string | null = null
  if (oauthToken) {
    try { writeFileSync(tokenFile, oauthToken, { mode: 0o600 }) } catch {}
  }
  // Fall back to the persisted token file so spawns from a launchd-revived daemon (whose
  // env lacks CLAUDE_CODE_OAUTH_TOKEN) still authenticate — same reboot-survival path as byte.
  if (oauthToken || existsSync(tokenFile)) {
    authExport = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shq(tokenFile)})"`
  }
  const inner = [
    `cd ${shq(effectiveCwd)}`,
    `export PATH="$HOME/.bun/bin:$PATH"`,
    authExport,
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    `export CHAT_PLATFORM=${shq(PLATFORM)}`,
    claudeArgs,
  ].filter(Boolean).join(' && ')

  process.stderr.write(`daemon: spawn ${tmuxName}: running tmux new-session\n`)
  process.stderr.write(`daemon: spawn ${tmuxName}: inner cmd = ${inner.slice(0, 300)}...\n`)

  try {
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, inner], { stdio: 'pipe' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn ${tmuxName}: execFileSync FAILED: ${msg}\n`)
    if (createdWorktree && worktreeRepo && worktreePath) {
      removeOwnedWorktree({ repo: worktreeRepo, path: worktreePath, branch: worktreeBranch!, name: worktreeName! }, tmuxName)
    }
    discardHandoffProvisional()
    throw new Error(`failed to spawn tmux session: ${msg}`)
  }

  // Verify the tmux session actually exists after creation
  let tmuxConfirmedAlive = false
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
    process.stderr.write(`daemon: spawn ${tmuxName}: tmux session confirmed alive\n`)
    tmuxConfirmedAlive = true
  } catch {
    process.stderr.write(`daemon: spawn ${tmuxName}: WARNING -- tmux session died immediately after creation\n`)
  }

  // Best-effort: any failure is logged, never fatal to the spawn.
  let spawnLogPath: string | undefined
  if (tmuxConfirmedAlive) {
    try {
      // 0o700: the spawn logs are sensitive by construction (raw pane output).
      // Assert it at the artifact, not only via STATE_DIR's mode.
      mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
      const logPath = join(SPAWN_LOGS_DIR, `${tmuxName}-${sessionId}.log`)
      // Shell string is unavoidable here — `pipe-pane` runs its argument through a
      // shell, so it can't be array-form execFileSync; the path is shq-quoted.
      execFileSync('tmux', ['pipe-pane', '-o', '-t', tmuxName, `cat >> ${shq(logPath)}`], { stdio: 'pipe' })
      spawnLogPath = logPath
      process.stderr.write(`daemon: spawn ${tmuxName}: pane capture -> ${logPath}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: spawn ${tmuxName}: pipe-pane capture setup FAILED (non-fatal): ${msg}\n`)
    }
  }

  const now = Date.now()
  const capabilities: SessionCapabilities = {
    role: 'worker',
    tools: computeToolsForSession(sessionId).map(t => t.name),
    model,
    cwd: effectiveCwd,
    platform: PLATFORM,
  }
  const url = await gateway.getThreadUrl(threadId!)

  registry.set(sessionId, {
    sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
    tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, capabilities,
    threadUrl: url || undefined, engine,
    ...(respawnCount > 0 ? { respawnCount } : {}),
    ...(worktreeRepo ? { worktreeRepo, worktreePath, worktreeBranch, worktreeName } : {}),
    ...(isJoin ? { isJoinMember: true } : {}),
    ...(spawnLogPath ? { spawnLogPath } : {}),
    initiator: opts?.initiator,
    ephemeral: opts?.ephemeral,
    ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
  })
  if (phaseBudgetMs) startPhaseBudget(sessionId)
  // Don't register in threadToSession for join members — owner keeps that mapping
  if (!isJoin) {
    registry.setThread(threadId!, sessionId)
  } else {
    registry.addMember(threadId!, sessionId, opts?.memberLabel)
  }
  registry.persist()
  if (opts?.replacesSessionId) {
    transferSessionContinuity(opts.replacesSessionId, sessionId)
  }

  // Persist thread recovery metadata.
  if (!isJoin) {
    threadRegistry.recordSpawn(threadId!, {
      anchorMessageId,
      threadUrl: url || undefined,
      topic,
      respawnCount,
      sessionId,
      tmuxName,
      originType,
      originFrom,
      model,
      engine,
      parentChannelId,
      worktreeRepo,
      worktreePath,
      worktreeBranch,
      worktreeName,
    })
  }

  refreshSessionVisual(threadId!, { state: respawnCount > 0 ? 'zombie' : 'live' })

  // Deterministic spawn visibility: every tmux announces itself, from the one
  // function all spawn paths share. Echoed to the causing thread when distinct.
  const spawnLine = formatSpawnLine({
    roleLabel: opts?.memberLabel,
    emoji: sessionEmoji(tmuxName),
    name: tmuxName,
    model,
    trigger: opts?.trigger ?? originType,
    initiator: opts?.initiator,
  })
  const guestNote = isJoin ? '\n_↳ guest agent in thread_' : ''
  void safeSend(threadId!, spawnLine + guestNote).then(ids => {
    if (ids.length > 0) {
      const info = registry.get(sessionId)
      if (info) info.spawnAnnounceId = ids[0]
    }
  })
  // Echo to the causing thread — but only when it IS a thread we track
  // (a session or protocol thread). A plain channel already shows the new
  // thread's anchor; echoing there would double-announce.
  if (chatId && chatId !== threadId && (registry.getByThread(chatId) || threadRegistry.get(chatId))) {
    void safeSend(chatId, spawnLine)
  }

  return { name: tmuxName, sessionId, threadId: threadId!, url }
}

// ---------------------------------------------------------------------------
// Recovery primitives — shared by resume/respawn commands and recover cascade
// ---------------------------------------------------------------------------

export const HEALTH_TIMEOUT_MS = 30_000

export function waitForBridge(sessionId: string, timeoutMs: number): Promise<boolean> {
  const ready = () => transport.has(sessionId)
  return new Promise(resolve => {
    if (ready()) { resolve(true); return }
    const interval = setInterval(() => {
      if (ready()) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve(true)
      }
    }, 1_000)
    const timer = setTimeout(() => {
      clearInterval(interval)
      resolve(false)
    }, timeoutMs)
  })
}

export async function assertHealthySpawn(
  result: SpawnResult,
  engine: 'claude' | 'codex',
  opts: { preserveWorktree?: boolean; previousSessionId?: string } = {},
): Promise<void> {
  if (await waitForBridge(result.sessionId, HEALTH_TIMEOUT_MS)) return
  const info = registry.get(result.sessionId)
  if (info) {
    await killSession(info, 'spawn health check failed', {
      silent: true,
      preserveWorktree: opts.preserveWorktree,
      preserveWatches: !!opts.previousSessionId,
      emitDeath: false,
    }).catch(() => {})
  }
  if (opts.previousSessionId) transferSessionContinuity(result.sessionId, opts.previousSessionId)
  throw new Error(`${engine} bridge did not connect`)
}

export async function tryResume(dead: {
  sessionId?: string
  topic: string
  threadId: string
  claudeSessionId?: string
  codexThreadId?: string
  engine?: 'claude' | 'codex'
  threadUrl?: string
  model?: string
  effort?: string
  reuseWorktree?: SpawnOpts['reuseWorktree']
}): Promise<SpawnResult | null> {
  const engine = dead.engine ?? 'claude'
  const resumeId = engine === 'codex' ? dead.codexThreadId : dead.claudeSessionId
  if (!resumeId) return null
  try {
    const result = await doSpawnSession(dead.topic, undefined, undefined, {
      existingThreadId: dead.threadId,
      resumeFrom: resumeId,
      model: dead.model,
      effort: dead.effort,
      engine,
      reuseWorktree: dead.reuseWorktree,
      replacesSessionId: dead.sessionId,
    })
    await assertHealthySpawn(result, engine, {
      preserveWorktree: !!dead.reuseWorktree,
      previousSessionId: dead.sessionId,
    })
    if (dead.sessionId) completeSessionContinuity(dead.threadId, dead.sessionId, result.sessionId)
    transport.sendOrQueue(result.sessionId, {
      type: 'notification',
      content: `[system] You were interrupted by a system crash and have been recovered with full conversation context. Check your thread for any messages you may have missed, and continue where you left off.`,
      meta: { chat_id: dead.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
    return result
  } catch {
    return null
  }
}

export async function tryRespawn(opts: {
  threadId: string
  topic: string
  resurrectFrom?: string
  model?: string
  engine?: 'claude' | 'codex'
  effort?: string
  reuseWorktree?: SpawnOpts['reuseWorktree']
  replacesSessionId?: string
}): Promise<SpawnResult | null> {
  try {
    const result = await doSpawnSession(opts.topic, undefined, undefined, {
      existingThreadId: opts.threadId,
      resurrectFrom: opts.resurrectFrom,
      model: opts.model,
      engine: opts.engine,
      effort: opts.effort,
      reuseWorktree: opts.reuseWorktree,
      replacesSessionId: opts.replacesSessionId,
    })
    await assertHealthySpawn(result, opts.engine ?? 'claude', {
      preserveWorktree: !!opts.reuseWorktree,
      previousSessionId: opts.replacesSessionId,
    })
    if (opts.replacesSessionId) completeSessionContinuity(opts.threadId, opts.replacesSessionId, result.sessionId)
    return result
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Claude session ID discovery
// ---------------------------------------------------------------------------

export function discoverClaudeSessionId(tmuxName: string): string | null {
  try {
    const panePid = execSync(`tmux list-panes -t '${tmuxName}' -F '#{pane_pid}' 2>/dev/null`, { encoding: 'utf8' }).trim()
    if (!panePid) return null
    const childPids = execSync(`pgrep -P ${panePid} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    for (const childPid of childPids) {
      const envOutput = execSync(`ps -E -p ${childPid} 2>/dev/null`, { encoding: 'utf8' })
      if (!envOutput.includes('HYDRA_SESSION_ID')) continue
      const hydraId = envOutput.match(/HYDRA_SESSION_ID=([^\s]+)/)?.[1]
      const candidates = [...envOutput.matchAll(/([A-Z_]*SESSION[A-Z_]*)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)]
      const claudeId = candidates.find(m => m[2] !== hydraId)?.[2]
      if (claudeId) return claudeId
    }
    return null
  } catch {
    return null
  }
}
