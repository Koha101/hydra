import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'

export type SpawnTemplate = {
  prompt: string
  actions?: string[]
}

const BUILTIN_TEMPLATES: Record<string, SpawnTemplate> = {
  review: {
    prompt: 'You are the owner of a review session. An adversarial review protocol will start automatically — a critic will challenge your work across multiple rounds. Defend your design and fix valid issues.',
    actions: ['review'],
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

const RESERVED = new Set(['spawn', 'kill', 'fork', 'resume', 'respawn', 'listen', 'pause', 'help', 'commands', 'recover', 'sessions', 'watch', 'unwatch', 'watches', 'health', 'restart', 'reconnect', 'protocols', 'templates', 'usage'])
const VALID_ACTIONS = new Set(['review', 'build', 'design'])

const HYDRA_DIR = join(import.meta.dir, '..')

type FileCache = { mtime: number; templates: Record<string, SpawnTemplate> }
let repoCache: FileCache | null = null
let localCache: FileCache | null = null

function loadTemplateFile(path: string, cache: FileCache | null, label: string): { templates: Record<string, SpawnTemplate>; cache: FileCache | null } {
  if (!existsSync(path)) return { templates: {}, cache: null }

  try {
    const mtime = statSync(path).mtimeMs
    if (cache && cache.mtime === mtime) return { templates: cache.templates, cache }

    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const valid: Record<string, SpawnTemplate> = {}
    for (const [name, t] of Object.entries(raw)) {
      const entry = t as Record<string, unknown>
      if (name.includes(':')) {
        process.stderr.write(`daemon: ${label}: skipping "${name}" — template names cannot contain colons\n`)
      } else if (RESERVED.has(name.toLowerCase())) {
        process.stderr.write(`daemon: ${label}: skipping "${name}" — reserved command name\n`)
      } else if (entry && typeof entry === 'object' && typeof entry.prompt === 'string') {
        const template: SpawnTemplate = { prompt: entry.prompt }
        if (Array.isArray(entry.actions)) {
          const validActions = (entry.actions as unknown[]).filter((a): a is string => typeof a === 'string' && VALID_ACTIONS.has(a))
          const invalid = (entry.actions as unknown[]).filter(a => typeof a !== 'string' || !VALID_ACTIONS.has(a))
          for (const a of invalid) process.stderr.write(`daemon: ${label}: "${name}" has unknown action "${a}" — skipping it\n`)
          if (validActions.length > 0) template.actions = validActions
        }
        valid[name.toLowerCase()] = template
      } else {
        process.stderr.write(`daemon: ${label}: skipping "${name}" — missing or non-string prompt\n`)
      }
    }
    const newCache = { mtime, templates: valid }
    return { templates: valid, cache: newCache }
  } catch (err) {
    process.stderr.write(`daemon: failed to load ${label}: ${err instanceof Error ? err.message : err}\n`)
    return { templates: {}, cache: null }
  }
}

function loadAllTemplates(): Record<string, SpawnTemplate> {
  const repoResult = loadTemplateFile(join(HYDRA_DIR, 'templates.json'), repoCache, 'templates.json')
  repoCache = repoResult.cache

  const localResult = loadTemplateFile(join(HYDRA_DIR, 'templates.local.json'), localCache, 'templates.local.json')
  localCache = localResult.cache

  // Merge: builtins < repo < local (last wins)
  return { ...BUILTIN_TEMPLATES, ...repoResult.templates, ...localResult.templates }
}

export function resolveTemplate(topic: string): { template: SpawnTemplate | null; remainingTopic: string; templateName: string | null } {
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

  const all = loadAllTemplates()
  if (all[name]) return { template: all[name], remainingTopic: rest, templateName: name }

  return { template: null, remainingTopic: topic, templateName: null }
}

export function isTemplateName(name: string): boolean {
  return name.toLowerCase() in loadAllTemplates()
}

export function getTemplate(name: string): SpawnTemplate | null {
  return loadAllTemplates()[name.toLowerCase()] ?? null
}

export function listTemplates(): Array<{ name: string; prompt: string }> {
  const all = loadAllTemplates()
  return Object.entries(all)
    .map(([name, t]) => ({ name, prompt: t.prompt }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
