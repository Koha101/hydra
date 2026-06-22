import { execSync, execFileSync } from 'child_process'
import { resolve } from 'path'
import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress, sessionDeathEmitter } from './session-lifecycle.js'
import type { SessionDeathEvent } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { getReviewByThread } from './adversarial.js'
import { buildOwnerPrompt } from './prompts/build-owner.js'
import { buildCriticPrompt } from './prompts/build-critic.js'
import { createStateMachine } from './state-machine.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

export function taskToBranchName(task: string): string {
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

export type BuildPhase =
  | 'implementing'   // waiting for owner implementation summary
  | 'reviewing'      // waiting for critic review
  | 'complete'
  | 'cancelled'

export type BuildState = {
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  task: string
  rounds: number
  currentRound: number
  phase: BuildPhase
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

const builds = new Map<string, BuildState>()           // ownerThreadId → state
const activeParticipants = new Set<string>()            // O(1) sessionId membership check

const CRITIC_TIMEOUT_MS = 20 * 60 * 1000
const OWNER_TIMEOUT_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type BuildEvent = 'owner_impl' | 'critic_lgtm' | 'critic_feedback' | 'timeout' | 'cancel'

const buildMachine = createStateMachine<BuildPhase, BuildEvent>('build', {
  implementing: { owner_impl: 'reviewing',    timeout: 'cancelled', cancel: 'cancelled' },
  reviewing:    { critic_lgtm: 'complete', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' },
  complete:     {},
  cancelled:    {},
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findBuildBySession(sessionId: string): { state: BuildState; role: 'owner' | 'critic' } | null {
  for (const state of builds.values()) {
    if (state.phase === 'complete' || state.phase === 'cancelled') continue
    if (state.criticSessionId === sessionId) return { state, role: 'critic' }
    if (state.ownerSessionId === sessionId) return { state, role: 'owner' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getActiveBuilds(): BuildState[] {
  return [...builds.values()].filter(b => b.phase !== 'complete' && b.phase !== 'cancelled')
}

export function getBuildByThread(threadId: string): BuildState | undefined {
  return builds.get(threadId)
}

export function isBuildParticipant(sessionId: string): boolean {
  return activeParticipants.has(sessionId)
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
  if (builds.has(ownerThreadId)) {
    throw new Error('A build is already in progress in this thread')
  }
  if (getReviewByThread(ownerThreadId)) {
    throw new Error('A review is in progress in this thread — finish or cancel it first')
  }

  const shortId = Math.random().toString(36).slice(2, 10)

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
    ownerThreadId,
    ownerSessionId,
    task: task ?? 'implement the design discussed above',
    rounds,
    currentRound: 1,
    phase: 'implementing',
    messageIds: [],
    worktreeRepo,
    worktreePath,
    worktreeBranch,
  }

  builds.set(ownerThreadId, state)
  activeParticipants.add(ownerSessionId)

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

    // Critic spawns later — after owner posts implementation summary
    resetTimeout(state)
    return state
  } catch (err) {
    cleanupState(state)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Cancel a build
// ---------------------------------------------------------------------------

export async function cancelBuild(threadId: string): Promise<void> {
  const state = builds.get(threadId)
  if (!state) return

  state.phase = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)
  if (state._heartbeat) clearInterval(state._heartbeat)
  if (state._disconnectTimer) clearTimeout(state._disconnectTimer)

  try {
    if (state.criticSessionId) {
      const info = registry.get(state.criticSessionId)
      if (info && !killsInProgress.has(state.criticSessionId)) {
        await killSession(info, 'build cancelled')
      }
    }
  } catch (err) {
    process.stderr.write(`daemon: build cancel killSession failed: ${err}\n`)
  } finally {
    cleanupState(state)
  }

  await gateway.send(state.ownerThreadId, `Build cancelled.`)

  cleanupWorktree(state)
}

// ---------------------------------------------------------------------------
// Core reply handler — called from bridge-server for ALL reply tool calls
// ---------------------------------------------------------------------------

export function onBuildReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  const found = findBuildBySession(sessionId)
  if (!found) return

  const { state, role } = found
  if (chatId !== state.ownerThreadId) return

  if (role === 'critic') {
    if (state.criticSessionId !== sessionId) return

    const firstLine = text.split('\n')[0].trim()
    const isLgtm = firstLine === '**LGTM**' || firstLine === 'LGTM'
    const event: BuildEvent = isLgtm ? 'critic_lgtm' : 'critic_feedback'
    const result = buildMachine.transition(state.phase, event)
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    if (isLgtm) {
      void finishBuild(state, text).catch(err => {
        process.stderr.write(`daemon: finishBuild failed: ${err}\n`)
        void cancelBuild(state.ownerThreadId).catch(() => {})
      })
    } else if (state.currentRound >= state.rounds) {
      void finishBuild(state, text).catch(err => {
        process.stderr.write(`daemon: finishBuild failed: ${err}\n`)
        void cancelBuild(state.ownerThreadId).catch(() => {})
      })
    } else {
      state.phase = result.to
      state.currentRound++
      onCriticFeedback(state, text)
    }
    return
  }

  // Owner posting during a build
  if (role === 'owner') {
    const result = buildMachine.transition(state.phase, 'owner_impl')
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    state.phase = result.to
    onOwnerPosted(state, text)
  }
}

/** Called when a critic bridge disconnects. Grace period before cancel. */
export function onBuildParticipantDisconnect(sessionId: string): void {
  const found = findBuildBySession(sessionId)
  if (!found || found.role !== 'critic') return
  const state = found.state

  if (state.phase === 'reviewing' && state.criticSessionId === sessionId) {
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
      await cancelBuild(state.ownerThreadId)
    }, 30_000)
  }
}

/** Called when a bridge registers — clears disconnect grace period. */
export function onBuildParticipantReconnect(sessionId: string): void {
  const found = findBuildBySession(sessionId)
  if (!found || found.role !== 'critic') return
  const state = found.state
  if (!state._disconnectTimer) return
  clearTimeout(state._disconnectTimer)
  state._disconnectTimer = undefined
  resetTimeout(state)
  process.stderr.write(`daemon: build participant ${sessionId} reconnected, grace period cleared\n`)
}

// ---------------------------------------------------------------------------
// Death emitter — handle unexpected critic kills
// ---------------------------------------------------------------------------

sessionDeathEmitter.on('death', (event: SessionDeathEvent) => {
  if (event.wasOwner) return
  const found = findBuildBySession(event.sessionId)
  if (!found || found.role !== 'critic') return
  const state = found.state

  if (state.phase === 'complete' || state.phase === 'cancelled') return

  process.stderr.write(`daemon: build critic ${event.sessionId} died unexpectedly, cancelling build\n`)
  void cancelBuild(state.ownerThreadId).catch(err => {
    process.stderr.write(`daemon: build cancel after death failed: ${err}\n`)
  })
})

// ---------------------------------------------------------------------------
// Turn handlers
// ---------------------------------------------------------------------------

function onOwnerPosted(state: BuildState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`

  // Post visible status
  void gateway.send(state.ownerThreadId, `_Critic reviewing (${roundLabel})..._`).then(msg => {
    state.messageIds.push(msg.id)
  }).catch(() => {})

  // Phase already set to 'reviewing' by the dispatcher
  if (!state.criticSessionId) {
    // First round — spawn critic with the implementation text as context
    void spawnCritic(state, text).catch(err => {
      process.stderr.write(`daemon: build: critic spawn failed in onOwnerPosted: ${err}\n`)
      void cancelBuild(state.ownerThreadId).catch(() => {})
    })
  } else {
    // Subsequent rounds — relay to existing critic
    transport.sendOrQueue(state.criticSessionId, {
      type: 'notification',
      content: `[Build — Owner Implementation ${roundLabel}]\n\n${text}\n\n---\nReview this implementation. Follow your initial instructions.`,
      meta: { chat_id: state.ownerThreadId, message_id: '', user: 'build-owner', user_id: 'system', ts: new Date().toISOString() },
    })
    resetTimeout(state)
  }
}

function onCriticFeedback(state: BuildState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`

  // Post visible status so the human knows it's the builder's turn
  void gateway.send(state.ownerThreadId, `_Critic found issues. Builder's turn to fix (${roundLabel})._`).catch(() => {})

  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `⚠️ **CRITIC FEEDBACK — action required**\n\n${text}\n\n---\nFix these issues, commit, and post your updated summary for ${roundLabel}.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'build-critic', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(state)
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

async function finishBuild(state: BuildState, lastCriticText: string): Promise<void> {
  // Kill critic
  if (state.criticSessionId) {
    activeParticipants.delete(state.criticSessionId)
    try {
      const info = registry.get(state.criticSessionId)
      if (info && !killsInProgress.has(state.criticSessionId)) {
        await killSession(info, 'build complete')
      }
    } catch (err) {
      process.stderr.write(`daemon: build finishBuild killSession failed: ${err}\n`)
    }
    state.criticSessionId = undefined
  }

  const firstLine = lastCriticText.split('\n')[0].trim()
  const approved = firstLine === '**LGTM**' || firstLine === 'LGTM'

  completeBuild(state, approved, lastCriticText)
}

function completeBuild(state: BuildState, approved: boolean, lastCriticText: string): void {
  process.stderr.write(`daemon: build: complete (approved=${approved}, rounds=${state.currentRound}/${state.rounds})\n`)
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

  // Finalize — keep build messages (they're the work product)
  state.phase = 'complete'
  cleanupState(state)
}

// ---------------------------------------------------------------------------
// State cleanup
// ---------------------------------------------------------------------------

function cleanupState(state: BuildState): void {
  if (state.criticSessionId) activeParticipants.delete(state.criticSessionId)
  activeParticipants.delete(state.ownerSessionId)
  builds.delete(state.ownerThreadId)
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

async function spawnCritic(state: BuildState, implementationText: string): Promise<void> {
  const statusMsg = await gateway.send(state.ownerThreadId, `Spawning build critic...`)
  state.messageIds.push(statusMsg.id)

  // Get owner's cwd so critic knows where to find .claude/ directory
  const ownerInfo = registry.get(state.ownerSessionId)
  const ownerCwd = ownerInfo?.capabilities?.cwd

  try {
    const result = await doSpawnSession(`Build CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      memberLabel: 'build-critic',
      promptBuilder: (sessionId, tmuxName) =>
        buildCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, task: state.task, ownerCwd, implementationText }),
    })

    state.criticSessionId = result.sessionId
    activeParticipants.add(result.sessionId)
    void gateway.edit(state.ownerThreadId, statusMsg.id, `_Critic (**${result.name}**) reviewing..._`).catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: build critic spawn failed: ${msg}\n`)
    await gateway.send(state.ownerThreadId, `Failed to spawn build critic: ${msg}. Build cancelled.`)
    void cancelBuild(state.ownerThreadId)
  }
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function resetTimeout(state: BuildState): void {
  if (state.timeout) clearTimeout(state.timeout)
  if (state._heartbeat) clearInterval(state._heartbeat)
  state._heartbeat = undefined

  const whose = state.phase === 'reviewing' ? 'critic' : 'owner'
  const timeoutMs = whose === 'critic' ? CRITIC_TIMEOUT_MS : OWNER_TIMEOUT_MS

  // Heartbeat: check critic tmux is alive every 5 min (silent unless dead)
  if (whose === 'critic' && state.criticSessionId) {
    const criticId = state.criticSessionId
    let elapsed = 0
    state._heartbeat = setInterval(async () => {
      elapsed += 5
      const criticInfo = registry.get(criticId)
      if (criticInfo) {
        try {
          execSync(`tmux has-session -t '${criticInfo.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
          process.stderr.write(`daemon: build: critic ${criticInfo.tmuxName} alive (${elapsed}m elapsed)\n`)
        } catch {
          process.stderr.write(`daemon: build critic tmux session died\n`)
          if (state._heartbeat) clearInterval(state._heartbeat)
          await gateway.send(state.ownerThreadId, `Build critic (${criticInfo.tmuxName}) died. Cancelling.`).catch(() => {})
          await cancelBuild(state.ownerThreadId)
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
    await cancelBuild(state.ownerThreadId)
  }, timeoutMs)
}
