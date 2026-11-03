import { describe, expect, test } from 'vitest'
import { codecFromInit, evictions, rangeAt } from './mseBuffer'

describe('codecFromInit', () => {
  const init = new Uint8Array([0, 0, 0, 0x10, 0x61, 0x76, 0x63, 0x43, 1, 0x64, 0x00, 0x28])
  test('reads profile, compatibility and level after avcC', () => {
    expect(codecFromInit(init)).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"')
  })
  test('waits for the level byte', () => {
    expect(codecFromInit(init.slice(0, 10))).toBeNull()
  })
})

describe('evictions', () => {
  test('cuts the parts outside the window', () => {
    expect(evictions([[0, 400]], 200, 90, 180)).toEqual([[0, 110], [380, 400]])
  })
  test('keeps a range fully inside the window', () => {
    expect(evictions([[150, 250]], 200, 90, 180)).toEqual([])
  })
})

describe('rangeAt', () => {
  test('matches only inside the range', () => {
    expect(rangeAt([[10, 20]], 20.2, 0)).toBeNull()
    expect(rangeAt([[10, 20]], 9.8, 0.5)).toEqual([10, 20])
  })
})
