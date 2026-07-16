import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const MAX_CONTEXT_BYTES = 32 * 1024

function readContext(path: string): string | undefined {
  try {
    const content = readFileSync(path).subarray(0, MAX_CONTEXT_BYTES).toString('utf8').trim()
    return content || undefined
  } catch {
    return undefined
  }
}

export function claudeProjectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

export function buildCodexWorkspaceContext(workspace: string): string {
  const instructionsPath = process.env.CODEX_CLAUDE_INSTRUCTIONS_FILE?.trim() || join(workspace, 'CLAUDE.md')
  const memoryPath = process.env.CODEX_CLAUDE_MEMORY_FILE?.trim()
    || join(homedir(), '.claude', 'projects', claudeProjectSlug(workspace), 'memory', 'MEMORY.md')
  const instructions = readContext(instructionsPath)
  const memory = readContext(memoryPath)
  const sections = [
    instructions ? `Workspace instructions (${instructionsPath}):\n${instructions}` : '',
    memory ? `Claude project memory index (${memoryPath}):\n${memory}` : '',
  ].filter(Boolean)
  if (sections.length === 0) return ''
  return [
    '[Hydra workspace context]',
    'Follow these instructions and use this memory as background. The current user request takes precedence.',
    ...sections,
    'Before working in a child repository, read its closest applicable CLAUDE.md files.',
  ].join('\n\n')
}
