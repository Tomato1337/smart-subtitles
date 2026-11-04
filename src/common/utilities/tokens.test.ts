import { describe, expect, it } from 'vitest'
import { estimateUsd, formatTokens, formatUsd } from './tokens'

describe('formatTokens', () => {
  it('picks the compact unit', () => {
    expect(formatTokens(60)).toBe('60')
    expect(formatTokens(23_000)).toBe('23K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_450_000)).toBe('1.4M')
  })
})

describe('formatUsd', () => {
  it('keeps cents from a cent up and one digit below', () => {
    expect(formatUsd(0.26)).toBe('$0.26')
    expect(formatUsd(0.004)).toBe('$0.004')
    expect(formatUsd(0)).toBe('$0')
  })
})

describe('estimateUsd', () => {
  it('charges cached input at the cache price', () => {
    const p = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: null }
    expect(estimateUsd(p, 1000, 500, 100)).toBeCloseTo(0.00155, 8)
    // No cache price: cached tokens cost the full input price.
    expect(estimateUsd({ ...p, cacheRead: null }, 1000, 500, 100)).toBeCloseTo(0.002, 8)
  })
})
