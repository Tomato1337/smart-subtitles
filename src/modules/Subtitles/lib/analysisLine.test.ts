import { describe, expect, test } from 'vitest'
import type { Cue } from '@/common/types/ipc'
import { analyzedSpans } from './analysisLine'

/** 100 cues, one every two seconds, each 1.5 s long: three batches of 40/40/20. */
const cue = (idx: number): Cue => ({ idx, start: idx * 2, end: idx * 2 + 1.5, text: `c${idx}`, ru: null })
const cues = Array.from({ length: 100 }, (_, i) => cue(i))

describe('analyzedSpans', () => {
  test('one translated cue marks its whole batch', () => {
    expect(analyzedSpans(cues, [0])).toEqual([{ from: 0, to: 79.5 }])
    expect(analyzedSpans(cues, [45])).toEqual([{ from: 80, to: 159.5 }])
  })
  test('touching batches merge into one range', () => {
    expect(analyzedSpans(cues, [0, 45])).toEqual([{ from: 0, to: 159.5 }])
  })
  test('a gap between analyzed batches stays visible', () => {
    expect(analyzedSpans(cues, [5, 85])).toEqual([
      { from: 0, to: 79.5 },
      { from: 160, to: 199.5 },
    ])
  })
  test('nothing analyzed, nothing shown', () => {
    expect(analyzedSpans(cues, [])).toEqual([])
    expect(analyzedSpans([], [1])).toEqual([])
  })
  test('a short last batch ends at the last cue', () => {
    expect(analyzedSpans(cues, [99])).toEqual([{ from: 160, to: 199.5 }])
  })
})
