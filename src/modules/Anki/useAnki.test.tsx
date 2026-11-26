import { describe, expect, test } from 'vitest'
import { assignAnkiLabelTiers } from './useAnki'

describe('assignAnkiLabelTiers', () => {
  test('staggers adjacent Anki labels into separate vertical tiers', () => {
    const { placed, rows } = assignAnkiLabelTiers([
      { tokenIndex: 0, charStart: 0, label: 'взволнованный' },
      { tokenIndex: 2, charStart: 8, label: 'истощённый' },
      { tokenIndex: 4, charStart: 18, label: 'смущённый' },
    ])
    expect(rows).toBeGreaterThanOrEqual(2)
    expect(placed.get(0)?.tier).toBe(0)
    expect(placed.get(2)?.tier).toBe(1)
    expect(placed.get(4)?.tier).not.toBe(placed.get(2)?.tier)
  })

  test('keeps well-separated Anki labels on tier 0', () => {
    const { placed, rows } = assignAnkiLabelTiers([
      { tokenIndex: 0, charStart: 0, label: 'бросить' },
      { tokenIndex: 10, charStart: 40, label: 'решить' },
    ])
    expect(rows).toBe(1)
    expect(placed.get(0)?.tier).toBe(0)
    expect(placed.get(10)?.tier).toBe(0)
  })
})
