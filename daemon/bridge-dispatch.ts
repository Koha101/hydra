import { statSync } from 'fs'
import { gateway, INBOX_DIR } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { loadAccess, maxChunkLimit, MAX_ATTACHMENT_BYTES } from './access.js'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, getContextPercent, chunk, assertSendable, isAlive } from './util.js'
import { watchPr, unwatchPr, listWatches, getWatchesBySession, formatWatchEntry, detectPrUrl, WATCH_ERRORS } from './pr-watch.js'
import { refreshSessionVisual } from './anchor-state.js'

const SEND_RETRY_ATTEMPTS = 3
const SEND_RETRY_BASE_MS = 1_000
const RETRYABLE_PATTERNS = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|socket hang up|not connected|network/i

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return RETRYABLE_PATTERNS.test(msg)
}

async function retrySend<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < SEND_RETRY_ATTEMPTS; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === SEND_RETRY_ATTEMPTS - 1 || !isRetryable(err)) throw err
      const delay = SEND_RETRY_BASE_MS * Math.pow(2, i)
      process.stderr.write(`daemon: send failed (attempt ${i + 1}/${SEND_RETRY_ATTEMPTS}), retrying in ${delay}ms: ${err instanceof Error ? err.message : err}\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export type ToolResult = { content: Array<{type: string; text: string}>; isError?: boolean; sentIds?: string[] }

export async function executeTool(name: string, args: Record<string, unknown>, callerSessionId?: string): Promise<ToolResult> {
  try {
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        const ch = await gateway.fetchChannel(chat_id)
        const access = loadAccess()
        if (ch.isDM) {
          if (!access.allowFrom.includes(ch.recipientId)) {
            throw new Error(`channel ${chat_id} is not allowlisted`)
          }
        } else {
          const key = ch.isThread ? ch.parentId ?? ch.id : ch.id
          if (!(key in access.groups)) {
            throw new Error(`channel ${chat_id} is not allowlisted`)
          }
        }

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('max 10 attachments per message')

        const limit = Math.max(1, Math.min(access.textChunkLimit ?? maxChunkLimit(), maxChunkLimit()))
        const mode = access.chunkMode ?? 'markdown'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo =
              reply_to != null &&
              replyMode !== 'off' &&
              (replyMode === 'all' || i === 0)
            const sent = await retrySend(() => gateway.send(chat_id, chunks[i], {
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo ? { replyTo: reply_to } : {}),
            }))
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        if (callerSessionId && sentIds.length > 0) {
          const info = registry.get(callerSessionId)
          if (info) {
            info.lastReplyId = sentIds[sentIds.length - 1]
            registry.debouncedPersist()
          }
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }], sentIds }
      }

      case 'fetch_messages': {
        const channelId = args.channel as string
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await gateway.fetchMessages(channelId, limit)
        const botId = gateway.botId
        const out =
          msgs.length === 0
            ? '(no messages)'
            : msgs
                .map(m => {
                  const who = m.authorId === botId ? 'me' : m.authorUsername
                  const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : ''
                  const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
                  return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
                })
                .join('\n')
        return { content: [{ type: 'text', text: out }] }
      }

      case 'react': {
        await retrySend(() => gateway.react(args.chat_id as string, args.message_id as string, args.emoji as string))
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'edit_message': {
        const edited = await retrySend(() => gateway.edit(args.chat_id as string, args.message_id as string, args.text as string))
        return { content: [{ type: 'text', text: `edited (id: ${edited})` }] }
      }

      case 'delete_message': {
        await gateway.delete(args.chat_id as string, args.message_id as string)
        return { content: [{ type: 'text', text: 'deleted' }] }
      }

      case 'create_thread': {
        const threadName = (args.name as string).slice(0, 100)
        const thread = await gateway.createThread(args.chat_id as string, threadName, {
          messageId: args.message_id as string | undefined,
          archiveDuration: (args.auto_archive_minutes as number | undefined) ?? 1440,
          text: args.text as string | undefined,
          files: (args.files as string[] | undefined),
        })
        return {
          content: [{
            type: 'text',
            text: `thread created (thread_id: ${thread.id})`,
          }],
        }
      }

      case 'download_attachment': {
        const results = await gateway.downloadAttachments(
          args.chat_id as string,
          args.message_id as string,
          INBOX_DIR,
        )
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'message has no attachments' }] }
        }
        const lines = results.map(r => `  ${r.path}  (${r.name}, ${r.contentType}, ${r.sizeKB}KB)`)
        return {
          content: [{ type: 'text', text: `downloaded ${results.length} attachment(s):\n${lines.join('\n')}` }],
        }
      }

      case 'spawn_session': {
        const worktree = args.worktree as string | undefined
        const topic = worktree ? `worktree:${worktree} ${args.topic}` : args.topic as string
        const model = (args.model as string | undefined)?.trim() || undefined
        if (model) process.stderr.write(`daemon: spawn_session model override: ${model}\n`)
        const result = await doSpawnSession(topic, args.chat_id as string | undefined, args.message_id as string | undefined, model ? { model } : undefined)
        return { content: [{ type: 'text', text: `session spawned (name: ${result.name}, session_id: ${result.sessionId}, thread_id: ${result.threadId}${result.url ? `, url: ${result.url}` : ''})` }] }
      }

      case 'list_sessions': {
        const sorted = [...registry.values()].filter(s => isAlive(s)).sort((a, b) => b.lastActive - a.lastActive)
        const list = sorted.map(s => {
          const desc = s.description ?? fallbackDescription(s.topic)
          return {
            name: s.tmuxName,
            description: desc,
            url: s.threadUrl ?? '',
            context: getContextPercent(s.tmuxName),
            messages: s.messageCount ?? 0,
            running_for: formatDuration(Date.now() - s.createdAt),
            status: transport.has(s.sessionId) ? 'connected' : 'disconnected',
          }
        })
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
      }

      case 'set_description': {
        const sessionId = args.session_id as string | undefined
        const description = args.description as string | undefined
        if (!sessionId || !description) throw new Error('session_id and description are required')
        const info = registry.get(sessionId)
        if (!info) throw new Error('session not found')
        info.description = description.slice(0, 120)
        registry.persist()
        refreshSessionVisual(info.threadId)
        return { content: [{ type: 'text', text: `description set for ${info.tmuxName}` }] }
      }

      case 'kill_session': {
        const sessionId = args.session_id as string | undefined
        const threadId = args.thread_id as string | undefined

        let targetId: string | undefined
        if (sessionId) {
          targetId = sessionId
        } else if (threadId) {
          targetId = registry.getByThread(threadId)
        }

        if (!targetId || !registry.has(targetId)) {
          throw new Error('session not found')
        }

        const info = registry.get(targetId)!
        await killSession(info, 'session ended')
        return { content: [{ type: 'text', text: `killed session ${targetId}` }] }
      }

      case 'watch_pr': {
        let prUrl = args.pr_url as string | undefined
        const sessionId = callerSessionId ?? 'main'
        const info = registry.get(sessionId)
        if (!prUrl) {
          const cwd = info?.capabilities?.cwd
          if (!cwd) throw new Error(WATCH_ERRORS.NO_CWD)
          const detected = await detectPrUrl(cwd)
          if (!detected.ok) throw new Error(detected.reason)
          prUrl = detected.url
        }
        const threadId = (args.chat_id as string | undefined) ?? info?.threadId ?? ''
        if (!threadId) throw new Error('could not determine thread — pass chat_id')
        const result = await watchPr(prUrl, sessionId, threadId)
        return { content: [{ type: 'text', text: result }] }
      }

      case 'unwatch_pr': {
        const result = unwatchPr(args.pr_url as string, callerSessionId)
        return { content: [{ type: 'text', text: result }] }
      }

      case 'list_watches': {
        const all = args.all as boolean | undefined
        const entries = all ? listWatches() : getWatchesBySession(callerSessionId ?? 'main')
        if (entries.length === 0) return { content: [{ type: 'text', text: 'no PRs being watched' }] }
        const lines = entries.map(e => `• ${formatWatchEntry(e)}`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}
