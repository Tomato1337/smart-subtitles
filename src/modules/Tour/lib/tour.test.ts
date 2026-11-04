import { describe, expect, test } from 'vitest'
import { placeCard, resolveStep, visibleSteps, type TourStep } from './tour'

const step = (id: string, targets: string[], ifMissing: 'skip' | 'center' = 'skip'): TourStep => ({ id, targets, ifMissing, title: id, body: [] })

/** The player as the tour meets it: two centered steps, one always there, two that need an element. */
const STEPS = [
  step('intro', []),
  step('subtitle', ['subtitle'], 'center'),
  step('cue-actions', ['cue-actions']),
  step('patterns', ['patterns']),
  step('finish', []),
]

const nothing = () => false
const only = (...ids: string[]) => (id: string) => ids.includes(id)

const VIEW = { width: 1600, height: 900 }
const CARD = { width: 380, height: 240 }

describe('resolveStep', () => {
  test('skips a step whose target is not on screen', () => {
    expect(resolveStep(STEPS, 2, 1, only('cue-actions', 'patterns'))).toEqual({ index: 2, target: 'cue-actions' })
    expect(resolveStep(STEPS, 2, 1, nothing)).toEqual({ index: 4, target: null })
  })
  test('skips the same step going backwards', () => {
    expect(resolveStep(STEPS, 3, -1, nothing)).toEqual({ index: 1, target: null })
    expect(resolveStep(STEPS, 3, -1, only('patterns'))).toEqual({ index: 3, target: 'patterns' })
  })
  test('a centered step keeps its place without a target', () => {
    expect(resolveStep(STEPS, 1, 1, nothing)).toEqual({ index: 1, target: null })
  })
  test('the first target present on screen is the one highlighted', () => {
    const dialogs = [step('dialogs', ['sidebar', 'dialogs'])]
    expect(resolveStep(dialogs, 0, 1, only('dialogs'))).toEqual({ index: 0, target: 'dialogs' })
    expect(resolveStep(dialogs, 0, 1, only('sidebar', 'dialogs'))).toEqual({ index: 0, target: 'sidebar' })
  })
  test('nothing showable gives null past the ends', () => {
    expect(resolveStep([step('patterns', ['patterns'])], 0, 1, nothing)).toBeNull()
    expect(resolveStep(STEPS, STEPS.length, 1, only('subtitle'))).toBeNull()
    expect(resolveStep(STEPS, -1, -1, only('subtitle'))).toBeNull()
  })
})

describe('visibleSteps', () => {
  test('leaves out the steps without a target and keeps the centered ones', () => {
    expect(visibleSteps(STEPS, only('subtitle'))).toEqual([0, 1, 4])
    expect(visibleSteps(STEPS, only('subtitle', 'cue-actions', 'patterns'))).toEqual([0, 1, 2, 3, 4])
  })
})

describe('placeCard', () => {
  test('a target low on the screen puts the card above it', () => {
    expect(placeCard({ left: 600, top: 840, width: 300, height: 40 }, CARD, VIEW)).toEqual({ left: 560, top: 840 - CARD.height - 12 })
  })
  test('a target at the top puts the card below it', () => {
    expect(placeCard({ left: 600, top: 12, width: 300, height: 40 }, CARD, VIEW)).toEqual({ left: 560, top: 12 + 40 + 12 })
  })
  test('a tall target on the left takes the card on its right', () => {
    expect(placeCard({ left: 0, top: 0, width: 380, height: 900 }, CARD, VIEW)).toEqual({ left: 392, top: 450 - CARD.height / 2 })
  })
  test('no target: the card is centered', () => {
    expect(placeCard(null, CARD, VIEW)).toEqual({ left: 610, top: 330 })
  })
  test('a target at the left edge keeps the card inside the margin', () => {
    expect(placeCard({ left: 0, top: 100, width: 20, height: 20 }, CARD, VIEW).left).toBe(8)
  })
})
