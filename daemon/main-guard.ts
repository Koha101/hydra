/**
 * Duplicate-'main' guard.
 *
 * 'main' is the session id every bridge defaults to when HYDRA_SESSION_ID is
 * unset (see bridge.ts), and it is exempt from the flap circuit breaker — we must
 * never tmux-kill the control session. The combination means two byte processes
 * can both register as 'main' and evict each other unboundedly: the daemon ends
 * the incumbent's socket on every new registration, the evicted bridge
 * reconnects, and the ping-pong never stops (nothing kills 'main').
 *
 * This decides when to break the cycle: once 'main' registrations flap, hold the
 * incumbent and refuse newcomers (for a cooldown) instead of letting each
 * newcomer evict the incumbent. A single legitimate byte restart (one
 * registration, no recent flap) is NOT held — it falls through to normal socket
 * replacement.
 *
 * Pure so it can be unit-tested without the socket layer.
 */
export function shouldHoldIncumbentMain(opts: {
  /** A different live socket already holds 'main'. */
  hasOtherIncumbent: boolean
  /** Registration rate for 'main' just crossed the flap threshold. */
  flapping: boolean
  /** Current time (ms). */
  now: number
  /** Refuse newcomers until this time (set when a flap was last detected). */
  cooldownUntil: number
}): boolean {
  if (!opts.hasOtherIncumbent) return false
  return opts.flapping || opts.now < opts.cooldownUntil
}
