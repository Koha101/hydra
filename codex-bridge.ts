#!/usr/bin/env bun
/**
 * Persistent Hydra bridge for Codex CLI sessions.
 *
 * The daemon still owns Discord and routing. This process owns one Codex
 * conversation, turns daemon notifications into `codex exec`/`resume` calls,
 * and relays each final agent message through Hydra's existing reply tool.
 */

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { connect, type Socket } from 'net'
import { homedir } from 'os'
import { join } from 'path'
import { CODEX_EFFORT_LEVELS } from './shared/constants.js'

export type Notification = { content: string; meta: Record<string, string> }
type PendingCall = {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const sessionId = readArg('--session-id') ?? process.env.HYDRA_SESSION_ID
const sessionName = readArg('--session-name') ?? process.env.HYDRA_SESSION_NAME ?? 'codex'
const initialPrompt = readArg('--prompt')
const initialChatId = readArg('--chat-id')
export type CodexRuntimeConfig = {
  model?: string
  effort?: string
}

export type CodexContextUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  usedTokens: number
  contextWindow?: number
}

let runtimeConfig: CodexRuntimeConfig = {
  model: readArg('--model'),
  effort: readArg('--effort'),
}
let codexSessionId = readArg('--resume')
const socketPath = process.env.DAEMON_SOCK

if (import.meta.main && (!sessionId || !initialChatId || !socketPath)) {
  process.stderr.write('codex-bridge: --session-id, --chat-id, and DAEMON_SOCK are required\n')
  process.exit(1)
}

let socket: Socket | null = null
let socketReady = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lineBuffer = ''
let running = false
let initialQueued = false
let shuttingDown = false
let currentProcess: ReturnType<typeof Bun.spawn> | null = null
const notifications: Notification[] = []
const pendingCalls = new Map<string, PendingCall>()
let latestContextUsage: CodexContextUsage | undefined
let reloadInitialContext = false

const CLAUDE_CONTEXT_MAX_BYTES = 32 * 1024

function send(message: Record<string, unknown>): void {
  if (!socket || socket.destroyed) throw new Error('daemon socket is not connected')
  socket.write(JSON.stringify(message) + '\n')
}

function register(): void {
  send({
    type: 'register',
    sessionId,
    provider: 'codex',
    model: runtimeConfig.model ?? 'default',
    effort: runtimeConfig.effort ?? 'default',
    ...(codexSessionId ? { codexSessionId } : {}),
  })
}

function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!socketReady) return Promise.reject(new Error('daemon socket is not ready'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id)
      reject(new Error(`timed out waiting for ${name}`))
    }, 60_000)
    pendingCalls.set(id, { resolve, reject, timer })
    send({ type: 'tool_call', id, name, args })
  })
}

function normalizeContextUsage(value: unknown, contextWindow?: unknown): CodexContextUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const cachedInputTokens = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  const reasoningOutputTokens = typeof usage.reasoning_output_tokens === 'number' ? usage.reasoning_output_tokens : 0
  const usedTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens
  if (usedTokens <= 0 && inputTokens <= 0) return undefined
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    usedTokens,
    ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
  }
}

export function parseCodexContextUsage(output: string): CodexContextUsage | undefined {
  let result: CodexContextUsage | undefined
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as any
      if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
        const info = event.payload.info
        result = normalizeContextUsage(info?.last_token_usage, info?.model_context_window) ?? result
      }
    } catch {}
  }
  return result
}

function loadCodexContextUsage(codexId: string): CodexContextUsage | undefined {
  const sessionsRoot = join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'sessions')
  try {
    const glob = new Bun.Glob(`**/*${codexId}*.jsonl`)
    let newest: { path: string; modified: number } | undefined
    for (const relative of glob.scanSync({ cwd: sessionsRoot })) {
      const path = join(sessionsRoot, relative)
      const modified = Bun.file(path).lastModified
      if (!newest || modified > newest.modified) newest = { path, modified }
    }
    return newest ? parseCodexContextUsage(readFileSync(newest.path, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

export function parseCodexEvents(output: string): { threadId?: string; finalMessage?: string; usage?: CodexContextUsage } {
  let threadId: string | undefined
  let finalMessage: string | undefined
  let usage: CodexContextUsage | undefined
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as any
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        threadId = event.thread_id
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        finalMessage = event.item.text
      }
      if (event.type === 'turn.completed') {
        usage = normalizeContextUsage(event.usage) ?? usage
      }
    } catch {}
  }
  return { threadId, finalMessage, ...(usage ? { usage } : {}) }
}

export function claudeProjectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function readClaudeContext(path: string): { path: string; content: string } | undefined {
  try {
    const content = readFileSync(path).subarray(0, CLAUDE_CONTEXT_MAX_BYTES).toString('utf8').trim()
    return content ? { path, content } : undefined
  } catch {
    return undefined
  }
}

export function loadWorkspaceClaudeInstructions(
  workspace = process.env.SPAWN_CWD?.trim() || process.cwd(),
  explicitPath = process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE?.trim(),
): { path: string; content: string } | undefined {
  return readClaudeContext(explicitPath || join(workspace, 'CLAUDE.md'))
}

export function loadClaudeMemoryIndex(
  workspace = process.env.SPAWN_CWD?.trim() || process.cwd(),
  explicitPath = process.env.CODEX_CLAUDE_MEMORY_FILE?.trim(),
): { path: string; content: string } | undefined {
  const path = explicitPath || join(homedir(), '.claude', 'projects', claudeProjectSlug(workspace), 'memory', 'MEMORY.md')
  return readClaudeContext(path)
}

export function notificationPrompt(notification: Notification): string {
  const { content, meta } = notification
  const instructions = meta.hydra_initial === 'true' ? loadWorkspaceClaudeInstructions() : undefined
  const memory = meta.hydra_initial === 'true' ? loadClaudeMemoryIndex() : undefined
  const details = [
    instructions ? [
      `Workspace instructions (${instructions.path}):`,
      'These instructions apply to this job. Current explicit user instructions take precedence.',
      instructions.content,
      '',
    ].join('\n') : '',
    memory ? [
      `Claude Code project memory index (${memory.path}):`,
      'Use this as background context. Read linked files from the same memory directory only when relevant; current user instructions and repository state take precedence.',
      memory.content,
      '',
    ].join('\n') : '',
    `Discord message from ${meta.user ?? 'user'}:`,
    content,
    meta.attachments ? `Attachments: ${meta.attachments}` : '',
    meta.downloaded_files ? `Downloaded files available locally: ${meta.downloaded_files}` : '',
    '',
    'Respond to the user. Your final response is sent directly to Discord by Hydra.',
  ].filter(Boolean)
  return details.join('\n')
}

export function applyCodexSessionConfig(
  current: CodexRuntimeConfig,
  message: Record<string, unknown>,
): CodexRuntimeConfig {
  const next = { ...current }
  if (Object.prototype.hasOwnProperty.call(message, 'model')) {
    if (message.model === null) delete next.model
    else if (typeof message.model === 'string' && message.model.trim()) next.model = message.model.trim()
    else throw new Error('model must be a non-empty string or default')
  }
  if (Object.prototype.hasOwnProperty.call(message, 'effort')) {
    if (message.effort === null) delete next.effort
    else if (typeof message.effort === 'string' && CODEX_EFFORT_LEVELS.has(message.effort)) next.effort = message.effort
    else throw new Error(`effort must be one of: ${[...CODEX_EFFORT_LEVELS].join(', ')}, default`)
  }
  return next
}

export function buildCodexArgs(
  prompt: string,
  config: CodexRuntimeConfig,
  resumeId?: string,
): string[] {
  const configArgs = [
    ...(config.model ? ['--model', config.model] : []),
    ...(config.effort ? ['--config', `model_reasoning_effort="${config.effort}"`] : []),
  ]
  return resumeId
    ? ['codex', 'exec', 'resume', '--json', '--skip-git-repo-check', ...configArgs, resumeId, prompt]
    : ['codex', 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', ...configArgs, prompt]
}

async function runCodex(prompt: string): Promise<string> {
  const args = buildCodexArgs(prompt, runtimeConfig, codexSessionId)

  process.stderr.write(`codex-bridge: ${codexSessionId ? 'resuming' : 'starting'} Codex turn for ${sessionName}\n`)
  currentProcess = Bun.spawn(args, {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(currentProcess.stdout).text(),
    new Response(currentProcess.stderr).text(),
    currentProcess.exited,
  ])
  currentProcess = null

  const parsed = parseCodexEvents(stdout)
  if (parsed.threadId && parsed.threadId !== codexSessionId) {
    codexSessionId = parsed.threadId
    if (socketReady) send({ type: 'session_identity', sessionId, provider: 'codex', codexSessionId })
  }
  const persistedUsage = codexSessionId ? loadCodexContextUsage(codexSessionId) : undefined
  latestContextUsage = persistedUsage
    ?? (parsed.usage ? {
      ...parsed.usage,
      ...(parsed.usage.contextWindow
        ? {}
        : latestContextUsage?.contextWindow ? { contextWindow: latestContextUsage.contextWindow } : {}),
    } : latestContextUsage)
  if (exitCode !== 0) {
    const detail = stderr.trim().slice(-1500) || `Codex exited with code ${exitCode}`
    throw new Error(detail)
  }
  if (!parsed.finalMessage?.trim()) throw new Error('Codex completed without a final message')
  return parsed.finalMessage.trim()
}

async function processQueue(): Promise<void> {
  if (running || shuttingDown || !socketReady) return
  const next = notifications.shift()
  if (!next) return
  running = true
  const prepared = reloadInitialContext
    ? { ...next, meta: { ...next.meta, hydra_initial: 'true' } }
    : next
  try {
    const response = await runCodex(notificationPrompt(prepared))
    await callTool('reply', { chat_id: next.meta.chat_id ?? initialChatId, text: response })
    process.stderr.write(`codex-bridge: completed Codex turn and replied for ${sessionName}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`codex-bridge: turn failed: ${message}\n`)
    try {
      await callTool('reply', {
        chat_id: next.meta.chat_id ?? initialChatId,
        text: `Codex session failed: ${message.slice(0, 1200)}`,
      })
    } catch {}
  } finally {
    if (reloadInitialContext && codexSessionId) reloadInitialContext = false
    running = false
    void processQueue()
  }
}

function handleMessage(message: Record<string, unknown>): void {
  switch (message.type) {
    case 'registered':
      socketReady = true
      if (initialPrompt && !initialQueued) {
        initialQueued = true
        notifications.push({ content: initialPrompt, meta: { chat_id: initialChatId!, user: 'system', hydra_initial: 'true' } })
      }
      void processQueue()
      break
    case 'notification':
      notifications.push({
        content: String(message.content ?? ''),
        meta: (message.meta ?? {}) as Record<string, string>,
      })
      void processQueue()
      break
    case 'session_config': {
      const id = typeof message.id === 'string' ? message.id : ''
      try {
        runtimeConfig = applyCodexSessionConfig(runtimeConfig, message)
        send({
          type: 'session_config_result',
          id,
          ok: true,
          model: runtimeConfig.model ?? 'default',
          effort: runtimeConfig.effort ?? 'default',
        })
      } catch (error) {
        send({
          type: 'session_config_result',
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }
    case 'session_control': {
      const id = typeof message.id === 'string' ? message.id : ''
      const action = message.action
      if (action === 'context') {
        latestContextUsage = latestContextUsage
          ?? (codexSessionId ? loadCodexContextUsage(codexSessionId) : undefined)
        send({
          type: 'session_control_result',
          id,
          action,
          ok: true,
          codexSessionId: codexSessionId ?? null,
          usage: latestContextUsage ?? null,
        })
      } else if (action === 'clear') {
        if (running) {
          send({ type: 'session_control_result', id, action, ok: false, error: 'Codex is busy; retry /clear after the current turn finishes' })
          break
        }
        const previousSessionId = codexSessionId
        codexSessionId = undefined
        latestContextUsage = undefined
        reloadInitialContext = true
        send({ type: 'session_identity', sessionId, provider: 'codex', codexSessionId: null })
        send({ type: 'session_control_result', id, action, ok: true, previousSessionId: previousSessionId ?? null })
      } else {
        send({ type: 'session_control_result', id, action, ok: false, error: 'unknown Codex session control action' })
      }
      break
    }
    case 'tool_result': {
      const id = String(message.id ?? '')
      const pending = pendingCalls.get(id)
      if (!pending) break
      clearTimeout(pending.timer)
      pendingCalls.delete(id)
      if (message.isError) pending.reject(new Error(JSON.stringify(message.content)))
      else pending.resolve(message)
      break
    }
  }
}

function connectSocket(): void {
  if (shuttingDown || (socket && !socket.destroyed)) return
  socket = connect(socketPath!)
  socket.on('connect', () => {
    lineBuffer = ''
    register()
  })
  socket.on('data', data => {
    lineBuffer += data.toString()
    let newline: number
    while ((newline = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, newline).trim()
      lineBuffer = lineBuffer.slice(newline + 1)
      if (!line) continue
      try { handleMessage(JSON.parse(line)) } catch (error) {
        process.stderr.write(`codex-bridge: invalid daemon message: ${error}\n`)
      }
    }
  })
  socket.on('error', error => process.stderr.write(`codex-bridge: socket error: ${error.message}\n`))
  socket.on('close', () => {
    socketReady = false
    socket = null
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timer)
      pending.reject(new Error('daemon connection lost'))
      pendingCalls.delete(id)
    }
    if (!shuttingDown && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connectSocket()
      }, 2000)
    }
  })
}

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  try { currentProcess?.kill() } catch {}
  try { socket?.destroy() } catch {}
  setTimeout(() => process.exit(0), 250)
}

if (import.meta.main) {
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGHUP', shutdown)
  connectSocket()
}
