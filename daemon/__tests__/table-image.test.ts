import { describe, test, expect } from 'bun:test'
import { extractTables } from '../table-image.js'

// Suppress stderr from module init
process.stderr.write = (() => true) as any

describe('extractTables', () => {
  test('detects a simple pipe table', () => {
    const text = `| Name | Age |
|------|-----|
| Alice | 30 |
| Bob | 25 |`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(['Name', 'Age'])
    expect(tables[0].rows).toEqual([['Alice', '30'], ['Bob', '25']])
    expect(cleanedText).toBe('')
  })

  test('preserves text around table', () => {
    const text = `Here is a table:

| Col A | Col B |
|-------|-------|
| 1     | 2     |

And some text after.`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(1)
    expect(cleanedText).toBe('Here is a table:\n\nAnd some text after.')
  })

  test('returns original text when no tables present', () => {
    const text = 'Just some regular text with | pipes | in it.'
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('skips tables inside code blocks', () => {
    const text = `Some text

\`\`\`
| Header | Value |
|--------|-------|
| A      | 1     |
\`\`\`

More text`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('detects multiple tables', () => {
    const text = `First table:

| A | B |
|---|---|
| 1 | 2 |

Second table:

| X | Y | Z |
|---|---|---|
| a | b | c |
| d | e | f |`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(2)
    expect(tables[0].headers).toEqual(['A', 'B'])
    expect(tables[0].rows).toHaveLength(1)
    expect(tables[1].headers).toEqual(['X', 'Y', 'Z'])
    expect(tables[1].rows).toHaveLength(2)
    expect(cleanedText).toBe('First table:\n\nSecond table:')
  })

  test('parses column alignment from separator', () => {
    const text = `| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |`
    const { tables } = extractTables(text)
    expect(tables[0].alignments).toEqual(['left', 'center', 'right'])
  })

  test('requires data rows after separator', () => {
    const text = `| Header |
|--------|`
    const { tables } = extractTables(text)
    expect(tables).toHaveLength(0)
  })

  test('handles tables without outer pipes', () => {
    const text = `| Name | Value |
|------|-------|
| foo  | bar   |`
    const { tables } = extractTables(text)
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(['Name', 'Value'])
  })

  test('handles table with emoji and unicode', () => {
    const text = `| Status | Transfer |
|--------|----------|
| ✅ Done | ACH #42 |
| ⚠️ Pending | Wire #7 |`
    const { tables } = extractTables(text)
    expect(tables).toHaveLength(1)
    expect(tables[0].rows[0][0]).toBe('✅ Done')
  })
})
