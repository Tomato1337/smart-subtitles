import { describe, expect, test } from 'vitest'
import { WatchAccumulator } from './watchAccumulator'

describe('WatchAccumulator', () => {
  test('accumulates active time, skips pauses/buffering, and flushes whole seconds', () => {
    const acc = new WatchAccumulator(15)
    expect(acc.sample(0, true)).toBeNull()
    for (let i = 1; i <= 14; i++) {
      expect(acc.sample(i * 1000, true)).toBeNull()
    }
    // Paused gap of 30s must be ignored completely
    expect(acc.sample(45_000, false)).toBeNull()
    expect(acc.sample(45_500, true)).toBeNull()
    expect(acc.sample(46_500, true)).toBe(15)
  })

  test('clamps single tick delta to 1.5s and flushes remainder on stop', () => {
    const acc = new WatchAccumulator(15)
    acc.sample(1000, true)
    // Huge 60s jump on sleep/wake clamps to 1.5s
    acc.sample(61_000, true)
    acc.sample(62_000, true) // total ~2.5s
    expect(acc.flush()).toBe(2)
    expect(acc.flush()).toBeNull()
  })
})
