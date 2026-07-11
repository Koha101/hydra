import { describe, test, expect } from 'bun:test'
import { parseEnvLine } from '../env-parse.js'

describe('parseEnvLine', () => {
  test('simple key=value', () => {
    expect(parseEnvLine('FOO=bar')).toEqual(['FOO', 'bar'])
  })

  test('strips inline comments on unquoted values', () => {
    expect(parseEnvLine('SPAWN_CWD=~/work # my dir')).toEqual(['SPAWN_CWD', '~/work'])
  })

  test('preserves # inside double-quoted values', () => {
    expect(parseEnvLine('VAL="has # hash"')).toEqual(['VAL', 'has # hash'])
  })

  test('preserves # inside single-quoted values', () => {
    expect(parseEnvLine("VAL='has # hash'")).toEqual(['VAL', 'has # hash'])
  })

  test('handles export prefix', () => {
    expect(parseEnvLine('export KEY=val')).toEqual(['KEY', 'val'])
  })

  test('export with inline comment', () => {
    expect(parseEnvLine('export KEY=val # note')).toEqual(['KEY', 'val'])
  })

  test('ignores comment-only lines', () => {
    expect(parseEnvLine('# this is a comment')).toBeNull()
  })

  test('ignores blank lines', () => {
    expect(parseEnvLine('')).toBeNull()
  })

  test('value with no comment is unchanged', () => {
    expect(parseEnvLine('URL=http://127.0.0.1:8123/transcribe')).toEqual(['URL', 'http://127.0.0.1:8123/transcribe'])
  })

  test('trailing whitespace stripped on unquoted', () => {
    expect(parseEnvLine('KEY=val   ')).toEqual(['KEY', 'val'])
  })

  test('empty value', () => {
    expect(parseEnvLine('KEY=')).toEqual(['KEY', ''])
  })
})
