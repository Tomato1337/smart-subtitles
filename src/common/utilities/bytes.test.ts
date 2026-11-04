import { describe, expect, test } from 'vitest'
import { formatBytes } from './bytes'

describe('formatBytes', () => {
  test('gigabytes keep one decimal', () => {
    expect(formatBytes(1.8 * 1024 ** 3)).toBe('1,8 ГБ')
    expect(formatBytes(2097152 * 900)).toBe('1,8 ГБ')
  })
  test('megabytes are rounded', () => {
    expect(formatBytes(350 * 1024 ** 2)).toBe('350 МБ')
    expect(formatBytes(2097152)).toBe('2 МБ')
  })
  test('nothing to show', () => {
    expect(formatBytes(0)).toBe('0 Б')
    expect(formatBytes(-5)).toBe('0 Б')
  })
})
