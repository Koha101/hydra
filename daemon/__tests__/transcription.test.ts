import { describe, test, expect } from 'bun:test'
import { isAudioFile, mergeTranscripts, transcriptionEnabled } from '../transcription.js'

// Suppress stderr logging during tests
process.stderr.write = (() => true) as any

describe('isAudioFile', () => {
  test('detects audio by MIME type', () => {
    expect(isAudioFile({ contentType: 'audio/ogg', name: 'voice-message.ogg' })).toBe(true)
    expect(isAudioFile({ contentType: 'audio/mpeg', name: 'clip' })).toBe(true)
    expect(isAudioFile({ contentType: 'AUDIO/WAV', name: 'x' })).toBe(true)
  })

  test('detects audio by extension when MIME is generic', () => {
    expect(isAudioFile({ contentType: 'application/octet-stream', name: 'note.opus' })).toBe(true)
    expect(isAudioFile({ contentType: null, name: 'recording.m4a' })).toBe(true)
    expect(isAudioFile({ contentType: 'application/ogg', name: 'voice.ogg' })).toBe(true)
  })

  test('rejects non-audio files', () => {
    expect(isAudioFile({ contentType: 'image/png', name: 'screenshot.png' })).toBe(false)
    expect(isAudioFile({ contentType: 'text/plain', name: 'notes.txt' })).toBe(false)
    expect(isAudioFile({ contentType: null, name: 'noext' })).toBe(false)
    expect(isAudioFile({ contentType: null, name: '' })).toBe(false)
  })
})

describe('mergeTranscripts', () => {
  test('transcript becomes the prompt when no typed content', () => {
    const out = mergeTranscripts('', [{ name: 'a.ogg', text: 'hello world' }])
    expect(out).toBe('[voice transcript] hello world')
  })

  test('appends transcript under a label when there is typed content', () => {
    const out = mergeTranscripts('see this', [{ name: 'a.ogg', text: 'and listen' }])
    expect(out).toBe('see this\n\n[voice transcript] and listen')
  })

  test('lists multiple transcripts as bullets', () => {
    const out = mergeTranscripts('', [
      { name: 'a.ogg', text: 'first' },
      { name: 'b.ogg', text: 'second' },
    ])
    expect(out).toBe('[voice transcript]\n- first\n- second')
  })

  test('ignores empty/whitespace transcripts', () => {
    expect(mergeTranscripts('typed', [{ name: 'a.ogg', text: '   ' }])).toBe('typed')
    expect(mergeTranscripts('', [])).toBe('')
  })

  test('trims surrounding whitespace on transcript text', () => {
    const out = mergeTranscripts('', [{ name: 'a.ogg', text: '  spoken  ' }])
    expect(out).toBe('[voice transcript] spoken')
  })
})

describe('transcriptionEnabled', () => {
  const prev = process.env.HYDRA_TRANSCRIBE_ENABLED

  test('on by default (unset or blank)', () => {
    delete process.env.HYDRA_TRANSCRIBE_ENABLED
    expect(transcriptionEnabled()).toBe(true)
    process.env.HYDRA_TRANSCRIBE_ENABLED = ''
    expect(transcriptionEnabled()).toBe(true)
    process.env.HYDRA_TRANSCRIBE_ENABLED = '  '
    expect(transcriptionEnabled()).toBe(true)
  })

  test('explicit opt-out values turn it off', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env.HYDRA_TRANSCRIBE_ENABLED = v
      expect(transcriptionEnabled()).toBe(false)
    }
  })

  test('any other value keeps it on', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      process.env.HYDRA_TRANSCRIBE_ENABLED = v
      expect(transcriptionEnabled()).toBe(true)
    }
  })

  if (prev === undefined) delete process.env.HYDRA_TRANSCRIBE_ENABLED
  else process.env.HYDRA_TRANSCRIBE_ENABLED = prev
})
