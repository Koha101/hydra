// Chat commands that reconfigure a running session. Claude sessions receive
// their native slash commands through tmux; Codex sessions use bridge control
// messages because their Hydra sidecar runs `codex exec` non-interactively.
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { gateway, PLATFORM, CLAUDE_CONFIG } from '../config.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { clearCodexContext, configureCodexSession, getCodexContext, type CodexConfigResult } from '../codex-control.js'
import { resolveModelAlias, EFFORT_LEVELS, CODEX_EFFORT_LEVELS } from '../../shared/constants.js'
import type { InboundMessage } from '../../gateway.js'

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

function persistCodexConfig(info: SessionInfo, result: CodexConfigResult): void {
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
  if (info?.provider === 'codex') {
    const requested = arg.trim()
    try {
      const result = await configureCodexSession(info.sessionId, {
        model: requested.toLowerCase() === 'default' ? null : requested,
      })
      persistCodexConfig(info, result)
      await gateway.send(msg.channelId, `⚙️ Codex model → \`${result.model}\` _(applies on the next turn)_`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await gateway.send(msg.channelId, `❌ Could not change Codex model: ${detail}`, { replyTo: msg.id }).catch(() => {})
    }
    return
  }

  const resolved = resolveModelAlias(arg.trim()) ?? arg.trim()
  const tmux = targetTmux(msg)
  await sendSlash(tmux, `/model ${resolved}`)
  // Claude Code shows a "Switch model?" confirmation when the change invalidates
  // the prompt cache. Confirm the highlighted default (Yes) after a beat so the
  // switch completes instead of leaving the pane parked on the modal. A stray
  // Enter on an empty composer (no confirmation shown) is a harmless no-op.
  await new Promise(r => setTimeout(r, 800))
  try { await Bun.spawn(['tmux', 'send-keys', '-t', tmux, 'Enter'], { stdio: ['ignore', 'ignore', 'ignore'] }).exited } catch {}
  await gateway.send(msg.channelId, `⚙️ model → \`${resolved}\``, { replyTo: msg.id }).catch(() => {})
}

export async function handleEffortIntercept(msg: InboundMessage, arg: string): Promise<void> {
  const level = arg.trim().toLowerCase()
  const info = targetSession(msg)
  if (info?.provider === 'codex') {
    if (level !== 'default' && !CODEX_EFFORT_LEVELS.has(level)) {
      await gateway.send(msg.channelId, `Codex effort must be one of: ${[...CODEX_EFFORT_LEVELS].join(', ')}, default`, { replyTo: msg.id }).catch(() => {})
      return
    }
    try {
      const result = await configureCodexSession(info.sessionId, {
        effort: level === 'default' ? null : level,
      })
      persistCodexConfig(info, result)
      await gateway.send(msg.channelId, `⚙️ Codex effort → \`${result.effort}\` _(applies on the next turn)_`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await gateway.send(msg.channelId, `❌ Could not change Codex effort: ${detail}`, { replyTo: msg.id }).catch(() => {})
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
  if (info?.provider === 'codex') {
    try {
      const result = await getCodexContext(info.sessionId)
      if (!result.usage) {
        await gateway.send(msg.channelId, `📊 Codex context — \`${info.tmuxName}\`\nNo token data yet; it becomes available after the first completed Codex turn.`, { replyTo: msg.id }).catch(() => {})
        return
      }
      const { usedTokens, contextWindow, inputTokens, cachedInputTokens, outputTokens } = result.usage
      const used = usedTokens.toLocaleString('en-US')
      const input = inputTokens.toLocaleString('en-US')
      const cached = cachedInputTokens.toLocaleString('en-US')
      const output = outputTokens.toLocaleString('en-US')
      const capacity = contextWindow && contextWindow > 0
        ? `${used} / ${contextWindow.toLocaleString('en-US')} tokens (${Math.min(100, usedTokens / contextWindow * 100).toFixed(1)}% used, ${Math.max(0, contextWindow - usedTokens).toLocaleString('en-US')} remaining)`
        : `${used} tokens used (context-window size unavailable)`
      await gateway.send(msg.channelId, `📊 Codex context — \`${info.tmuxName}\` _(latest available usage)_\n${capacity}\ninput ${input} · cached ${cached} · output ${output}`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await gateway.send(msg.channelId, `❌ Could not read Codex context: ${detail}`, { replyTo: msg.id }).catch(() => {})
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
  if (info?.provider === 'codex') {
    try {
      await clearCodexContext(info.sessionId)
      delete info.codexSessionId
      const thread = threadRegistry.get(info.threadId)
      const entry = thread?.sessionHistory.find(h => h.sessionId === info.sessionId && !h.endedAt)
      if (entry) delete entry.codexSessionId
      registry.persist()
      threadRegistry.persist()
      await gateway.send(msg.channelId, '🧹 Codex context cleared — the next message starts a fresh Codex conversation and reloads workspace instructions and memory.', { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await gateway.send(msg.channelId, `❌ Could not clear Codex context: ${detail}`, { replyTo: msg.id }).catch(() => {})
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

/** /ultracode on|off — Codex maps this to ultra/default effort; Claude
 * toggles its persistent ultracode mode and reboots the byte to apply. */
export async function handleUltracodeIntercept(msg: InboundMessage, arg: string): Promise<void> {
  const a = arg.trim().toLowerCase()
  if (a !== 'on' && a !== 'off') {
    await gateway.send(msg.channelId, `usage: \`/ultracode on\` or \`/ultracode off\``, { replyTo: msg.id }).catch(() => {})
    return
  }
  const on = a === 'on'
  const info = targetSession(msg)
  if (info?.provider === 'codex') {
    try {
      const result = await configureCodexSession(info.sessionId, { effort: on ? 'ultra' : null })
      persistCodexConfig(info, result)
      await gateway.react(msg.channelId, msg.id, on ? '🚀' : '🐢').catch(() => {})
      await gateway.send(msg.channelId, `Codex ultracode → **${on ? 'ON' : 'OFF'}** · effort \`${result.effort}\` _(applies on the next turn)_`, { replyTo: msg.id }).catch(() => {})
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await gateway.send(msg.channelId, `❌ Could not change Codex ultracode: ${detail}`, { replyTo: msg.id }).catch(() => {})
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
