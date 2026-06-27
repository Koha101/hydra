/**
 * Markdown pipe-table → PNG image conversion for Discord.
 *
 * Discord has no native table rendering. This module detects markdown tables
 * in outbound text, renders them as styled HTML, screenshots via Playwright,
 * and returns file paths for attachment. Falls back to monospace code blocks
 * if Playwright is unavailable.
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

const TABLE_ROW_RE = /^[ \t]*\|.+\|[ \t]*$/
const SEPARATOR_RE = /^[ \t]*\|[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|[ \t]*$/

type Align = 'left' | 'center' | 'right'

interface ParsedTable {
  headers: string[]
  alignments: Align[]
  rows: string[][]
  startLine: number
  endLine: number
}

function parseRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
}

function parseAlignments(line: string): Align[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => {
    const t = cell.trim()
    if (t.startsWith(':') && t.endsWith(':')) return 'center'
    if (t.endsWith(':')) return 'right'
    return 'left'
  })
}

export function extractTables(text: string): { tables: ParsedTable[]; cleanedText: string } {
  const lines = text.split('\n')
  const tables: ParsedTable[] = []
  let inCodeBlock = false
  let i = 0

  while (i < lines.length) {
    if (lines[i].trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      i++
      continue
    }
    if (inCodeBlock) { i++; continue }

    if (TABLE_ROW_RE.test(lines[i]) && i + 1 < lines.length && SEPARATOR_RE.test(lines[i + 1])) {
      const headers = parseRow(lines[i])
      const alignments = parseAlignments(lines[i + 1])
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && TABLE_ROW_RE.test(lines[j])) {
        rows.push(parseRow(lines[j]))
        j++
      }
      if (rows.length > 0) {
        tables.push({ headers, alignments, rows, startLine: i, endLine: j - 1 })
      }
      i = j
    } else {
      i++
    }
  }

  if (tables.length === 0) return { tables: [], cleanedText: text }

  const cleaned: string[] = []
  let lastEnd = -1
  for (const t of tables) {
    for (let k = lastEnd + 1; k < t.startLine; k++) cleaned.push(lines[k])
    lastEnd = t.endLine
  }
  for (let k = lastEnd + 1; k < lines.length; k++) cleaned.push(lines[k])

  return { tables, cleanedText: cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

// ---------------------------------------------------------------------------
// HTML generation (Discord-dark themed)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function tableToHtml(table: ParsedTable): string {
  const ths = table.headers
    .map((h, i) => `<th style="text-align:${table.alignments[i] ?? 'left'}">${esc(h)}</th>`)
    .join('')
  const trs = table.rows
    .map(row => '<tr>' + row.map((c, i) =>
      `<td style="text-align:${table.alignments[i] ?? 'left'}">${esc(c)}</td>`
    ).join('') + '</tr>')
    .join('\n      ')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;padding:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{display:inline-block;background:#2b2d31;border-radius:8px;overflow:hidden;border:1px solid #3f4147}
table{border-collapse:collapse;white-space:nowrap}
th{background:#2b2d31;color:#f2f3f5;font-weight:600;font-size:12px;letter-spacing:.03em;padding:8px 14px;border-bottom:2px solid #3f4147}
td{padding:7px 14px;border-bottom:1px solid #3f4147;color:#dbdee1}
tr:last-child td{border-bottom:none}
</style></head><body>
  <div class="wrap">
    <table>
      <thead><tr>${ths}</tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </div>
</body></html>`
}

// ---------------------------------------------------------------------------
// Code-block fallback (graceful degradation)
// ---------------------------------------------------------------------------

function tableToCodeBlock(table: ParsedTable): string {
  const all = [table.headers, ...table.rows]
  const widths = table.headers.map((_, i) =>
    Math.max(...all.map(r => (r[i] ?? '').length))
  )

  const pad = (s: string, w: number, a: Align) => {
    const gap = w - s.length
    if (gap <= 0) return s
    if (a === 'right') return ' '.repeat(gap) + s
    if (a === 'center') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l) }
    return s + ' '.repeat(gap)
  }

  const fmt = (row: string[]) => row.map((c, i) => pad(c, widths[i], table.alignments[i] ?? 'left')).join('  ')
  const sep = widths.map(w => '─'.repeat(w)).join('──')

  return '```\n' + fmt(table.headers) + '\n' + sep + '\n' + table.rows.map(fmt).join('\n') + '\n```'
}

// ---------------------------------------------------------------------------
// Playwright screenshot
// ---------------------------------------------------------------------------

const TABLE_TMP = join(tmpdir(), 'hydra-tables')
mkdirSync(TABLE_TMP, { recursive: true })

let playwrightChecked = false
let playwrightOk = false

interface PlaywrightEnv {
  nodeModules: string
  chromiumPath: string
}

let resolvedEnv: PlaywrightEnv | null | undefined = undefined

function resolvePlaywright(): PlaywrightEnv | null {
  if (resolvedEnv !== undefined) return resolvedEnv
  const home = process.env.HOME ?? ''

  let nodeModules = ''
  const npxDir = join(home, '.npm/_npx')
  if (existsSync(npxDir)) {
    try {
      const result = Bun.spawnSync(['find', npxDir, '-maxdepth', '4', '-path', '*/node_modules/playwright/index.js', '-type', 'f'], { timeout: 5_000 })
      const lines = result.stdout.toString().trim().split('\n').filter(Boolean)
      if (lines[0]) nodeModules = lines[0].replace(/\/playwright\/index\.js$/, '')
    } catch {}
  }

  let chromiumPath = ''
  const cacheDir = join(home, 'Library/Caches/ms-playwright')
  if (existsSync(cacheDir)) {
    try {
      const result = Bun.spawnSync(['find', cacheDir, '-maxdepth', '2', '-type', 'd', '-name', 'chromium-*'], { timeout: 5_000 })
      const dirs = result.stdout.toString().trim().split('\n').filter(Boolean).sort().reverse()
      for (const dir of dirs) {
        const macExe = Bun.spawnSync(['find', dir, '-name', 'Google Chrome for Testing', '-type', 'f'], { timeout: 3_000 })
        const exe = macExe.stdout.toString().trim().split('\n')[0]
        if (exe) { chromiumPath = exe; break }
        const linuxExe = Bun.spawnSync(['find', dir, '-name', 'chrome', '-type', 'f'], { timeout: 3_000 })
        const lexe = linuxExe.stdout.toString().trim().split('\n')[0]
        if (lexe) { chromiumPath = lexe; break }
      }
    } catch {}
  }

  resolvedEnv = nodeModules && chromiumPath ? { nodeModules, chromiumPath } : null
  return resolvedEnv
}

function makeScreenshotScript(chromiumPath: string): string {
  return `
const { chromium } = require('playwright');
(async () => {
  const [,, htmlPath, pngPath] = process.argv;
  const browser = await chromium.launch({
    headless: true,
    executablePath: ${JSON.stringify(chromiumPath)},
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });
  const el = await page.locator('.wrap').first();
  await el.screenshot({ path: pngPath, omitBackground: true });
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
`
}

async function screenshotHtml(html: string, outPath: string): Promise<boolean> {
  const env = resolvePlaywright()
  if (!env) return false

  const scriptPath = join(TABLE_TMP, '_screenshot.cjs')
  writeFileSync(scriptPath, makeScreenshotScript(env.chromiumPath))

  const htmlPath = outPath.replace(/\.png$/, '.html')
  writeFileSync(htmlPath, html)

  try {
    const proc = Bun.spawn(['node', scriptPath, htmlPath, outPath], {
      env: { ...process.env, NODE_PATH: env.nodeModules },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    try { unlinkSync(htmlPath) } catch {}
    return code === 0 && existsSync(outPath)
  } catch {
    try { unlinkSync(htmlPath) } catch {}
    return false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TableRenderResult = {
  text: string
  files: string[]
  rendered: number
  degraded: number
}

export async function renderTablesForDiscord(text: string): Promise<TableRenderResult> {
  const { tables, cleanedText } = extractTables(text)
  if (tables.length === 0) return { text, files: [], rendered: 0, degraded: 0 }

  if (!playwrightChecked) {
    playwrightChecked = true
    const testHtml = '<html><body><div class="wrap" style="padding:4px">test</div></body></html>'
    const testPng = join(TABLE_TMP, '_test.png')
    playwrightOk = await screenshotHtml(testHtml, testPng)
    try { unlinkSync(testPng) } catch {}
    if (playwrightOk) {
      process.stderr.write('daemon: table-image: playwright available, tables will render as PNG\n')
    } else {
      process.stderr.write('daemon: table-image: playwright unavailable, tables will degrade to code blocks\n')
    }
  }

  const files: string[] = []
  const codeBlocks: string[] = []
  let rendered = 0
  let degraded = 0

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]
    if (playwrightOk) {
      const pngPath = join(TABLE_TMP, `table-${Date.now()}-${i}.png`)
      const html = tableToHtml(table)
      const ok = await screenshotHtml(html, pngPath)
      if (ok) {
        files.push(pngPath)
        rendered++
        continue
      }
    }
    codeBlocks.push(tableToCodeBlock(table))
    degraded++
  }

  let finalText = cleanedText
  if (codeBlocks.length > 0) {
    finalText = finalText ? finalText + '\n\n' + codeBlocks.join('\n\n') : codeBlocks.join('\n\n')
  }

  return { text: finalText, files, rendered, degraded }
}
