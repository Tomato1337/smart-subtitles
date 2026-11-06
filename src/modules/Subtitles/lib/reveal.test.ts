import { describe, expect, test } from 'vitest'
import type { Cue } from '@/common/types/ipc'
import { litFraction, startReveal, subtitleVisibility } from './reveal'

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

describe('karaoke steps', () => {
  const starts = [0, 0.25, 0.3, 0.6]
  // CueText lights a token when its start / length <= karaoke: both values must light the same set.
  const lit = (k: number) => starts.filter((s) => s <= k).length
  test('snaps down to the last reached token start', () => {
    expect(litFraction(starts, 0)).toBe(0)
    expect(litFraction(starts, 0.24)).toBe(0)
    expect(litFraction(starts, 0.25)).toBe(0.25)
    expect(litFraction(starts, 0.59)).toBe(0.3)
    expect(litFraction(starts, 1)).toBe(0.6)
  })
  test('lights the same tokens as the raw fraction', () => {
    for (let f = 0; f <= 1; f += 0.01) expect(lit(litFraction(starts, f))).toBe(lit(f))
  })
  test('empty text stays unlit', () => {
    expect(litFraction([], 0.5)).toBe(0)
  })
})
