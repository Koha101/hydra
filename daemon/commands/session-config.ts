// Claude sessions receive native slash commands through tmux. Codex sessions
// are configured through the app-server connection that already owns the thread.
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { gateway, PLATFORM, CLAUDE_CONFIG } from '../config.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { codexEngine } from '../codex-bootstrap.js'
import type { CodexContext } from '../codex-engine.js'
import {
  clearLegacyCodexContext,
  configureLegacyCodexSession,
  getLegacyCodexContext,
  type LegacyCodexConfigResult,
} from '../legacy-codex-control.js'
import { resolveModelAlias, EFFORT_LEVELS, CODEX_EFFORT_LEVELS } from '../../shared/constants.js'
import type { InboundMessage } from '../../gateway.js'
import { buildCodexWorkspaceContext } from '../codex-context.js'

const byteTmux = (): string => process.env.BYTE_SESSION_NAME ?? `${PLATFORM}-byte`

function targetTmux(msg: InboundMessage): string {
  if (msg.isThread) {
    const sid = registry.getByThread(registry.resolveThreadId(msg))
    const info = sid ? registry.get(sid) : undefined
    if (info) return info.tmuxName
  }
  return byteTmux()
}

function targetSession(msg: InboundMessage): SessionInfo | undefined {
  return msg.isThread ? registry.resolveThreadSessionFromMsg(msg) : undefined
}

function persistCodexContext(info: SessionInfo, context: CodexContext): void {
  info.codexThreadId = context.threadId
  if (info.capabilities) {
    info.capabilities.model = context.model ?? 'codex-default'
    info.capabilities.effort = context.effort
  }
  const thread = threadRegistry.get(info.threadId)
  const entry = thread?.sessionHistory.find(h => h.sessionId === info.sessionId && !h.endedAt)
  if (entry) {
    entry.codexThreadId = context.threadId
    entry.model = context.model
    entry.effort = context.effort
    entry.engine = 'codex'
    threadRegistry.persist()
  }
  registry.persist()
}

function persistLegacyCodexConfig(info: SessionInfo, result: LegacyCodexConfigResult): void {
  if (info.capabilities) {
    info.capabilities.model = result.model
    info.capabilities.effort = result.effort
  }
  const thread = threadRegistry.get(info.threadId)
  const entry = thread?.sessionHistory.find(h => h.sessionId === info.sessionId && !h.endedAt)
  if (entry) {
    entry.model = result.model
    entry.effort = result.effort
    threadRegistry.persist()
  }
  registry.persist()
}

function isCodex(info: SessionInfo | undefined): info is SessionInfo {
  return info?.engine === 'codex' || info?.provider === 'codex'
}

async function configureCodex(
  info: SessionInfo,
  patch: { model?: string | null; effort?: string | null },
): Promise<{ model: string; effort: string }> {
  if (info.engine === 'codex') {
    const context = codexEngine.configure(info.sessionId, patch)
    persistCodexContext(info, context)
    return { model: context.model ?? 'default', effort: context.effort ?? 'default' }
  }
  const result = await configureLegacyCodexSession(info.sessionId, patch)
  persistLegacyCodexConfig(info, result)
  return result
}

async function codexUsage(info: SessionInfo): Promise<{
  used: number; window?: number; input: number; cached: number; output: number
} | undefined> {
  if (info.engine === 'codex') {
    const usage = codexEngine.getContext(info.sessionId).tokenUsage
    return usage ? {
      used: usage.totalTokens, window: usage.modelContextWindow, input: usage.inputTokens,
      cached: usage.cachedInputTokens, output: usage.outputTokens,
    } : undefined
  }
  const usage = (await getLegacyCodexContext(info.sessionId)).usage
  return usage ? {
    used: usage.usedTokens, window: usage.contextWindow, input: usage.inputTokens,
    cached: usage.cachedInputTokens, output: usage.outputTokens,
  } : undefined
}

async function clearCodex(info: SessionInfo): Promise<void> {
  if (info.engine === 'codex') {
    const workspace = process.env.SPAWN_CWD ?? info.capabilities?.cwd ?? process.cwd()
    persistCodexContext(info, await codexEngine.resetThread(info.sessionId, buildCodexWorkspaceContext(workspace) || undefined))
    return
  }
  await clearLegacyCodexContext(info.sessionId)
  delete info.codexSessionId
  const thread = threadRegistry.get(info.threadId)
  const entry = thread?.sessionHistory.find(h => h.sessionId === info.sessionId && !h.endedAt)
  if (entry) delete entry.codexSessionId
  registry.persist()
  threadRegistry.persist()
}

/** Type a slash command into a tmux pane and submit it. Escape clears any partial
 * input first; each keystroke is awaited so Escape → text → Enter can't arrive out
 * of order (a bare `send-keys` returns before tmux has delivered the keys). */
async function sendSlash(tmux: string, line: string): Promise<void> {
  const opts = { stdio: ['ignore', 'ignore', 'ignore'] as const }
  try {
    for (const keys of [['Escape'], ['-l', line], ['Enter']]) {
      await Bun.spawn(['tmux', 'send-keys', '-t', tmux, ...keys], opts).exited
    }
  } catch (err) {
    process.stderr.write(`daemon: sendSlash failed for ${tmux}: ${err}\n`)
  }
}

export async function handleModelIntercept(msg: InboundMessage, arg: string): Promise<void> {
  const info = targetSession(msg)
  if (isCodex(info)) {
    const requested = arg.trim()
    try {
      const config = await configureCodex(info, {
        model: requested.toLowerCase() === 'default' ? null : requested,
      })
      await gateway.send(msg.channelId, `⚙️ Codex model → \`${config.model}\` _(applies on the next turn)_`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      await gateway.send(msg.channelId, `❌ Could not change Codex model: ${error instanceof Error ? error.message : String(error)}`, { replyTo: msg.id }).catch(() => {})
    }
    return
  }

  const resolved = resolveModelAlias(arg.trim()) ?? arg.trim()
  const tmux = targetTmux(msg)
  await sendSlash(tmux, `/model ${resolved}`)
  // Cache-invalidating switches show a confirmation asynchronously. Wait for
  // the actual modal instead of sending Enter on a fixed timer.
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250))
    let pane = ''
    try { pane = Bun.spawnSync(['tmux', 'capture-pane', '-t', tmux, '-p', '-S', '-30']).stdout.toString() } catch {}
    if (/Switch model\?/i.test(pane)) {
      try { await Bun.spawn(['tmux', 'send-keys', '-t', tmux, 'Enter'], { stdio: ['ignore', 'ignore', 'ignore'] }).exited } catch {}
      break
    }
    if (/Set model to/i.test(pane)) break
  }
  await gateway.send(msg.channelId, `⚙️ model → \`${resolved}\``, { replyTo: msg.id }).catch(() => {})
}

export async function handleEffortIntercept(msg: InboundMessage, arg: string): Promise<void> {
  const level = arg.trim().toLowerCase()
  const info = targetSession(msg)
  if (isCodex(info)) {
    if (level !== 'default' && !CODEX_EFFORT_LEVELS.has(level)) {
      await gateway.send(msg.channelId, `Codex effort must be one of: ${[...CODEX_EFFORT_LEVELS].join(', ')}, default`, { replyTo: msg.id }).catch(() => {})
      return
    }
    try {
      const config = await configureCodex(info, { effort: level === 'default' ? null : level })
      await gateway.send(msg.channelId, `⚙️ Codex effort → \`${config.effort}\` _(applies on the next turn)_`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      await gateway.send(msg.channelId, `❌ Could not change Codex effort: ${error instanceof Error ? error.message : String(error)}`, { replyTo: msg.id }).catch(() => {})
    }
    return
  }

  if (!EFFORT_LEVELS.has(level)) {
    await gateway.send(msg.channelId, `effort must be one of: ${[...EFFORT_LEVELS].join(', ')}`, { replyTo: msg.id }).catch(() => {})
    return
  }
  await sendSlash(targetTmux(msg), `/effort ${level}`)
  await gateway.send(msg.channelId, `⚙️ effort → \`${level}\``, { replyTo: msg.id }).catch(() => {})
}

export async function handleContextIntercept(msg: InboundMessage): Promise<void> {
  const info = targetSession(msg)
  if (isCodex(info)) {
    try {
      const usage = await codexUsage(info)
      if (!usage) {
        await gateway.send(msg.channelId, `📊 Codex context — \`${info.tmuxName}\`\nNo token data yet; it becomes available after a completed turn.`, { replyTo: msg.id }).catch(() => {})
        return
      }
      const percent = usage.window ? Math.min(100, Math.round(usage.used / usage.window * 100)) : undefined
      const summary = [
        `used \`${usage.used.toLocaleString('en-US')}\`${usage.window ? ` / \`${usage.window.toLocaleString('en-US')}\` (${percent}%)` : ''}`,
        `input \`${usage.input.toLocaleString('en-US')}\` · cached \`${usage.cached.toLocaleString('en-US')}\` · output \`${usage.output.toLocaleString('en-US')}\``,
      ].join('\n')
      await gateway.send(msg.channelId, `📊 Codex context — \`${info.tmuxName}\`\n${summary}`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      await gateway.send(msg.channelId, `❌ Could not read Codex context: ${error instanceof Error ? error.message : String(error)}`, { replyTo: msg.id }).catch(() => {})
    }
    return
  }

  const tmux = targetTmux(msg)
  await sendSlash(tmux, '/context')
  await new Promise(r => setTimeout(r, 1800))
  let pane = ''
  try { pane = Bun.spawnSync(['tmux', 'capture-pane', '-t', tmux, '-p', '-J']).stdout.toString() } catch {}
  try { Bun.spawn(['tmux', 'send-keys', '-t', tmux, 'Escape'], { stdio: ['pipe', 'pipe', 'pipe'] }) } catch {}
  const relevant = pane.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim())
    .filter(l => /(context|token|%|used|free|System|Tools|Messages|Memory|MCP|Reserved|prompt|cache)/i.test(l))
    .slice(0, 22)
  const body = relevant.length
    ? '```\n' + relevant.join('\n').slice(0, 1800) + '\n```'
    : '(could not read the context overlay — try again when the session is idle)'
  await gateway.send(msg.channelId, `📊 context — \`${tmux}\`\n${body}`, { replyTo: msg.id }).catch(() => {})
}

/** /clear — wipe the session's conversation context in place (CC's own /clear). Same process, memory reloads. */
export async function handleClearIntercept(msg: InboundMessage): Promise<void> {
  const info = targetSession(msg)
  if (isCodex(info)) {
    try {
      await clearCodex(info)
      await gateway.send(msg.channelId, '🧹 Codex context cleared — the next message starts a fresh conversation in this thread.', { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      await gateway.send(msg.channelId, `❌ Could not clear Codex context: ${error instanceof Error ? error.message : String(error)}`, { replyTo: msg.id }).catch(() => {})
    }
    return
  }
  await sendSlash(targetTmux(msg), '/clear')
  await gateway.send(msg.channelId, `🧹 context cleared — fresh conversation, memory reloads on the next message.`, { replyTo: msg.id }).catch(() => {})
}

/** Detached full down+up so it outlives the daemon+byte it stops. Inherits the
 * daemon's env (which sourced .env at startup), so up() gets the right config. */
function rebootDetached(): void {
  const hydraDir = resolve(import.meta.dir, '..', '..')
  const bun = process.execPath
  const cmd = `cd '${hydraDir}' && '${bun}' cli/hydra.ts down ${PLATFORM} && '${bun}' cli/hydra.ts up ${PLATFORM}`
  try {
    Bun.spawn(['bash', '-c', cmd], { detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env } }).unref()
  } catch (err) {
    process.stderr.write(`daemon: reboot spawn failed: ${err}\n`)
  }
}

/** /reboot — FULL restart: daemon + a fresh byte process (down then up).
 * (`hydra restart` is daemon-only, so it wouldn't give the byte a fresh process.) */
export async function handleRebootIntercept(msg: InboundMessage): Promise<void> {
  await gateway.react(msg.channelId, msg.id, '♻️').catch(() => {})
  await gateway.send(msg.channelId, `♻️ rebooting hydra (daemon + fresh byte) — back in ~15s...`, { replyTo: msg.id }).catch(() => {})
  rebootDetached()
}

/** /ultracode on|off — toggle the persistent ultracode mode (xhigh + auto workflows); reboots to apply.
 * Keyword trigger stays on regardless, so "ultracode" in any message opts that one turn in. */
export async function handleUltracodeIntercept(msg: InboundMessage, arg: string): Promise<void> {
  const a = arg.trim().toLowerCase()
  if (a !== 'on' && a !== 'off') {
    await gateway.send(msg.channelId, `usage: \`/ultracode on\` or \`/ultracode off\``, { replyTo: msg.id }).catch(() => {})
    return
  }
  const on = a === 'on'
  const info = targetSession(msg)
  if (isCodex(info)) {
    try {
      const config = await configureCodex(info, { effort: on ? 'ultra' : null })
      await gateway.send(msg.channelId, `🚀 Codex effort → \`${config.effort}\` _(applies on the next turn)_`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      await gateway.send(msg.channelId, `❌ Could not change Codex effort: ${error instanceof Error ? error.message : String(error)}`, { replyTo: msg.id }).catch(() => {})
    }
    return
  }
  const settingsPath = join(CLAUDE_CONFIG, 'settings.json')
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    s.ultracode = on
    writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  } catch (err) {
    await gateway.send(msg.channelId, `failed to update settings: ${err}`, { replyTo: msg.id }).catch(() => {})
    return
  }
  await gateway.react(msg.channelId, msg.id, on ? '🚀' : '🐢').catch(() => {})
  await gateway.send(msg.channelId,
    `ultracode → **${on ? 'ON' : 'OFF'}** ${on ? '(xhigh effort + auto multi-agent workflows)' : '(normal)'} — rebooting byte to apply (~15s).\n_Tip: include the word "ultracode" in any message to trigger it for that one request without flipping this._`,
    { replyTo: msg.id }).catch(() => {})
  rebootDetached()
}
