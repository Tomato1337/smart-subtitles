import { describe, expect, test } from 'vitest'
import { SLOW_RATE, replayStep, slowStep, type ReplayWindow, type SlowWindow } from './slowReplay'

const win = (armed = false): SlowWindow => ({ from: 100, to: 104, prevRate: 1, armed, startedAt: 0 })
const rwin = (armed = false): ReplayWindow => ({ from: 100, to: 104, armed, startedAt: 0 })

describe('slow replay window', () => {
  test('old playhead past the cue does not end the window before the seek lands', () => {
    const w = win()
    expect(slowStep(w, 130, SLOW_RATE, false, 1000)).toBe('keep')
    expect(w.armed).toBe(false)
  })
  test('arms on entering the cue, a keyframe slightly early counts', () => {
    const w = win()
    expect(slowStep(w, 99.5, SLOW_RATE, false, 1000)).toBe('keep')
    expect(w.armed).toBe(true)
  })
  test('pauses when the cue ends', () => {
    expect(slowStep(win(true), 103.9, SLOW_RATE, false, 1000)).toBe('keep')
    expect(slowStep(win(true), 104, SLOW_RATE, false, 1000)).toBe('pause')
  })
  test('restores when the user jumps back before the cue', () => {
    expect(slowStep(win(true), 50, SLOW_RATE, false, 1000)).toBe('restore')
  })
  test('ignores the playhead while a seek or stream restart is settling', () => {
    expect(slowStep(win(true), 0, SLOW_RATE, true, 1000)).toBe('keep')
  })
  test('a speed picked by hand wins and is left alone', () => {
    expect(slowStep(win(true), 102, 1.25, false, 1000)).toBe('drop')
  })
  test('gives the speed back if the seek never reaches the cue', () => {
    expect(slowStep(win(), 130, SLOW_RATE, false, 31_000)).toBe('restore')
  })
})

describe('plain replay window', () => {
  test('waits for the seek, then pauses at the cue end instead of moving on', () => {
    const w = rwin()
    expect(replayStep(w, 130, false, 1000)).toBe('keep')
    expect(w.armed).toBe(false)
    expect(replayStep(w, 100, false, 1000)).toBe('keep')
    expect(w.armed).toBe(true)
    expect(replayStep(w, 103.9, false, 1000)).toBe('keep')
    expect(replayStep(w, 104, false, 1000)).toBe('pause')
  })
  test('cancels when the seek never reaches the cue', () => {
    expect(replayStep(rwin(), 130, false, 31_000)).toBe('cancel')
  })
  test('cancels when the user jumps back', () => {
    expect(replayStep(rwin(true), 50, false, 1000)).toBe('cancel')
  })
  test('ignores the playhead while a seek or stream restart is settling', () => {
    expect(replayStep(rwin(true), 0, true, 1000)).toBe('keep')
  })
})
