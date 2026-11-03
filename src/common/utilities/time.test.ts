import { expect, test } from 'vitest'
import { formatTime } from './time'

test('formatTime', () => {
  expect(formatTime(0)).toBe('0:00')
  expect(formatTime(65.9)).toBe('1:05')
  expect(formatTime(3725)).toBe('1:02:05')
  expect(formatTime(-3)).toBe('0:00')
})
