import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'

export type SpawnTemplate = {
  prompt: string
  actions?: string[]
}

const BUILTIN_TEMPLATES: Record<string, SpawnTemplate> = {
  review: {
    prompt: 'You are the owner of a review session. An adversarial review protocol will start automatically — a critic will challenge your work across multiple rounds. Defend your design and fix valid issues.',
    actions: ['review'],
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
  design: {
    prompt: 'You are a design session. A multi-persona design process will start automatically in your thread. Participate as the owner — answer questions from the personas and guide the synthesis toward a concrete implementation plan.',
    actions: ['design'],
  },
  build: {
    prompt: 'You are the owner of a build session. A multi-agent build protocol will start automatically — a builder will implement the task and a critic will review each round. Guide the process and answer questions.',
    actions: ['build'],
  },
}

const RESERVED = new Set(['spawn', 'kill', 'fork', 'resume', 'respawn', 'listen', 'pause', 'help', 'commands', 'recover', 'build', 'sessions', 'watch', 'unwatch', 'watches', 'health', 'restart', 'reconnect', 'protocols', 'templates', 'usage'])

let userTemplateCache: { mtime: number; templates: Record<string, SpawnTemplate> } | null = null

function loadUserTemplates(): Record<string, SpawnTemplate> {
  const path = join(STATE_DIR, 'templates.json')
  if (!existsSync(path)) return {}

  try {
    const mtime = statSync(path).mtimeMs
    if (userTemplateCache && userTemplateCache.mtime === mtime) return userTemplateCache.templates

    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const valid: Record<string, SpawnTemplate> = {}
    for (const [name, t] of Object.entries(raw)) {
      const entry = t as Record<string, unknown>
      if (name.includes(':')) {
        process.stderr.write(`daemon: templates.json: skipping "${name}" — template names cannot contain colons\n`)
      } else if (RESERVED.has(name.toLowerCase())) {
        process.stderr.write(`daemon: templates.json: skipping "${name}" — reserved command name\n`)
      } else if (entry && typeof entry === 'object' && typeof entry.prompt === 'string') {
        const template: SpawnTemplate = { prompt: entry.prompt }
        if (Array.isArray(entry.actions)) {
          const VALID_ACTIONS = new Set(['review', 'build', 'design'])
          const validActions: string[] = []
          for (const a of entry.actions) {
            if (typeof a === 'string' && VALID_ACTIONS.has(a)) {
              validActions.push(a)
            } else {
              process.stderr.write(`daemon: templates.json: "${name}" has unknown action "${a}" — skipping it\n`)
            }
          }
          if (validActions.length > 0) template.actions = validActions
        }
        valid[name.toLowerCase()] = template
      } else {
        process.stderr.write(`daemon: templates.json: skipping "${name}" — missing or non-string prompt\n`)
      }
    }
    userTemplateCache = { mtime, templates: valid }
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

export function getTemplate(name: string): SpawnTemplate | null {
  const lower = name.toLowerCase()
  const user = loadUserTemplates()
  return user[lower] ?? BUILTIN_TEMPLATES[lower] ?? null
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

