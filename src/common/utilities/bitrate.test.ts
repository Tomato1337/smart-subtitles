import { describe, expect, test } from 'vitest'
import { formatMbps } from './bitrate'

describe('formatMbps', () => {
  test('bytes per second become Mbit/s with two decimals', () => {
    expect(formatMbps(4_728_750)).toBe('37.83')
    expect(formatMbps(1_250_000)).toBe('10.00')
  })
  test('nothing or nonsense is zero', () => {
    expect(formatMbps(0)).toBe('0.00')
    expect(formatMbps(-10)).toBe('0.00')
    expect(formatMbps(Number.NaN)).toBe('0.00')
  })
})
