import { describe, expect, test } from 'vitest'
import { remainingMinutesLabel } from './ControlBar'

describe('remainingMinutesLabel', () => {
  test('hides label when duration is zero, negative, or non-finite', () => {
    expect(remainingMinutesLabel(0, 0, 1)).toBeNull()
    expect(remainingMinutesLabel(10, -5, 1)).toBeNull()
    expect(remainingMinutesLabel(10, Number.NaN, 1)).toBeNull()
    expect(remainingMinutesLabel(10, Number.POSITIVE_INFINITY, 1)).toBeNull()
    expect(remainingMinutesLabel(Number.NaN, 120, 1)).toBeNull()
    expect(remainingMinutesLabel(10, 120, 0)).toBeNull()
  })

  test('hides label once playback meets or passes duration', () => {
    expect(remainingMinutesLabel(120, 120, 1)).toBeNull()
    expect(remainingMinutesLabel(130, 120, 1)).toBeNull()
  })

  test('formats rounded remaining minutes for valid playback state', () => {
    expect(remainingMinutesLabel(100, 120, 1)).toBe('осталось 1 мин')
    expect(remainingMinutesLabel(0, 300, 1)).toBe('осталось 5 мин')
    expect(remainingMinutesLabel(0, 300, 2)).toBe('осталось 3 мин')
  })
})
