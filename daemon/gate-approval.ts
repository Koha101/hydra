// ---------------------------------------------------------------------------
// Gate approval bridge (Phase 2 escalation)
//
// The permission gate (~/.claude-hydra/gate/permission_gate.sh) is a PreToolUse
// hook. When the Claude judge returns "ask" for a user-reserved action, the hook
// drops a request file in gate/pending/ and BLOCKS, polling for a response. This
// module is the daemon half: it watches gate/pending/, posts an Approve/Deny
// prompt to the owner over Discord, and — on the owner's tap — writes back an
// HMAC-signed response the hook verifies before allowing the tool call.
//
// Trust model: the response is signed with a key (gate/.approval_key, 0600) that
// the byte is hard-denied from reading, and it is written by the daemon from a
// real Discord button-click by an allow-listed user. The byte cannot forge it
// (no key) and cannot write the pending dir (hard-denied). Fail-closed: no/invalid
// response => the hook denies.
// ---------------------------------------------------------------------------

import { createHmac, randomBytes } from 'crypto'
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ChatGateway, ButtonDef } from '../gateway.js'
import { loadAccess } from './access.js'
import { pendingPermissions } from './permission.js'

const GATE_DIR = join(homedir(), '.claude-hydra', 'gate')
const PENDING_DIR = join(GATE_DIR, 'pending')
const KEY_FILE = join(GATE_DIR, '.approval_key')
const NONCE_RE = /^[a-km-z]{5}$/          // matches the gate hook + perm-button customId

const posted = new Set<string>()

// Late-bound, memoized (matches the codebase's late-bind convention). Self-initializes
// on first use, so there is no module-load ordering dependency with setupGateApproval.
let _key: string | undefined
function key(): string {
  if (_key !== undefined) return _key
  if (existsSync(KEY_FILE)) { _key = readFileSync(KEY_FILE, 'utf-8').trim(); return _key }
  _key = randomBytes(32).toString('hex')
  writeFileSync(KEY_FILE, _key, { mode: 0o600 })
  process.stderr.write('daemon: generated gate approval key\n')
  return _key
}

// Sign an approval so the hook can verify it came from the daemon (which alone holds the
// key). Binds nonce + decision + a hash of the request, so an approval for one tool call
// cannot validate a different one (nonce collision / replay).
function sign(nonce: string, decision: string, reqhash: string): string {
  return createHmac('sha256', key()).update(`${nonce}:${decision}:${reqhash}`).digest('hex')
}

/** Write the HMAC-signed response the blocked gate hook is polling for. Atomic (tmp+rename)
 *  so the hook can never read a half-written file and spuriously deny a real approval. */
export function writeApprovalResponse(nonce: string, decision: 'allow' | 'deny'): void {
  if (!NONCE_RE.test(nonce)) return
  let reqhash = ''
  try {
    reqhash = JSON.parse(readFileSync(join(PENDING_DIR, `req-${nonce}.json`), 'utf-8')).reqhash ?? ''
  } catch { /* req gone -> empty hash -> hook's expect won't match -> fail-closed deny */ }
  const tmp = join(PENDING_DIR, `resp-${nonce}.json.tmp`)
  writeFileSync(tmp, JSON.stringify({ nonce, decision, sig: sign(nonce, decision, reqhash) }), { mode: 0o600 })
  renameSync(tmp, join(PENDING_DIR, `resp-${nonce}.json`))
}

async function postApproval(gateway: ChatGateway, nonce: string): Promise<void> {
  if (posted.has(nonce)) return
  let req: { tool?: string; summary?: string; input?: string; session?: string }
  try {
    req = JSON.parse(readFileSync(join(PENDING_DIR, `req-${nonce}.json`), 'utf-8'))
  } catch {
    return
  }
  posted.add(nonce)
  pendingPermissions.set(nonce, {
    tool_name: req.tool ?? '?',
    description: req.summary ?? '',
    input_preview: req.input ?? '',
  })
  const text =
    `🔐 **Approval needed** · \`${req.tool ?? '?'}\`\n` +
    `${req.summary ?? ''}\n` +
    `_${req.session ?? 'a session'} is waiting on your call_`
  const buttons: ButtonDef[] = [
    { id: `perm:more:${nonce}`, label: 'See more', style: 'secondary' },
    { id: `perm:allow:${nonce}`, label: 'Allow', style: 'success', emoji: '✅' },
    { id: `perm:deny:${nonce}`, label: 'Deny', style: 'danger', emoji: '❌' },
  ]
  for (const userId of loadAccess().allowFrom) {
    await gateway.sendDM(userId, text, buttons).catch((e: unknown) =>
      process.stderr.write(`daemon: gate approval DM to ${userId} failed: ${e}\n`))
  }
}

export function setupGateApproval(gateway: ChatGateway): void {
  key()   // eager-generate the signing key at startup so it exists before the first escalation
  mkdirSync(PENDING_DIR, { recursive: true })

  const scan = (): void => {
    let files: string[]
    try { files = readdirSync(PENDING_DIR) } catch { return }
    for (const f of files) {
      const m = /^req-([a-km-z]{5})\.json$/.exec(f)
      if (m && !posted.has(m[1]) && !existsSync(join(PENDING_DIR, `resp-${m[1]}.json`))) {
        void postApproval(gateway, m[1])
      }
    }
    // Forget nonces whose request the hook has cleaned up, so the set stays small.
    for (const n of posted) {
      if (!existsSync(join(PENDING_DIR, `req-${n}.json`))) posted.delete(n)
    }
  }

  scan()
  setInterval(scan, 1000)
}
