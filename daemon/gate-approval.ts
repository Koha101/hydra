// ---------------------------------------------------------------------------
// Gate approval bridge (Phase 3 — scoped grants: once / session / deny)
//
// The permission gate (~/.claude-hydra/gate/permission_gate.sh) is a PreToolUse
// hook. On an "ask" verdict it records the request in gate/pending/req-<key>.json
// (key = first 16 hex of sha256(tool+core), core = the command / file path — NOT
// the full tool_input, whose free-text `description` changes between retries) and
// DENIES with a "re-run after approving" hint. This module is the daemon half: it
// watches gate/pending/, posts an Approve prompt INTO THE REQUESTING AGENT'S OWN
// THREAD (falling back to an owner DM), and on the owner's tap writes a signed
// GRANT the hook matches on retry:
//
//   Allow once    — single-use, 30 min; prefix-scoped so a rephrased retry still
//                   matches (exact-scoped for restricted command families).
//   Allow session — multi-use, 12 h, shared by the session's subagents; offered
//                   only for unrestricted families (never egress/push/exec/rm).
//   Deny          — single-use exact deny; the agent is told not to retry.
//
// Trust: grants are HMAC-signed with a key the byte can't read (hard-denied) and
// written only from a real Discord button-click by an allow-listed user. The byte
// can't forge them (no key) or write the pending dir (hard-denied). Fail-closed:
// no / invalid / expired grant => the hook denies.
// ---------------------------------------------------------------------------

import { createHmac, randomBytes } from 'crypto'
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import type { ChatGateway } from '../gateway.js'
import { loadAccess } from './access.js'
import { pendingPermissions, approvalButtons } from './permission.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'

const GATE_DIR = join(homedir(), '.claude-hydra', 'gate')
const PENDING_DIR = join(GATE_DIR, 'pending')
const KEY_FILE = join(GATE_DIR, '.approval_key')
const REQ_KEY_RE = /^[0-9a-f]{16}$/     // request key = first 16 hex of sha256(tool+core)
const ONCE_TTL_S = 30 * 60              // single-use grant: valid 30 min for the agent's retry
const SESSION_TTL_S = 12 * 60 * 60      // session grant: the rest of the working session

// Command families that never get a prefix- or session-scoped grant: egress,
// publishing, code-exec-by-proxy (interpreters/shells), destruction,
// credentials. A tap on these approves the exact command once — nothing wider.
const RESTRICTED_WORDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'scp', 'rsync', 'ssh', 'sftp', 'sudo',
  'launchctl', 'crontab', 'pkill', 'kill', 'killall', 'rm', 'mv', 'dd', 'diskutil',
  'open', 'osascript', 'security', 'gh', 'docker', 'ssh-add',
  'bash', 'sh', 'zsh', 'perl', 'ruby', 'node', 'bun', 'deno', 'npx', 'xargs',
  'env', 'find', 'awk', 'sed', 'tee', 'make', 'pip', 'pip3', 'poetry', 'uv',
])

function isRestrictedBash(cmd: string): boolean {
  // any pipeline segment counts — "grep x | sh" is exec, not grep
  for (const seg of cmd.split('|')) {
    const first = seg.trim().split(' ')[0]
    if (RESTRICTED_WORDS.has(first) || /^python[\d.]*$|^ipython$/.test(first)) return true
  }
  const noC = cmd.replace(/^git -C \S+ /, 'git ')   // adjacency dodge: git -C x push
  if (/^git (push|tag)\b/.test(noC) || /^git remote (add|set-url|remove|rm)\b/.test(noC)) return true
  return /\.ssh|\.aws|credential|token|keychain/i.test(cmd)
}

let _key: string | undefined
function key(): string {
  if (_key !== undefined) return _key
  if (existsSync(KEY_FILE)) { _key = readFileSync(KEY_FILE, 'utf-8').trim(); return _key }
  _key = randomBytes(32).toString('hex')
  writeFileSync(KEY_FILE, _key, { mode: 0o600 })
  process.stderr.write('daemon: generated gate approval key\n')
  return _key
}

type Grant = {
  sid: string
  tool: string
  pattern: string      // exact string, or a token-aligned prefix when exact=false
  exact: boolean
  decision: 'allow' | 'deny'
  once: boolean
  exp: number
  sig: string
}

// Pattern goes LAST in the signed payload — it's the only field that may contain ':'.
function signGrant(g: Omit<Grant, 'sig'>): string {
  const payload = `grant2:${g.sid}:${g.tool}:${g.decision}:${g.once ? 1 : 0}:${g.exact ? 1 : 0}:${g.exp}:${g.pattern}`
  return createHmac('sha256', key()).update(payload).digest('hex')
}

// The action's stable core — must mirror the hook's CORE derivation exactly
// (permission_gate.sh): Bash -> command, file tools -> path, everything else ->
// the raw input JSON. A divergence means grants never match on retry.
function coreOf(tool: string, input: string): string {
  try {
    const j = JSON.parse(input)
    if (tool === 'Bash') return String(j.command ?? '').replace(/\s+/g, ' ').trim()
    if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) {
      return String(j.file_path ?? j.path ?? j.notebook_path ?? '')
    }
    return input
  } catch { return input }
}

/** Scope a grant for this request: how wide a pattern, and whether a session
 *  grant may be offered at all. Deterministic and shown to the owner verbatim. */
export function derivePattern(tool: string, core: string): { pattern: string; exact: boolean; sessionable: boolean } {
  if (tool === 'Bash') {
    // core is already whitespace-normalized by coreOf
    if (isRestrictedBash(core)) return { pattern: core, exact: true, sessionable: false }
    return { pattern: core.split(' ').slice(0, 2).join(' '), exact: false, sessionable: true }
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const analysis = join(homedir(), 'Development', 'analysis')
    if (core === analysis || core.startsWith(analysis + '/')) return { pattern: core, exact: true, sessionable: false }
    // a trailing slash would make dirname() climb a level and silently widen the grant
    return { pattern: dirname(core.replace(/\/+$/, '')), exact: false, sessionable: true }
  }
  // MCP and other tools: exact input only — tool-wide grants are too coarse.
  return { pattern: core, exact: true, sessionable: false }
}

const posted = new Set<string>()

function readReq(k: string): Record<string, string> {
  try { return JSON.parse(readFileSync(join(PENDING_DIR, `req-${k}.json`), 'utf-8')) } catch { return {} }
}

// One-line, human-scannable description of the requested action for prompts + nudges.
function actionLine(req: Record<string, string>): string {
  const tool = req.tool ?? '?'
  const inp = coreOf(tool, req.input ?? '')
  const detail = inp ? ` — ${inp.slice(0, 300)}` : ''
  return `\`${tool}\`${detail}`
}

/** Owner tapped a button: write the signed grant the hook consumes on retry,
 *  remove the request, and nudge the requesting agent to re-run (or move on).
 *  Returns false on a stale re-tap (request already resolved) — no grant minted. */
export function writeApprovalDecision(k: string, choice: 'allow' | 'session' | 'deny'): boolean {
  if (!REQ_KEY_RE.test(k)) return false
  const req = readReq(k)
  if (!req.tool) return false   // stale re-tap after the request was resolved — never mint orphan grants
  const sid = req.session_id || 'byte'
  const core = coreOf(req.tool, req.input ?? '')
  const scope = derivePattern(req.tool, core)

  const g: Omit<Grant, 'sig'> = choice === 'session'
    ? { sid, tool: req.tool, pattern: scope.pattern, exact: scope.exact, decision: 'allow', once: false, exp: nowS() + SESSION_TTL_S }
    : choice === 'allow'
      ? { sid, tool: req.tool, pattern: scope.pattern, exact: scope.exact, decision: 'allow', once: true, exp: nowS() + ONCE_TTL_S }
      : { sid, tool: req.tool, pattern: core, exact: true, decision: 'deny', once: true, exp: nowS() + ONCE_TTL_S }
  const grant: Grant = { ...g, sig: signGrant(g) }

  const tmp = join(PENDING_DIR, `grant-${k}.json.tmp`)
  writeFileSync(tmp, JSON.stringify(grant), { mode: 0o600 })
  renameSync(tmp, join(PENDING_DIR, `grant-${sid}-${k}.json`))
  try { unlinkSync(join(PENDING_DIR, `req-${k}.json`)) } catch { /* already gone */ }
  posted.delete(k)

  if (!req.session_id) return true
  const threadId = registry.get(req.session_id)?.threadId ?? ''
  const line = actionLine(req)
  const content = choice === 'deny'
    ? `❌ You denied this — do not retry it; do something else or check with me: ${line}`
    : choice === 'session'
      ? `✅ You approved this for the session (\`${scope.pattern}${scope.exact ? '' : ' *'}\`) — re-run it now and it will go through: ${line}`
      : `✅ You approved this — re-run it now and it will go through: ${line}`
  transport.sendOrQueue(req.session_id, {
    type: 'notification',
    content,
    meta: { chat_id: threadId, message_id: '', user: 'permission-gate', user_id: '', ts: new Date().toISOString() },
  })
  return true
}

function nowS(): number { return Math.floor(Date.now() / 1000) }

function promptText(req: Record<string, string>, scope: { pattern: string; exact: boolean; sessionable: boolean }): string {
  const why = req.summary ? `\n_flagged:_ ${req.summary}` : ''
  const span = scope.sessionable ? `\n_session grant would cover:_ \`${scope.pattern} *\`` : ''
  return `🔐 **Approval needed** · ${req.session ?? 'a session'}\n${actionLine(req)}${why}${span}`
}

async function postApproval(gateway: ChatGateway, k: string): Promise<void> {
  if (posted.has(k)) return
  const req = readReq(k)
  if (!req.tool) return
  posted.add(k)
  const scope = derivePattern(req.tool, coreOf(req.tool, req.input ?? ''))
  pendingPermissions.set(k, {
    tool: req.tool, summary: req.summary ?? '', input: req.input ?? '',
    sessionable: scope.sessionable,
  })
  const text = promptText(req, scope)
  const buttons = approvalButtons(k, scope.sessionable)
  // Post into the requesting agent's own thread; fall back to an owner DM.
  const threadId = req.session_id ? registry.get(req.session_id)?.threadId : undefined
  if (threadId) {
    const ok = await gateway.send(threadId, text, { buttons }).then(() => true).catch(() => false)
    if (ok) return
  }
  let dmOk = false
  for (const userId of loadAccess().allowFrom) {
    const ok = await gateway.sendDM(userId, text, buttons).then(() => true).catch((e: unknown) => {
      process.stderr.write(`daemon: gate approval DM to ${userId} failed: ${e}\n`)
      return false
    })
    dmOk = dmOk || ok
  }
  // nothing reached the owner: forget it so the next scan tick re-posts
  if (!dmOk) posted.delete(k)
}

export function setupGateApproval(gateway: ChatGateway): void {
  key()   // eager-generate the signing key at startup so it exists before the first request
  mkdirSync(PENDING_DIR, { recursive: true })
  const scan = (): void => {
    let files: string[]
    try { files = readdirSync(PENDING_DIR) } catch { return }
    const now = nowS()
    for (const f of files) {
      const rq = /^req-([0-9a-f]{16})\.json$/.exec(f)
      if (rq && !posted.has(rq[1])) void postApproval(gateway, rq[1])
      if (/^grant-.*\.json$/.test(f)) {   // GC grants the hook never consumed
        try {
          const g = JSON.parse(readFileSync(join(PENDING_DIR, f), 'utf-8'))
          if ((Number(g.exp) || 0) < now - 3600) unlinkSync(join(PENDING_DIR, f))
        } catch { /* ignore */ }
      }
      if (/^(decision|resp)-.*\.json$/.test(f) || f.endsWith('.json.tmp')) {   // legacy + crashed-write leftovers
        try { unlinkSync(join(PENDING_DIR, f)) } catch { /* ignore */ }
      }
    }
    for (const kk of posted) {
      if (!existsSync(join(PENDING_DIR, `req-${kk}.json`))) posted.delete(kk)
    }
  }
  scan()
  setInterval(scan, 1000)
}
