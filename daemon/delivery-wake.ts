// ---------------------------------------------------------------------------
// Delivery wake — recover messages Claude Code staged but never auto-submitted.
//
// Claude Code delivers an inbound channel message as an MCP notification the
// session normally processes on its own. But once a bridge has (re)connected —
// after a daemon restart, or on a fresh spawn whose queued messages flush the
// moment the bridge registers — CC can instead stage the notification as a
// *queued-message widget* in the composer that never auto-submits, so the
// session silently never sees the message. The widget is un-submittable (Enter
// is a no-op on it) and its prompt is "❯" + a NON-BREAKING space, distinct from
// the real composer prompt (regular space).
//
// After a delivery (or a registration-time queue flush), poll the pane: once
// the session is idle with such a stuck widget, clear it and nudge the session
// to pull the message from chat history and reply. Gated on "idle AND
// stuck-widget-present", so a session that processed the notification normally
// is never touched, and a busy session is left alone until its turn ends.
// A freshly booting pane shows neither CC's busy footer nor a widget — don't
// conclude "processed normally" until the CC UI has actually rendered.
// Disable with HYDRA_DELIVERY_WAKE=0.
// ---------------------------------------------------------------------------
const DELIVERY_WAKE = process.env.HYDRA_DELIVERY_WAKE !== '0'
const QUEUED_WIDGET_PREFIX = String.fromCharCode(0x276f, 0xa0) // angle-prompt + non-breaking space (the stuck queued widget)
const WAKE_NUDGE =
  'You have unread messages in your thread that were not delivered to you. ' +
  'Call fetch_messages on your own chat_id, read anything after your last reply, and respond.'
const wakePending = new Set<string>()
const MAX_WAKE_POLLS = 300 // ~10 min backstop while a turn runs; a longer turn re-arms on the next delivery
// Composer prompt, busy footer, or shortcut hint — any of these means CC's UI is up.
const CLAUDE_UI_RE = /esc to interrupt|\? for shortcuts|bypass permissions|❯ /

export async function paneText(tmux: string): Promise<string> {
  try {
    const p = Bun.spawn(['tmux', 'capture-pane', '-t', tmux, '-p'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    return await new Response(p.stdout).text()
  } catch { return '' }
}

export async function tmuxKeys(tmux: string, ...keys: string[]): Promise<void> {
  try { await Bun.spawn(['tmux', 'send-keys', '-t', tmux, ...keys], { stdio: ['ignore', 'ignore', 'ignore'] }).exited } catch {}
}

/** "esc to interrupt" appears only in the status footer during a turn; scan just
 *  the tail so the same substring quoted in transcript/output can't wedge us. */
export function paneBusy(pane: string): boolean {
  return pane.split('\n').filter(l => l.trim()).slice(-4).some(l => l.includes('esc to interrupt'))
}

/** After a delivery or queue flush, wake the session iff it's idle with an
 *  un-submitted queued widget. Waits out boot and busy turns (bounded), dedupes
 *  per session, no-ops otherwise. */
export async function wakeIfStuck(tmux: string): Promise<void> {
  if (!DELIVERY_WAKE || wakePending.has(tmux)) return
  wakePending.add(tmux)
  try {
    let uiSeen = false
    let calmPolls = 0
    for (let poll = 0; poll < MAX_WAKE_POLLS; poll++) {
      await new Promise(r => setTimeout(r, 2000))
      const pane = await paneText(tmux)
      if (!pane) return
      if (paneBusy(pane)) { uiSeen = true; calmPolls = 0; continue }
      const stuck = pane.split('\n').some(l => l.startsWith(QUEUED_WIDGET_PREFIX) && l.slice(QUEUED_WIDGET_PREFIX.length).trim())
      if (stuck) {
        await tmuxKeys(tmux, 'Escape')
        await tmuxKeys(tmux, '-l', WAKE_NUDGE)
        await tmuxKeys(tmux, 'Enter')
        process.stderr.write(`daemon: woke ${tmux} — queued channel message never auto-submitted\n`)
        return
      }
      uiSeen ||= CLAUDE_UI_RE.test(pane)
      if (!uiSeen) continue // still booting — a bare shell pane proves nothing yet
      if (++calmPolls >= 2) return // processed normally — leave it alone
    }
  } finally {
    wakePending.delete(tmux)
  }
}
