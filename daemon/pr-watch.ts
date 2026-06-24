import { readFileSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { atomicWriteFileSync } from './util.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PRComment = {
  id: number
  user: string
  body: string
  path?: string
  line?: number
  createdAt: string
  url: string
}

type PRReview = {
  id: number
  user: string
  state: string // APPROVED, CHANGES_REQUESTED, COMMENTED
  body: string
  createdAt: string
}

export type WatchEntry = {
  prUrl: string
  owner: string
  repo: string
  prNumber: number
  sessionId: string
  threadId: string
  lastCheckedAt: string
  lastReviewCommentId: number
  lastIssueCommentId: number
  lastReviewId: number
  createdAt: number
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const watches = new Map<string, WatchEntry>()
const PERSIST_FILE = join(STATE_DIR, 'pr-watches.json')
const POLL_INTERVAL_MS = 3 * 60 * 1000
let pollTimer: ReturnType<typeof setInterval> | undefined

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist(): void {
  try {
    atomicWriteFileSync(PERSIST_FILE, JSON.stringify([...watches.values()], null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: persist failed: ${err}\n`)
  }
}

function loadPersisted(): void {
  try {
    const raw = readFileSync(PERSIST_FILE, 'utf8')
    const data = JSON.parse(raw) as WatchEntry[]
    for (const entry of data) {
      if (registry.has(entry.sessionId) || entry.sessionId === 'main') {
        watches.set(entry.prUrl, entry)
      }
    }
    if (watches.size > 0) {
      process.stderr.write(`daemon: pr-watch: restored ${watches.size} watch(es)\n`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`daemon: pr-watch: load failed: ${err}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// Parse PR URL → owner/repo/number
// ---------------------------------------------------------------------------

function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (match) {
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3]) }
  }
  return null
}

// ---------------------------------------------------------------------------
// GitHub API via gh CLI (async — does not block the event loop)
// ---------------------------------------------------------------------------

async function ghApi(endpoint: string): Promise<any> {
  try {
    const proc = Bun.spawn(['gh', 'api', endpoint], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      process.stderr.write(`daemon: pr-watch: gh api failed (exit ${exitCode}) for ${endpoint}: ${stderr.slice(0, 200)}\n`)
      return null
    }
    return JSON.parse(stdout)
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: gh api failed for ${endpoint}: ${err instanceof Error ? err.message : err}\n`)
    return null
  }
}

function maxId(items: any[] | null): number {
  if (!items || !Array.isArray(items) || items.length === 0) return 0
  return Math.max(...items.map((i: any) => i.id ?? 0))
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchNewReviewComments(entry: WatchEntry): Promise<PRComment[]> {
  const data = await ghApi(`repos/${entry.owner}/${entry.repo}/pulls/${entry.prNumber}/comments?since=${entry.lastCheckedAt}&per_page=100`)
  if (!data || !Array.isArray(data)) return []

  return data
    .filter((c: any) => c.id > entry.lastReviewCommentId)
    .map((c: any) => ({
      id: c.id,
      user: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      path: c.path,
      line: c.original_line ?? c.line,
      createdAt: c.created_at,
      url: c.html_url,
    }))
}

async function fetchNewReviews(entry: WatchEntry): Promise<PRReview[]> {
  const data = await ghApi(`repos/${entry.owner}/${entry.repo}/pulls/${entry.prNumber}/reviews?per_page=100`)
  if (!data || !Array.isArray(data)) return []

  return data
    .filter((r: any) => r.id > entry.lastReviewId && new Date(r.submitted_at) > new Date(entry.lastCheckedAt))
    .map((r: any) => ({
      id: r.id,
      user: r.user?.login ?? 'unknown',
      state: r.state,
      body: r.body ?? '',
      createdAt: r.submitted_at,
    }))
}

async function fetchNewIssueComments(entry: WatchEntry): Promise<PRComment[]> {
  const data = await ghApi(`repos/${entry.owner}/${entry.repo}/issues/${entry.prNumber}/comments?since=${entry.lastCheckedAt}&per_page=100`)
  if (!data || !Array.isArray(data)) return []

  return data
    .filter((c: any) => c.id > entry.lastIssueCommentId)
    .map((c: any) => ({
      id: c.id,
      user: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.created_at,
      url: c.html_url,
    }))
}

// ---------------------------------------------------------------------------
// Poll a single PR
// ---------------------------------------------------------------------------

async function pollPr(entry: WatchEntry): Promise<void> {
  const pollTime = new Date().toISOString()

  const [reviewComments, reviews, issueComments] = await Promise.all([
    fetchNewReviewComments(entry),
    fetchNewReviews(entry),
    fetchNewIssueComments(entry),
  ])

  // Always advance timestamp to avoid growing payloads on quiet PRs
  entry.lastCheckedAt = pollTime

  if (reviewComments.length === 0 && issueComments.length === 0 && reviews.length === 0) {
    // Verify entry hasn't been replaced before persisting
    if (watches.get(entry.prUrl) === entry) persist()
    return
  }

  // Update watermarks
  for (const c of reviewComments) {
    if (c.id > entry.lastReviewCommentId) entry.lastReviewCommentId = c.id
  }
  for (const c of issueComments) {
    if (c.id > entry.lastIssueCommentId) entry.lastIssueCommentId = c.id
  }
  for (const r of reviews) {
    if (r.id > entry.lastReviewId) entry.lastReviewId = r.id
  }

  const allComments = [...reviewComments, ...issueComments]
  const totalItems = allComments.length + reviews.length

  // Build notification — data only, no behavioral instructions
  const parts: string[] = []
  parts.push(`[PR Feedback] **${entry.owner}/${entry.repo}#${entry.prNumber}** — ${totalItems} new item(s)`)
  parts.push('')

  for (const r of reviews) {
    const icon = r.state === 'APPROVED' ? '✅' : r.state === 'CHANGES_REQUESTED' ? '🔴' : '💬'
    parts.push(`${icon} **Review from @${r.user}** — ${r.state}`)
    if (r.body) parts.push(`> ${r.body.slice(0, 500)}`)
    parts.push('')
  }

  for (const c of allComments) {
    const location = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ''}\`` : '(general)'
    parts.push(`💬 **@${c.user}** ${location}`)
    parts.push(`> ${c.body.slice(0, 500)}`)
    if (c.url) parts.push(`> ${c.url}`)
    parts.push('')
  }

  // Deliver to the session
  const sessionExists = registry.has(entry.sessionId) || entry.sessionId === 'main'
  if (!sessionExists) {
    process.stderr.write(`daemon: pr-watch: session ${entry.sessionId} gone, removing watch for ${entry.prUrl}\n`)
    watches.delete(entry.prUrl)
    persist()
    return
  }

  transport.sendOrQueue(entry.sessionId, {
    type: 'notification',
    content: parts.join('\n'),
    meta: {
      chat_id: entry.threadId,
      message_id: '',
      user: 'pr-watch',
      user_id: 'system',
      ts: new Date().toISOString(),
    },
  })

  // Verify entry hasn't been replaced (unwatch + re-watch race) before persisting
  if (watches.get(entry.prUrl) === entry) persist()
  process.stderr.write(`daemon: pr-watch: delivered ${allComments.length} comment(s) + ${reviews.length} review(s) for ${entry.prUrl}\n`)
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function pollAll(): Promise<void> {
  if (watches.size === 0) return

  for (const entry of watches.values()) {
    try {
      await pollPr(entry)
    } catch (err) {
      process.stderr.write(`daemon: pr-watch: poll failed for ${entry.prUrl}: ${err}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function watchPr(prUrl: string, sessionId: string, threadId: string): Promise<string> {
  if (watches.has(prUrl)) {
    const existing = watches.get(prUrl)!
    return `already watching ${prUrl} (session: ${existing.sessionId})`
  }

  const parsed = parsePrUrl(prUrl)
  if (!parsed) {
    throw new Error(`invalid PR URL: ${prUrl} — expected https://github.com/owner/repo/pull/123`)
  }

  const entry: WatchEntry = {
    prUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.prNumber,
    sessionId,
    threadId,
    lastCheckedAt: new Date().toISOString(),
    lastReviewCommentId: 0,
    lastIssueCommentId: 0,
    lastReviewId: 0,
    createdAt: Date.now(),
  }

  // Seed watermarks with max IDs so we only report NEW comments
  try {
    const [reviewComments, issueComments, reviews] = await Promise.all([
      ghApi(`repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/comments?per_page=100`),
      ghApi(`repos/${parsed.owner}/${parsed.repo}/issues/${parsed.prNumber}/comments?per_page=100`),
      ghApi(`repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/reviews?per_page=100`),
    ])
    entry.lastReviewCommentId = maxId(reviewComments)
    entry.lastIssueCommentId = maxId(issueComments)
    entry.lastReviewId = maxId(reviews)
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: failed to seed watermarks for ${prUrl}: ${err}\n`)
  }

  watches.set(prUrl, entry)
  persist()
  process.stderr.write(`daemon: pr-watch: watching ${prUrl} → session ${sessionId}, thread ${threadId}\n`)
  return `watching ${prUrl} — will poll every ${POLL_INTERVAL_MS / 60000} minutes`
}

export function unwatchPr(prUrl: string, callerSessionId?: string): string {
  const entry = watches.get(prUrl)
  if (!entry) {
    return `not watching ${prUrl}`
  }
  if (callerSessionId && callerSessionId !== entry.sessionId && callerSessionId !== 'main') {
    return `cannot unwatch — owned by session ${entry.sessionId}`
  }
  watches.delete(prUrl)
  persist()
  process.stderr.write(`daemon: pr-watch: unwatched ${prUrl}\n`)
  return `stopped watching ${prUrl}`
}

export function unwatchBySession(sessionId: string): number {
  let removed = 0
  for (const [url, entry] of watches) {
    if (entry.sessionId === sessionId) {
      watches.delete(url)
      removed++
    }
  }
  if (removed > 0) persist()
  return removed
}

export function listWatches(): WatchEntry[] {
  return [...watches.values()]
}

export function getWatchesBySession(sessionId: string): WatchEntry[] {
  return [...watches.values()].filter(e => e.sessionId === sessionId)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startPrWatcher(): void {
  loadPersisted()
  pollTimer = setInterval(() => {
    void pollAll().catch(err => {
      process.stderr.write(`daemon: pr-watch: poll cycle failed: ${err}\n`)
    })
  }, POLL_INTERVAL_MS)
  process.stderr.write(`daemon: pr-watch: started (interval: ${POLL_INTERVAL_MS / 1000}s)\n`)
}

export function stopPrWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}
