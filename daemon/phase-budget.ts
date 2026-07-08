// Phase budget — a per-session max lifetime that any spawn can carry
// (`--phase-budget 20m` in the topic, or the spawn_session tool's
// phase_budget field). At the deadline the session is nudged to write its
// checkpoint and post its result; at deadline+grace it is reaped. The
// deadline persists in the session registry, so a daemon restart re-arms
// every budget instead of forgetting it (the ephemeral TTL's known flaw).
//
// The reaper is injected at boot (daemon.ts) rather than imported —
// session-lifecycle imports this module to arm budgets on spawn, and
// importing killSession back would recreate the exact import cycle that
// PR #88 removed from this layer.
import { registry, type SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { safeSend } from './util.js'

export const PHASE_BUDGET_GRACE_MS = 5 * 60 * 1000

type Reaper = (info: SessionInfo, reason: string) => Promise<void>
let reaper: Reaper | undefined

const timers = new Map<string, { nudge?: ReturnType<typeof setTimeout>; reap?: ReturnType<typeof setTimeout> }>()

export function startPhaseBudget(sessionId: string): void {
  const info = registry.get(sessionId)
  if (!info?.budgetDeadline) return
  clearPhaseBudget(sessionId)

  const untilNudge = Math.max(0, info.budgetDeadline - Date.now())
  const entry: { nudge?: ReturnType<typeof setTimeout>; reap?: ReturnType<typeof setTimeout> } = {}

  entry.nudge = setTimeout(() => {
    const live = registry.get(sessionId)
    if (!live?.budgetDeadline) return
    process.stderr.write(`daemon: phase-budget: ${live.tmuxName} hit its budget, nudging (reap in ${PHASE_BUDGET_GRACE_MS / 60000}m)\n`)
    transport.sendOrQueue(sessionId, {
      type: 'notification',
      content: [
        `[system] Your phase budget is up. You will be reaped in ${PHASE_BUDGET_GRACE_MS / 60000} minutes.`,
        `Write your checkpoint NOW: post your result/summary to your thread, including the path of any artifact you produced. Unposted work dies with you.`,
      ].join('\n'),
      meta: { chat_id: live.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
    void safeSend(live.threadId, `_⏳ ${live.tmuxName} hit its phase budget — checkpoint requested, reaping in ${PHASE_BUDGET_GRACE_MS / 60000}m._`)

    entry.reap = setTimeout(() => {
      const target = registry.get(sessionId)
      timers.delete(sessionId)
      if (!target) return
      if (!reaper) {
        process.stderr.write(`daemon: phase-budget: no reaper installed, cannot reap ${target.tmuxName}\n`)
        return
      }
      void reaper(target, 'phase budget expired').catch(err => {
        process.stderr.write(`daemon: phase-budget: reap failed for ${target.tmuxName}: ${err}\n`)
      })
    }, PHASE_BUDGET_GRACE_MS)
  }, untilNudge)

  timers.set(sessionId, entry)
}

export function clearPhaseBudget(sessionId: string): void {
  const entry = timers.get(sessionId)
  if (!entry) return
  if (entry.nudge) clearTimeout(entry.nudge)
  if (entry.reap) clearTimeout(entry.reap)
  timers.delete(sessionId)
}

/** Boot wiring: install the reaper and re-arm persisted deadlines. */
export function initPhaseBudgets(reap: Reaper): void {
  reaper = reap
  for (const info of registry.values()) {
    if (info.budgetDeadline) startPhaseBudget(info.sessionId)
  }
}

export function _resetPhaseBudgetsForTesting(): void {
  for (const id of [...timers.keys()]) clearPhaseBudget(id)
  reaper = undefined
}
