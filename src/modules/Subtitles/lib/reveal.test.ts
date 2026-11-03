import { describe, expect, test } from 'vitest'
import type { Cue } from '@/common/types/ipc'
import { startReveal, subtitleVisibility } from './reveal'

const cue: Cue = { idx: 0, start: 10, end: 14, text: 'x', ru: null }

describe('hidden mode', () => {
  test('normal mode always visible with spoken progress, fully lit after the cue ends', () => {
    expect(subtitleVisibility(false, null, 11, cue, 0)).toEqual({ visible: true, karaoke: 0.25 })
    expect(subtitleVisibility(false, null, 16, cue, 0).karaoke).toBe(1)
  })
  test('hidden without reveal', () => {
    expect(subtitleVisibility(true, null, 11, cue, 0).visible).toBe(false)
  })
  test('reveal shows karaoke progress and ends at until', () => {
    const { reveal, seekTo } = startReveal(12)
    expect(seekTo).toBe(7)
    expect(reveal.until).toBe(14)
    expect(subtitleVisibility(true, reveal, 12, cue, 0)).toEqual({ visible: true, karaoke: 0.5 })
    expect(subtitleVisibility(true, reveal, 14, cue, 0).visible).toBe(false)
  })
  test('rewind never goes below zero and karaoke honours the offset', () => {
    expect(startReveal(3).seekTo).toBe(0)
    expect(subtitleVisibility(true, { t0: 0, until: 99 }, 12, cue, 1).karaoke).toBe(0.25)
  })
})
