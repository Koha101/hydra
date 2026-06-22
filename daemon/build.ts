import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { resolve } from 'path'
import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { getReviewByThread } from './adversarial.js'
import { buildOwnerPrompt } from './prompts/build-owner.js'
import { buildCriticPrompt } from './prompts/build-critic.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

function taskToBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '')
  return `sf/${slug || 'build'}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuildState = {
  buildId: string
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  task: string
  rounds: number
  currentRound: number
  currentTurn: 'owner-planning' | 'owner' | 'critic'
  phase: 'building' | 'complete' | 'cancelled'
  messageIds: string[]
  timeout?: ReturnType<typeof setTimeout>
  _heartbeat?: ReturnType<typeof setInterval>
  _disconnectTimer?: ReturnType<typeof setTimeout>
  worktreeRepo?: string
  worktreePath?: string
  worktreeBranch?: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const builds = new Map<string, BuildState>()
const sessionToBuild = new Map<string, string>()  // critic -> buildId
const ownerToBuild = new Map<string, string>()     // owner -> buildId
const threadToBuild = new Map<string, string>()    // thread -> buildId

const CRITIC_TIMEOUT_MS = 20 * 60 * 1000
const OWNER_TIMEOUT_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getBuildByThread(threadId: string): BuildState | undefined {
  const buildId = threadToBuild.get(threadId)
  return buildId ? builds.get(buildId) : undefined
}

export function isBuildParticipant(sessionId: string): boolean {
  return sessionToBuild.has(sessionId) || ownerToBuild.has(sessionId)
}

// ---------------------------------------------------------------------------
// Start a build
// ---------------------------------------------------------------------------

export async function startBuild(
  ownerThreadId: string,
  ownerSessionId: string,
  rounds: number,
  task?: string,
  worktreeTarget?: string,
): Promise<BuildState> {
  if (threadToBuild.has(ownerThreadId)) {
    throw new Error('A build is already in progress in this thread')
  }
  if (getReviewByThread(ownerThreadId)) {
    throw new Error('A review is in progress in this thread — finish or cancel it first')
  }

  const buildId = randomUUID()
  const shortId = buildId.slice(0, 8)

  // Create worktree if requested
  let worktreeRepo: string | undefined
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined
  if (worktreeTarget) {
    const spawnCwd = process.env.SPAWN_CWD
    if (!spawnCwd) throw new Error('SPAWN_CWD env var is required for worktree builds')
    const repoDir = resolve(spawnCwd, worktreeTarget)

    try {
      execSync(`git -C ${shq(repoDir)} rev-parse --git-dir`, { stdio: 'pipe' })
    } catch {
      throw new Error(`worktree target "${worktreeTarget}" is not a git repo at ${repoDir}`)
    }

    const branch = taskToBranchName(task ?? 'build')
    const wtDir = resolve(repoDir, '..', '.worktrees', `${worktreeTarget}-build-${shortId}`)

    try { execSync(`git -C ${shq(repoDir)} worktree remove ${shq(wtDir)} --force 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} worktree prune 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} branch -D ${shq(branch)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}

    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, wtDir], { stdio: 'pipe' })
      process.stderr.write(`daemon: build worktree created at ${wtDir} (branch ${branch})\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to create build worktree: ${msg}`)
    }

    worktreeRepo = repoDir
    worktreePath = wtDir
    worktreeBranch = branch
  }

  const state: BuildState = {
    buildId,
    ownerThreadId,
    ownerSessionId,
    task: task ?? 'implement the design discussed above',
    rounds,
    currentRound: 1,
    currentTurn: 'owner-planning',
    phase: 'building',
    messageIds: [],
    worktreeRepo,
    worktreePath,
    worktreeBranch,
  }

  builds.set(buildId, state)
  threadToBuild.set(ownerThreadId, buildId)
  ownerToBuild.set(ownerSessionId, buildId)

  try {
    const taskLine = task ? `\nTask: **${task}**` : ''
    const wtLine = worktreePath ? `\nWorktree: \`${worktreePath}\`` : ''
    const ann = await gateway.send(ownerThreadId, [
      `**Build** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `Owner implements, critic reviews.${taskLine}${wtLine}`,
    ].join('\n'))
    state.messageIds.push(ann.id)

    // Tell owner to start implementing
    transport.sendOrQueue(ownerSessionId, {
      type: 'notification',
      content: buildOwnerPrompt({ rounds, task, shortId, worktreePath }),
      meta: { chat_id: ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    // Spawn critic
    await spawnCritic(state)
    resetTimeout(state)
    return state
  } catch (err) {
    builds.delete(buildId)
    threadToBuild.delete(ownerThreadId)
    ownerToBuild.delete(ownerSessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Cancel a build
// ---------------------------------------------------------------------------

export async function cancelBuild(buildId: string): Promise<void> {
  const state = builds.get(buildId)
  if (!state) return

  state.phase = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)
  if (state._heartbeat) clearInterval(state._heartbeat)
  if (state._disconnectTimer) clearTimeout(state._disconnectTimer)

  if (state.criticSessionId) {
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'build cancelled')
    }
    sessionToBuild.delete(state.criticSessionId)
  }

  ownerToBuild.delete(state.ownerSessionId)
  threadToBuild.delete(state.ownerThreadId)
  builds.delete(buildId)
  await gateway.send(state.ownerThreadId, `Build cancelled.`)

  cleanupWorktree(state)
}

// ---------------------------------------------------------------------------
// Core reply handler — called from bridge-server for ALL reply tool calls
// ---------------------------------------------------------------------------

export function onBuildReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  // Check if this is the critic posting
  const memberBuildId = sessionToBuild.get(sessionId)
  if (memberBuildId) {
    const state = builds.get(memberBuildId)
    if (!state || chatId !== state.ownerThreadId) return

    if (state.phase === 'building' && state.currentTurn === 'critic' && state.criticSessionId === sessionId) {
      state.messageIds.push(...sentMessageIds)
      onCriticPosted(state, text)
      return
    }
    return
  }

  // Check if this is the owner posting during a build
  const ownerBuildId = ownerToBuild.get(sessionId)
  if (ownerBuildId) {
    const state = builds.get(ownerBuildId)
    if (!state || chatId !== state.ownerThreadId) return

    if (state.phase !== 'building') return

    // Planning phase — first post is the plan, not relayed to critic
    if (state.currentTurn === 'owner-planning') {
      state.messageIds.push(...sentMessageIds)
      state.currentTurn = 'owner'
      resetTimeout(state)
      return
    }

    if (state.currentTurn !== 'owner') return
    state.messageIds.push(...sentMessageIds)
    onOwnerPosted(state, text)
  }
}

/** Called when a critic bridge disconnects. Grace period before cancel. */
export function onBuildParticipantDisconnect(sessionId: string): void {
  const buildId = sessionToBuild.get(sessionId)
  if (!buildId) return
  const state = builds.get(buildId)
  if (!state) return

  if (state.phase === 'building' && state.criticSessionId === sessionId) {
    if (transport.has(sessionId)) return

    process.stderr.write(`daemon: build critic disconnected — 30s grace period\n`)
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
    state._disconnectTimer = setTimeout(async () => {
      if (transport.has(sessionId)) {
        process.stderr.write(`daemon: build critic reconnected, grace period cleared\n`)
        resetTimeout(state)
        return
      }
      process.stderr.write(`daemon: build critic did not reconnect, cancelling build\n`)
      await cancelBuild(state.buildId)
    }, 30_000)
  }
}

/** Called when a bridge registers — clears disconnect grace period. */
export function onBuildParticipantReconnect(sessionId: string): void {
  const buildId = sessionToBuild.get(sessionId)
  if (!buildId) return
  const state = builds.get(buildId)
  if (!state || !state._disconnectTimer) return
  clearTimeout(state._disconnectTimer)
  state._disconnectTimer = undefined
  resetTimeout(state)
  process.stderr.write(`daemon: build participant ${sessionId} reconnected, grace period cleared\n`)
}

// ---------------------------------------------------------------------------
// Turn handlers
// ---------------------------------------------------------------------------

function onOwnerPosted(state: BuildState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  // Post visible status so the human knows the critic is working
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  void gateway.send(state.ownerThreadId, `_Critic reviewing (${roundLabel})..._`).then(msg => {
    state.messageIds.push(msg.id)
  }).catch(() => {})

  // Push implementation to critic for review
  transport.sendOrQueue(state.criticSessionId!, {
    type: 'notification',
    content: `[Build — Owner Implementation ${roundLabel}]\n\n${text}\n\n---\nReview this implementation. Follow your initial instructions.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'build-owner', user_id: 'system', ts: new Date().toISOString() },
  })

  state.currentTurn = 'critic'
  resetTimeout(state)
}

function onCriticPosted(state: BuildState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  // Check for LGTM — strict first-line check
  const firstLine = text.split('\n')[0].trim()
  const isApproval = firstLine === '**LGTM**' || firstLine === 'LGTM'

  if (isApproval) {
    void finishBuild(state, text).catch(err => {
      process.stderr.write(`daemon: finishBuild failed: ${err}\n`)
      void cancelBuild(state.buildId).catch(() => {})
      void gateway.send(state.ownerThreadId, `Build failed during cleanup: ${err}`).catch(() => {})
    })
    return
  }

  if (state.currentRound >= state.rounds) {
    // Max rounds reached without approval
    void finishBuild(state, text).catch(err => {
      process.stderr.write(`daemon: finishBuild failed: ${err}\n`)
      void cancelBuild(state.buildId).catch(() => {})
    })
    return
  }

  // Push feedback to owner and advance round
  state.currentRound++
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`

  // Post visible status so the human knows it's the builder's turn
  void gateway.send(state.ownerThreadId, `_Critic found issues. Builder's turn to fix (${roundLabel})._`).catch(() => {})

  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `⚠️ **CRITIC FEEDBACK — action required**\n\n${text}\n\n---\nFix these issues, commit, and post your updated summary for ${roundLabel}.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'build-critic', user_id: 'system', ts: new Date().toISOString() },
  })

  state.currentTurn = 'owner'
  resetTimeout(state)
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

async function finishBuild(state: BuildState, lastCriticText: string): Promise<void> {
  // Kill critic
  if (state.criticSessionId) {
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'build complete')
    }
    sessionToBuild.delete(state.criticSessionId)
    state.criticSessionId = undefined
  }

  const firstLine = lastCriticText.split('\n')[0].trim()
  const approved = firstLine === '**LGTM**' || firstLine === 'LGTM'

  completeBuild(state, approved, lastCriticText)
}

function completeBuild(state: BuildState, approved: boolean, lastCriticText: string): void {
  const status = approved
    ? `Critic approved (**LGTM**) after ${state.currentRound} round${state.currentRound > 1 ? 's' : ''}.`
    : `Max rounds reached (${state.rounds}). Critic had remaining concerns.`

  const continueHint = approved ? '' : `\nTo continue with more rounds, type \`build 2\` (or however many rounds you want).`
  const lastFeedback = approved ? '' : `\n\n**Last critic feedback:**\n${lastCriticText.slice(0, 1500)}`

  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `[system] Build complete. ${status}${continueHint}${lastFeedback}`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  // Finalize immediately — no cleanup phase needed since we keep build messages
  state.phase = 'complete'
  ownerToBuild.delete(state.ownerSessionId)
  threadToBuild.delete(state.ownerThreadId)
  builds.delete(state.buildId)
}

// ---------------------------------------------------------------------------
// Worktree cleanup (only on cancel — successful builds keep the worktree)
// ---------------------------------------------------------------------------

function cleanupWorktree(state: BuildState): void {
  if (!state.worktreeRepo || !state.worktreePath) return
  try {
    execSync(`git -C ${shq(state.worktreeRepo)} worktree remove ${shq(state.worktreePath)} --force`, { stdio: 'pipe' })
    process.stderr.write(`daemon: build worktree removed: ${state.worktreePath}\n`)
  } catch (err) {
    process.stderr.write(`daemon: build worktree removal failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  try { execSync(`git -C ${shq(state.worktreeRepo)} worktree prune`, { stdio: 'pipe' }) } catch {}
  if (state.worktreeBranch) {
    try {
      execSync(`git -C ${shq(state.worktreeRepo)} branch -D ${shq(state.worktreeBranch)}`, { stdio: 'pipe' })
      process.stderr.write(`daemon: build branch deleted: ${state.worktreeBranch}\n`)
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnCritic(state: BuildState): Promise<void> {
  const msg = await gateway.send(state.ownerThreadId, `Spawning build critic...`)
  state.messageIds.push(msg.id)

  // Get owner's cwd so critic knows where to find .claude/ directory
  const ownerInfo = registry.get(state.ownerSessionId)
  const ownerCwd = ownerInfo?.capabilities?.cwd

  try {
    const result = await doSpawnSession(`Build CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      promptBuilder: (sessionId, tmuxName) =>
        buildCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, task: state.task, ownerCwd }),
    })

    state.criticSessionId = result.sessionId
    sessionToBuild.set(result.sessionId, state.buildId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: build critic spawn failed: ${msg}\n`)
    await gateway.send(state.ownerThreadId, `Failed to spawn build critic: ${msg}. Build cancelled.`)
    void cancelBuild(state.buildId)
  }
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function resetTimeout(state: BuildState): void {
  if (state.timeout) clearTimeout(state.timeout)
  if (state._heartbeat) clearInterval(state._heartbeat)
  state._heartbeat = undefined

  const whose = state.currentTurn
  const timeoutMs = whose === 'critic' ? CRITIC_TIMEOUT_MS : OWNER_TIMEOUT_MS

  // Heartbeat: check critic is alive + post status every 5 min
  if (whose === 'critic' && state.criticSessionId) {
    const criticId = state.criticSessionId
    let elapsed = 0
    state._heartbeat = setInterval(async () => {
      elapsed += 5
      const criticInfo = registry.get(criticId)
      if (criticInfo) {
        try {
          execSync(`tmux has-session -t '${criticInfo.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
          void gateway.send(state.ownerThreadId, `_Critic still reviewing (${elapsed}m elapsed)..._`).catch(() => {})
        } catch {
          process.stderr.write(`daemon: build critic tmux session died\n`)
          if (state._heartbeat) clearInterval(state._heartbeat)
          await gateway.send(state.ownerThreadId, `Build critic (${criticInfo.tmuxName}) died. Cancelling.`).catch(() => {})
          await cancelBuild(state.buildId)
        }
      }
    }, 5 * 60 * 1000)
  }

  // Find critic's tmux name for the timeout message
  const criticInfo = state.criticSessionId ? registry.get(state.criticSessionId) : undefined
  const criticName = criticInfo?.tmuxName

  state.timeout = setTimeout(async () => {
    if (state._heartbeat) clearInterval(state._heartbeat)
    process.stderr.write(`daemon: build turn timed out (${whose})\n`)
    const debugHint = criticName ? ` Check \`tmux attach -t ${criticName}\` to see what happened.` : ''
    await gateway.send(state.ownerThreadId, `Build timed out waiting for ${whose}.${debugHint} Cancelling.`)
    await cancelBuild(state.buildId)
  }, timeoutMs)
}

