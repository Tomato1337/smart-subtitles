import { describe, expect, test } from 'vitest'
import type { Cue } from '@/common/types/ipc'
import { findCueIndex, focusEnd, focusedCueIndex, nextCueIndex, prevCueIndex } from './cues'

const c = (idx: number, start: number, end: number): Cue => ({ idx, start, end, text: String(idx), ru: null })
const cues = [c(0, 1, 3), c(1, 5, 7), c(2, 10, 12)]

describe('findCueIndex', () => {
  test('inside, gap and edges', () => {
    expect(findCueIndex(cues, 1, 0)).toBe(0)
    expect(findCueIndex(cues, 2.9, 0)).toBe(0)
    expect(findCueIndex(cues, 3, 0)).toBe(-1)
    expect(findCueIndex(cues, 4, 0)).toBe(-1)
    expect(findCueIndex(cues, 11, 0)).toBe(2)
    expect(findCueIndex(cues, 0.5, 0)).toBe(-1)
  })
  test('offset shifts the window', () => {
    expect(findCueIndex(cues, 6, 1)).toBe(1)
    expect(findCueIndex(cues, 5.5, 1)).toBe(0 - 1)
  })
})

describe('navigation', () => {
  test('next from a gap goes to the following cue', () => {
    expect(nextCueIndex(cues, 4, 0)).toBe(1)
    expect(nextCueIndex(cues, 11, 0)).toBe(2)
    expect(nextCueIndex(cues, 0, 0)).toBe(0)
  })
  test('prev restarts the current cue after 1 s, else goes back', () => {
    expect(prevCueIndex(cues, 6.5, 0)).toBe(1)
    expect(prevCueIndex(cues, 5.5, 0)).toBe(0)
    expect(prevCueIndex(cues, 4, 0)).toBe(0)
  })
})

describe('focusedCueIndex', () => {
  test('holds the last phrase through the gap until the next starts', () => {
    expect(focusedCueIndex(cues, 0.5, 0)).toBe(-1)
    expect(focusedCueIndex(cues, 4, 0)).toBe(0)
    expect(focusedCueIndex(cues, 4.99, 0)).toBe(0)
    expect(focusedCueIndex(cues, 5, 0)).toBe(1)
  })
  test('final cue is released at its end', () => {
    expect(focusedCueIndex(cues, 11.9, 0)).toBe(2)
    expect(focusedCueIndex(cues, 12, 0)).toBe(-1)
    expect(focusEnd(cues, 2, 1)).toBe(13)
  })
})
