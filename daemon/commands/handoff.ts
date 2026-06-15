import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { gateway, STATE_DIR } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { doSpawnSession } from '../session-lifecycle.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, getContextPercent } from '../util.js'
import type { InboundMessage } from '../../gateway.js'

const HANDOFF_PROTOCOL = `HANDOFF PROTOCOL
================

You are about to hand off your work to a successor session. Your context
window is being retired. The successor will start fresh with access to the
filesystem, memory files, and workstream canon -- but NOT your conversation
history.

User's direction for the successor: "{user_direction}"
(If empty: the successor should continue the current line of work.)

If you haven't run a session retrospective yet, consider running one before
starting this protocol. Retros route learnings to permanent artifacts (skills,
techniques, memory files) where future sessions will actually load them.
Handoff artifacts are ephemeral — consumed by one successor. Recommended,
not required — skip if the session has no learnings worth persisting.

Execute the following steps. Do not ask for confirmation.

STEP 1: PERSIST DURABLE LEARNINGS
----------------------------------
Review your conversation for insights that should survive beyond this
immediate handoff -- things future sessions (not just the successor)
would benefit from knowing.

Write these to the appropriate files using your normal editing tools:
- Workstream canon (CANON.md): architectural decisions, gotchas, patterns
- Memory files (~/.claude/memory/): cross-project patterns, user preferences
- Workstream notes: action items not for the immediate successor

Route by asking: "Will a future session in a *different* project benefit?"
→ global memory/technique/skill files (~/.claude/memory/, ~/.claude/skills/).
"Is this about how *this workstream* works?" → workstream canon.
"Is this about a specific artifact type (HTML, diagrams, etc.)?" → the
relevant skill file. Don't put learnings in the handoff doc -- the handoff
is ephemeral; skills and canon are permanent.

If a spec exists for this work and the implementation diverged from it,
update the spec to match reality or add a note at the top:
"Superseded by [description]. See [reference]."

If nothing is durable, say so and move to Step 2.

STEP 2: PRODUCE THE HANDOFF ARTIFACT
--------------------------------------
Write the artifact to: {artifact_path}

Structure it as a self-contained prompt -- the successor has never seen
your conversation:

### TL;DR
Three sentences max: what we're building, where it's at, what the
successor should do first.

### Orientation
What we're working on and why. 2-3 sentences.

### Prerequisites
Skills, canon docs, or conventions the successor MUST read before touching
anything. Not suggestions -- gates. If the workstream has specialized tooling
(validation scripts, editing conventions, pipeline patterns), list the skill
or doc path here. The successor reads these before acting on anything else.

### Key decisions
Decisions that were expensive to reach. Include reasoning and rejected
alternatives. Format: "Decision: X. Reasoning: Y. Rejected: Z."

### State of the work
- Done (with file paths). For each done item whose mechanism isn't
  obvious from the name alone, add one sentence explaining how it works.
  Names you coined in-session are opaque to the successor.
- In progress (with locations and status)
- Blocked or unresolved (with enough context to unblock)

### Fragile
Things that break easily if the successor doesn't know about them.
Manually maintained state, implicit assumptions, non-obvious coupling
between files. Not what's done or in progress -- what's brittle.

### Dead ends
Approaches tried and abandoned, with why.

### Anchors
Function/constant names and file paths the successor needs. Include
approximate line numbers as a convenience, but name the function --
names persist, line numbers drift.

### Next action
The single most important thing to do first. One sentence.

### Remaining steps
Other actions, ordered by priority. Organized around the user's
direction: "{user_direction}"

STEP 3: PRESENT FOR REVIEW
---------------------------
Reply in the thread with a TLDR: one sentence on what was persisted,
one sentence summarizing the artifact, and the file path. Then say:
"Type \`/go\` to launch the successor, or give feedback to iterate."

If the user sends feedback instead of \`/go\`, revise the artifact file
and post an updated TLDR. Repeat until \`/go\`.
`

const HANDOFF_DIR = join(STATE_DIR, 'handoffs')

export async function handleHandoffIntercept(msg: InboundMessage, direction?: string): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  try {
    execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
  } catch {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `Cannot handoff — **${info.tmuxName}** is no longer running.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🤝').catch(() => {})

  const userDirection = direction || ''
  mkdirSync(HANDOFF_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const artifactPath = join(HANDOFF_DIR, `${ts}-${info.tmuxName}.md`)

  const ctx = getContextPercent(info.tmuxName)
  const ctxNum = parseInt(ctx) || 0
  const estimate = ctxNum >= 70 ? '30-60s' : ctxNum >= 40 ? '45-90s' : '60-120s'
  void gateway.send(msg.channelId,
    `🤝 **${info.tmuxName}** is preparing the handoff — persisting learnings and composing the artifact (~${estimate} at ${ctx} context). I'll post a TLDR when ready for your review.`,
    { replyTo: msg.id },
  ).catch(() => {})

  const protocol = HANDOFF_PROTOCOL
    .replace(/\{user_direction\}/g, userDirection || '(continue current line of work)')
    .replace(/\{artifact_path\}/g, artifactPath)
  let contextNote = ''
  if (ctxNum >= 80) {
    contextNote = `\n\nCONTEXT NOTE: You are at ${ctx} context. Keep the artifact concise — prioritize decisions, dead ends, and anchors over comprehensive state. Consider delegating artifact composition to a subagent if available.`
  } else if (ctxNum >= 60) {
    contextNote = `\n\nCONTEXT NOTE: You are at ${ctx} context. Balance thoroughness with conciseness.`
  }

  const protocolMessage = `[system] Handoff requested.${userDirection ? ` User direction: '${userDirection}'.` : ''} Execute the handoff protocol now.\n\n${protocol}${contextNote}`

  transport.sendOrQueue(info.sessionId, {
    type: 'notification',
    content: protocolMessage,
    meta: {
      chat_id: info.threadId,
      message_id: msg.id,
      user: 'system',
      user_id: 'system',
      ts: new Date().toISOString(),
    },
  })
}

export async function handleGoIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  let artifactPath: string | null = null
  try {
    const files = readdirSync(HANDOFF_DIR)
      .filter(f => f.endsWith(`-${info.tmuxName}.md`))
      .sort()
    if (files.length > 0) {
      artifactPath = join(HANDOFF_DIR, files[files.length - 1])
    }
  } catch {}

  if (!artifactPath) {
    void gateway.send(msg.channelId, `No handoff artifact found for **${info.tmuxName}**. Run \`handoff\` first.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🤝').catch(() => {})

  const handoffAnchor = gateway.getThreadAnchor(msg.channelId)
  const baseChatId = handoffAnchor?.channelId ?? msg.channelId
  const topic = info.description ?? fallbackDescription(info.topic)

  try {
    const result = await doSpawnSession(topic, baseChatId, undefined, {
      handedOffFrom: info.tmuxName,
      artifact: artifactPath,
    })

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (transport.has(result.sessionId)) break
      await new Promise(r => setTimeout(r, 500))
    }

    const pe = sessionEmoji(info.tmuxName)
    const ce = sessionEmoji(result.name)
    try {
      await gateway.send(info.threadId, [
        `🤝 ${pe} \`${info.tmuxName}\` handed off → ${ce} \`${result.name}\` — ${result.url}`,
        `View in any terminal: \`tmux attach -t ${result.name}\``,
      ].join('\n'))
    } catch {}

    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] 🤝 ${pe} \`${info.tmuxName}\` handed off → ${ce} \`${result.name}\`${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: baseChatId, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }

    try {
      await gateway.send(info.threadId, `${ce} \`${result.name}\` is live. Type \`kill\` here to end \`${info.tmuxName}\`.`)
    } catch {}

    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: handoff go failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Handoff failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}
