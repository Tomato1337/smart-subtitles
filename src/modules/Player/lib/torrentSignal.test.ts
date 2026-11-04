import { describe, expect, test } from 'vitest'
import { signalDots } from './torrentSignal'

describe('signalDots', () => {
  test('the first dot is the buffer health, the others fill left to right', () => {
    expect(signalDots(0)).toEqual(['bad', 'off', 'off', 'off', 'off'])
    expect(signalDots(40)).toEqual(['weak', 'on', 'off', 'off', 'off'])
    expect(signalDots(81)).toEqual(['good', 'on', 'on', 'on', 'off'])
    expect(signalDots(100)).toEqual(['good', 'on', 'on', 'on', 'on'])
  })
  test('without a reader every dot is off', () => {
    expect(signalDots(null)).toEqual(['off', 'off', 'off', 'off', 'off'])
  })
  test('out-of-range values are clamped', () => {
    expect(signalDots(-5)).toEqual(['bad', 'off', 'off', 'off', 'off'])
    expect(signalDots(140)).toEqual(['good', 'on', 'on', 'on', 'on'])
  })
})
