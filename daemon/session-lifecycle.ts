import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG, SOCK_PATH } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import type { SessionInfo, SessionCapabilities, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession, SPAWN_MODEL } from './bridge-dispatch.js'

// ---------------------------------------------------------------------------
// Kill guard
// ---------------------------------------------------------------------------

export const killsInProgress = new Set<string>()

// ---------------------------------------------------------------------------
// Kill session
// ---------------------------------------------------------------------------

export async function killSession(info: SessionInfo, reason: string): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  try {
    try {
      await gateway.send(info.threadId, `_${reason}_`)
    } catch (err) {
      process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
    }

    const anchor = gateway.getThreadAnchor(info.threadId)
    if (anchor) {
      void gateway.react(anchor.channelId, anchor.messageId, '☠️').catch(() => {})
    }

    const tmuxName = info.tmuxName
    try {
      execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
    } catch {}

    transport.disconnect(info.sessionId)

    registry.deleteThread(info.threadId)
    registry.delete(info.sessionId)
    registry.persist()

    setTimeout(() => {
      try {
        execSync(`tmux has-session -t "${tmuxName}"`, { stdio: 'pipe' })
        execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
        process.stderr.write(`daemon: deferred kill caught lingering tmux session "${tmuxName}"\n`)
      } catch {}
      killsInProgress.delete(info.sessionId)
    }, 3000)
  } catch (err) {
    killsInProgress.delete(info.sessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

/** Unified session creation -- spawn, fork, and handoff all flow through here via SpawnOpts. */
export async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  let threadId: string | undefined
  let anchorMessageId: string | undefined

  const sessionId = randomUUID()
  const tmuxName = registry.pickSessionName()
  const threadName = `${tmuxName}: ${topic}`.slice(0, 100)
  const isFork = !!opts?.forkFrom
  const isHandoff = !!opts?.handedOffFrom
  const isResurrect = !!opts?.existingThreadId
  const originType: SessionInfo['originType'] = isFork ? 'fork' : isHandoff ? 'handoff' : isResurrect ? 'resurrect' : 'spawn'
  const originFrom = opts?.forkFrom?.parentName ?? opts?.handedOffFrom ?? opts?.resurrectFrom

  // Resurrect: reattach to existing thread — skip all thread creation.
  // anchorMessageId is intentionally left undefined: resurrected sessions don't own
  // an anchor message, so the onMessageDelete anchor guard is correctly a no-op.
  if (isResurrect) {
    threadId = opts!.existingThreadId!
  }

  if (!threadId) {
  // Determine where to create the thread
  let targetChannelId = chatId
  if (targetChannelId) {
    try {
      const ch = await gateway.fetchChannel(targetChannelId)
      if (ch.isThread) {
        threadId = ch.id
      } else if (ch.isDM && !gateway.canThreadInDM) {
        // DMs can't host threads on this platform -- redirect to a guild channel
        targetChannelId = DEFAULT_SESSION_CHANNEL
      }
    } catch {
      targetChannelId = DEFAULT_SESSION_CHANNEL
    }
  } else {
    targetChannelId = DEFAULT_SESSION_CHANNEL
  }

  // Clean up dead session in this thread before spawning
  let respawnCount = 0
  if (threadId) {
    const staleId = registry.getByThread(threadId)
    if (staleId) {
      const stale = registry.get(staleId)
      if (stale) {
        try { execSync(`tmux has-session -t '${stale.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {
          respawnCount = (stale.respawnCount ?? 0) + 1
          const anchor = gateway.getThreadAnchor(threadId)
          if (anchor) {
            void gateway.unreact(anchor.channelId, anchor.messageId, '☠️').catch(() => {})
            const COUNT_EMOJI = ['2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '👨‍👩‍👦‍👦']
            const idx = Math.min(respawnCount - 1, COUNT_EMOJI.length - 1)
            void gateway.react(anchor.channelId, anchor.messageId, COUNT_EMOJI[idx]).catch(() => {})
            if (respawnCount > 1) {
              void gateway.unreact(anchor.channelId, anchor.messageId, COUNT_EMOJI[Math.min(respawnCount - 2, COUNT_EMOJI.length - 1)]).catch(() => {})
            }
          }
          await killSession(stale, 'replaced by new spawn')
        }
      }
    }
  }

  // Create thread if we don't have one yet
  if (!threadId) {
    if (messageId && targetChannelId === chatId) {
      try {
        const thread = await gateway.createThread(targetChannelId!, threadName, {
          messageId,
          archiveDuration: 1440,
        })
        threadId = thread.id
        anchorMessageId = messageId
      } catch (err) {
        process.stderr.write(`daemon: createThread on message failed: ${err}\n`)
      }
    }

    if (!threadId) {
      const e = sessionEmoji(tmuxName)
      let anchorText: string
      if (originFrom) {
        const pe = sessionEmoji(originFrom)
        const verb = isHandoff ? 'handed off from' : 'forked from'
        anchorText = `${e} \`${tmuxName}\` — ${verb} ${pe} \`${originFrom}\``
        if (isFork) anchorText += `\n${topic}`
      } else {
        anchorText = `Starting session **${tmuxName}**: ${topic}`
      }
      const anchor = await gateway.send(targetChannelId!, anchorText)
      anchorMessageId = anchor.id
      const thread = await gateway.createThread(targetChannelId!, threadName, {
        messageId: anchor.id,
        archiveDuration: 1440,
      })
      threadId = thread.id
    }
  }
  }

  const channelFlag = `plugin:discord@claude-plugins-official`
  const spawnCwd = process.env.SPAWN_CWD
  if (!spawnCwd) throw new Error('SPAWN_CWD env var is required -- set it to the working directory for spawned sessions')

  // POSIX single-quote helper: wraps any string so the shell treats it 100% literally.
  const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

  let prompt: string
  if (isHandoff) {
    const contextLine = opts!.artifact
      ? `Read your handoff context from \`${opts!.artifact}\`, then read your memory files.`
      : `Read your memory files and workstream canon for context.`
    prompt = [
      `You are ${tmuxName}, a session created by handoff from ${originFrom}. Topic: ${topic}`,
      ``,
      `Your chat thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `${contextLine}`,
      `After reading the artifact, append a "### Reception (by ${tmuxName})" section to the artifact file noting what oriented you immediately, what needed code verification, and what was missing.`,
      `Send a greeting to your thread using reply(chat_id=${threadId}). In your greeting, include one sentence on what the previous session was working on and one sentence on where this session is heading.`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
      `After greeting, begin executing the Next action from the artifact immediately. Do not wait for user input unless there are critical questions that need the user's answer.`,
    ].join('\n')
  } else if (isFork) {
    prompt = [
      `You are ${tmuxName}, forked from ${originFrom}.`,
      `Topic: ${topic}`,
      ``,
      `Your new thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `Greet your new thread using reply(chat_id=${threadId}).`,
      `Mention you were forked from **${originFrom}** and describe your focus.`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
    ].join('\n')
  } else if (isResurrect) {
    prompt = [
      `You are ${tmuxName}, a resurrected session resuming work in an existing thread.`,
      ``,
      `Your chat thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `Read your memory files for context.`,
      `Use fetch_messages(channel="${threadId}", limit=50) to read the thread history.`,
      `Reconstruct context and continue from where the previous session left off.`,
      `Post a summary of what you found and what you're picking up using reply(chat_id=${threadId}).`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
    ].join('\n')
  } else {
    prompt = `You are ${tmuxName}, a spawned session. Topic: ${topic}\n\nYour chat thread chat_id is ${threadId}. Your session_id is ${sessionId}. Read your memory files for context, then send a greeting to your thread using reply(chat_id=${threadId}). After orienting, call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary of what you're doing. Update it if your focus shifts significantly.`
  }

  // Build claude command -- fork adds --resume --fork-session
  const claudeArgs = isFork
    ? [
        `claude`,
        `--resume ${shq(opts!.forkFrom!.claudeSessionId)}`,
        `--fork-session`,
        `--model ${shq(SPAWN_MODEL)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
        shq(prompt),
      ].join(' ')
    : `claude --model ${shq(SPAWN_MODEL)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}`

  const inner = [
    `cd ${shq(spawnCwd)}`,
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    claudeArgs,
  ].join(' && ')

  process.stderr.write(`daemon: spawn ${tmuxName}: running tmux new-session\n`)
  process.stderr.write(`daemon: spawn ${tmuxName}: inner cmd = ${inner.slice(0, 300)}...\n`)

  try {
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, inner], { stdio: 'pipe' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn ${tmuxName}: execFileSync FAILED: ${msg}\n`)
    throw new Error(`failed to spawn tmux session: ${msg}`)
  }

  // Verify the tmux session actually exists after creation
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
    process.stderr.write(`daemon: spawn ${tmuxName}: tmux session confirmed alive\n`)
  } catch {
    process.stderr.write(`daemon: spawn ${tmuxName}: WARNING -- tmux session died immediately after creation\n`)
  }

  const now = Date.now()
  const capabilities: SessionCapabilities = {
    role: 'worker',
    tools: computeToolsForSession(sessionId).map(t => t.name),
    model: SPAWN_MODEL,
    cwd: spawnCwd,
    platform: PLATFORM,
  }
  const url = await gateway.getThreadUrl(threadId!)

  registry.set(sessionId, {
    sessionId, topic, threadId: threadId!, anchorMessageId, createdAt: now, lastActive: now,
    tmuxName, listening: false, originType, originFrom, threadUrl: url || undefined, capabilities,
    ...(respawnCount > 0 ? { respawnCount } : {}),
  })
  registry.setThread(threadId!, sessionId)
  registry.persist()

  return { name: tmuxName, sessionId, threadId: threadId!, url }
}

// ---------------------------------------------------------------------------
// Claude session ID discovery
// ---------------------------------------------------------------------------

export function discoverClaudeSessionId(tmuxName: string): string | null {
  try {
    const panePid = execSync(`tmux list-panes -t '${tmuxName}' -F '#{pane_pid}' 2>/dev/null`, { encoding: 'utf8' }).trim()
    if (!panePid) return null
    const childPids = execSync(`pgrep -P ${panePid} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    for (const childPid of childPids) {
      const envOutput = execSync(`ps -E -p ${childPid} 2>/dev/null`, { encoding: 'utf8' })
      if (!envOutput.includes('HYDRA_SESSION_ID')) continue
      const hydraId = envOutput.match(/HYDRA_SESSION_ID=([^\s]+)/)?.[1]
      const candidates = [...envOutput.matchAll(/([A-Z_]*SESSION[A-Z_]*)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)]
      const claudeId = candidates.find(m => m[2] !== hydraId)?.[2]
      if (claudeId) return claudeId
    }
    return null
  } catch {
    return null
  }
}
