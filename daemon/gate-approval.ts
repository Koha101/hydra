// ---------------------------------------------------------------------------
// Gate approval bridge (Phase 2 — async "deny-now, remember, retry")
//
// The permission gate (~/.claude-hydra/gate/permission_gate.sh) is a PreToolUse
// hook. On an "ask" verdict it does NOT block: it records the request in
// gate/pending/req-<key>.json (key = first 16 hex of sha256(tool+input)) and
// DENIES with a "re-run after approving" hint. This module is the daemon half: it
// watches gate/pending/, posts an Approve/Deny prompt INTO THE REQUESTING AGENT'S
// OWN THREAD (falling back to an owner DM), and on the owner's tap writes a signed,
// time-boxed, single-use decision-<key>.json — which the hook verifies + consumes
// when the agent re-runs the same action. The tap also nudges the agent to re-run.
//
// Trust: the decision is HMAC-signed with a key the byte can't read (hard-denied)
// and written only from a real Discord button-click by an allow-listed user. The
// byte can't forge it (no key) or write the pending dir (hard-denied). Fail-closed:
// no / invalid / expired decision => the hook denies.
// ---------------------------------------------------------------------------

import { createHmac, randomBytes } from 'crypto'
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ChatGateway, ButtonDef } from '../gateway.js'
import { loadAccess } from './access.js'
import { pendingPermissions } from './permission.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'

const GATE_DIR = join(homedir(), '.claude-hydra', 'gate')
const PENDING_DIR = join(GATE_DIR, 'pending')
const KEY_FILE = join(GATE_DIR, '.approval_key')
const REQ_KEY_RE = /^[0-9a-f]{16}$/     // request key = first 16 hex of sha256(tool+input)
const DECISION_TTL_S = 30 * 60          // an owner decision stays valid 30 min for the agent's retry

let _key: string | undefined
function key(): string {
  if (_key !== undefined) return _key
  if (existsSync(KEY_FILE)) { _key = readFileSync(KEY_FILE, 'utf-8').trim(); return _key }
  _key = randomBytes(32).toString('hex')
  writeFileSync(KEY_FILE, _key, { mode: 0o600 })
  process.stderr.write('daemon: generated gate approval key\n')
  return _key
}

// Sign the cached decision the gate hook verifies + consumes on the agent's retry.
function sign(k: string, decision: string, exp: number): string {
  return createHmac('sha256', key()).update(`${k}:${decision}:${exp}`).digest('hex')
}

const posted = new Set<string>()

function readReq(k: string): Record<string, string> {
  try { return JSON.parse(readFileSync(join(PENDING_DIR, `req-${k}.json`), 'utf-8')) } catch { return {} }
}

// One-line, human-scannable description of the requested action for prompts + nudges.
function actionLine(req: Record<string, string>): string {
  const tool = req.tool ?? '?'
  let inp = ''
  try {
    const j = JSON.parse(req.input ?? '{}')
    inp = String(j.command ?? j.file_path ?? j.path ?? j.url ?? '')
  } catch { inp = req.input ?? '' }
  const detail = inp ? ` — ${inp.slice(0, 300)}` : ''
  return `\`${tool}\`${detail}`
}

/** Owner tapped Approve/Deny: cache a signed decision the hook consumes on retry, remove the
 *  request, and nudge the requesting agent to re-run (or move on). */
export function writeApprovalDecision(k: string, decision: 'allow' | 'deny'): void {
  if (!REQ_KEY_RE.test(k)) return
  const req = readReq(k)
  const exp = Math.floor(Date.now() / 1000) + DECISION_TTL_S
  const tmp = join(PENDING_DIR, `decision-${k}.json.tmp`)
  writeFileSync(tmp, JSON.stringify({ key: k, decision, exp, sig: sign(k, decision, exp) }), { mode: 0o600 })
  renameSync(tmp, join(PENDING_DIR, `decision-${k}.json`))
  try { unlinkSync(join(PENDING_DIR, `req-${k}.json`)) } catch { /* already gone */ }
  posted.delete(k)

  const sid = req.session_id
  if (!sid) return
  const threadId = registry.get(sid)?.threadId ?? ''
  const line = actionLine(req)
  const content = decision === 'allow'
    ? `✅ You approved this — re-run it now and it will go through: ${line}`
    : `❌ You denied this — do not retry it; do something else or check with me: ${line}`
  transport.sendOrQueue(sid, {
    type: 'notification',
    content,
    meta: { chat_id: threadId, message_id: '', user: 'permission-gate', user_id: '', ts: new Date().toISOString() },
  })
}

function promptText(req: Record<string, string>): string {
  const why = req.summary ? `\n_flagged:_ ${req.summary}` : ''
  return `🔐 **Approval needed** · ${req.session ?? 'a session'}\n${actionLine(req)}${why}`
}

async function postApproval(gateway: ChatGateway, k: string): Promise<void> {
  if (posted.has(k)) return
  const req = readReq(k)
  if (!req.tool) return
  posted.add(k)
  pendingPermissions.set(k, { tool_name: req.tool, description: req.summary ?? '', input_preview: req.input ?? '' })
  const text = promptText(req)
  const buttons: ButtonDef[] = [
    { id: `perm:more:${k}`, label: 'See more', style: 'secondary' },
    { id: `perm:allow:${k}`, label: 'Approve', style: 'success', emoji: '✅' },
    { id: `perm:deny:${k}`, label: 'Deny', style: 'danger', emoji: '❌' },
  ]
  // Post into the requesting agent's own thread; fall back to an owner DM.
  const threadId = req.session_id ? registry.get(req.session_id)?.threadId : undefined
  if (threadId) {
    const ok = await gateway.send(threadId, text, { buttons }).then(() => true).catch(() => false)
    if (ok) return
  }
  for (const userId of loadAccess().allowFrom) {
    await gateway.sendDM(userId, text, buttons).catch((e: unknown) =>
      process.stderr.write(`daemon: gate approval DM to ${userId} failed: ${e}\n`))
  }
}

export function setupGateApproval(gateway: ChatGateway): void {
  key()   // eager-generate the signing key at startup so it exists before the first request
  mkdirSync(PENDING_DIR, { recursive: true })
  const scan = (): void => {
    let files: string[]
    try { files = readdirSync(PENDING_DIR) } catch { return }
    const now = Math.floor(Date.now() / 1000)
    for (const f of files) {
      const rq = /^req-([0-9a-f]{16})\.json$/.exec(f)
      if (rq && !posted.has(rq[1]) && !existsSync(join(PENDING_DIR, `decision-${rq[1]}.json`))) {
        void postApproval(gateway, rq[1])
      }
      const dc = /^decision-([0-9a-f]{16})\.json$/.exec(f)   // GC decisions the hook never consumed
      if (dc) {
        try {
          const d = JSON.parse(readFileSync(join(PENDING_DIR, f), 'utf-8'))
          if ((Number(d.exp) || 0) < now - 3600) unlinkSync(join(PENDING_DIR, f))
        } catch { /* ignore */ }
      }
    }
    for (const kk of posted) {
      if (!existsSync(join(PENDING_DIR, `req-${kk}.json`))) posted.delete(kk)
    }
  }
  scan()
  setInterval(scan, 1000)
}
