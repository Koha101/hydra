// Chat commands that reconfigure a running session by typing Claude Code's own
// slash commands into its tmux pane: /model, /effort, /context.
// Targets the thread's live session when used in a thread, else the main byte.
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { gateway, PLATFORM, CLAUDE_CONFIG } from '../config.js'
import { registry } from '../sessions.js'
import { resolveModelAlias, EFFORT_LEVELS } from '../../shared/constants.js'
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

/** Type a slash command into a tmux pane and submit it (Escape clears any partial input first). */
function sendSlash(tmux: string, line: string): void {
  const opts = { stdio: ['pipe', 'pipe', 'pipe'] as const }
  try {
    Bun.spawn(['tmux', 'send-keys', '-t', tmux, 'Escape'], opts)
    Bun.spawn(['tmux', 'send-keys', '-t', tmux, '-l', line], opts)
    Bun.spawn(['tmux', 'send-keys', '-t', tmux, 'Enter'], opts)
  } catch (err) {
    process.stderr.write(`daemon: sendSlash failed for ${tmux}: ${err}\n`)
  }
}

export async function handleModelIntercept(msg: InboundMessage, arg: string): Promise<void> {
  const resolved = resolveModelAlias(arg.trim()) ?? arg.trim()
  sendSlash(targetTmux(msg), `/model ${resolved}`)
  await gateway.send(msg.channelId, `⚙️ model → \`${resolved}\``, { replyTo: msg.id }).catch(() => {})
}

export async function handleEffortIntercept(msg: InboundMessage, arg: string): Promise<void> {
  const level = arg.trim().toLowerCase()
  if (!EFFORT_LEVELS.has(level)) {
    await gateway.send(msg.channelId, `effort must be one of: ${[...EFFORT_LEVELS].join(', ')}`, { replyTo: msg.id }).catch(() => {})
    return
  }
  sendSlash(targetTmux(msg), `/effort ${level}`)
  await gateway.send(msg.channelId, `⚙️ effort → \`${level}\``, { replyTo: msg.id }).catch(() => {})
}

export async function handleContextIntercept(msg: InboundMessage): Promise<void> {
  const tmux = targetTmux(msg)
  sendSlash(tmux, '/context')
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
  sendSlash(targetTmux(msg), '/clear')
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
