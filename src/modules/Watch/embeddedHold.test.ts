import { describe, expect, test } from 'vitest'
import type { EmbeddedState } from '@/common/types/ipc'
import { embeddedHold } from './embeddedHold'

const state = (p: Partial<EmbeddedState>): EmbeddedState => ({
  phase: 'loading',
  track: 'ENG · US',
  totalCues: 916,
  loadedCues: 0,
  loadedUntil: 0,
  headUntil: 600,
  estBytes: 1_932_735_283,
  headBytes: 100,
  pieceBytes: 2_097_152,
  message: null,
  ...p,
})

describe('embeddedHold', () => {
  test('the confirmation card holds the film', () => {
    expect(embeddedHold(state({ phase: 'confirm' }), false)).toBe('confirm')
    expect(embeddedHold(state({ phase: 'confirm' }), true)).toBe('confirm')
  })
  test('loading holds until the head is in', () => {
    expect(embeddedHold(state({ loadedUntil: 300 }), false)).toBe('loading')
    expect(embeddedHold(state({ loadedUntil: 600 }), false)).toBeNull()
  })
  test('skipping releases the hold while the rest loads', () => {
    expect(embeddedHold(state({ loadedUntil: 300 }), true)).toBeNull()
  })
  test('a finished or failed load holds nothing', () => {
    expect(embeddedHold(state({ phase: 'done' }), false)).toBeNull()
    expect(embeddedHold(state({ phase: 'failed', message: 'x' }), false)).toBeNull()
    expect(embeddedHold(null, false)).toBeNull()
  })
})
