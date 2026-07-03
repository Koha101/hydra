import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'

export type SpawnTemplate = {
  prompt: string
}

const BUILTIN_TEMPLATES: Record<string, SpawnTemplate> = {
  review: {
    prompt: 'Review this PR thoroughly. Start by reading the diff, then check for correctness bugs, security issues, and simplification opportunities. Categorize findings by severity.',
  },
  fix: {
    prompt: 'Fix this issue. Read the relevant code, understand the root cause, implement the fix, write tests if needed, and create a PR when done.',
  },
  investigate: {
    prompt: 'Investigate this issue. Search the codebase, read logs, check error tracking, and report your findings. Do NOT make changes unless explicitly asked.',
  },
  incident: {
    prompt: 'Production incident — prioritize speed. Check for on-call guides in .claude/ first. Identify the root cause, implement a fix, and create a PR. Communicate status updates to your thread as you go.',
  },
}

function loadUserTemplates(): Record<string, SpawnTemplate> {
  const path = join(STATE_DIR, 'templates.json')
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const valid: Record<string, SpawnTemplate> = {}
    for (const [name, t] of Object.entries(raw)) {
      const entry = t as Record<string, unknown>
      if (entry && typeof entry === 'object' && typeof entry.prompt === 'string') {
        valid[name.toLowerCase()] = { prompt: entry.prompt }
      } else {
        process.stderr.write(`daemon: templates.json: skipping "${name}" — missing or non-string prompt\n`)
      }
    }
    return valid
  } catch (err) {
    process.stderr.write(`daemon: failed to load templates.json: ${err instanceof Error ? err.message : err}\n`)
    return {}
  }
}

export function resolveTemplate(topic: string): { template: SpawnTemplate | null; remainingTopic: string; templateName: string | null } {
  // Skip wt:/worktree: prefix to find the template name
  let prefix = ''
  let searchTopic = topic
  const wtMatch = topic.match(/^(?:worktree|wt):\S+\s+/)
  if (wtMatch) {
    prefix = wtMatch[0]
    searchTopic = topic.slice(wtMatch[0].length)
  }

  const firstWord = searchTopic.match(/^(\S+)\s+/)
  if (!firstWord) return { template: null, remainingTopic: topic, templateName: null }

  const name = firstWord[1].toLowerCase()
  if (name.includes(':')) return { template: null, remainingTopic: topic, templateName: null }
  const rest = prefix + searchTopic.slice(firstWord[0].length)

  // User templates override builtins
  const user = loadUserTemplates()
  if (user[name]) return { template: user[name], remainingTopic: rest, templateName: name }
  if (BUILTIN_TEMPLATES[name]) return { template: BUILTIN_TEMPLATES[name], remainingTopic: rest, templateName: name }

  return { template: null, remainingTopic: topic, templateName: null }
}

export function isTemplateName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower in BUILTIN_TEMPLATES || lower in loadUserTemplates()
}

export function listTemplates(): Array<{ name: string; prompt: string; source: 'builtin' | 'user' }> {
  const user = loadUserTemplates()
  const result: Array<{ name: string; prompt: string; source: 'builtin' | 'user' }> = []
  for (const [name, t] of Object.entries(BUILTIN_TEMPLATES)) {
    if (!user[name]) result.push({ name, prompt: t.prompt, source: 'builtin' })
  }
  for (const [name, t] of Object.entries(user)) {
    result.push({ name, prompt: t.prompt, source: 'user' })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

