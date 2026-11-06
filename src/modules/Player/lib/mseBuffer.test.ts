import { describe, expect, test } from 'vitest'
import { codecFromInit, evictions, rangeAt, takeAppend } from './mseBuffer'

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

describe('takeAppend', () => {
  const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v)
  test('merges whole chunks up to the cap', () => {
    const q = [bytes(3, 1), bytes(3, 2), bytes(3, 3)]
    expect(Array.from(takeAppend(q, 7)!)).toEqual([1, 1, 1, 2, 2, 2])
    expect(q.map((c) => c.length)).toEqual([3])
  })
  test('splits a chunk larger than the cap', () => {
    const q = [Uint8Array.from([1, 2, 3, 4, 5])]
    expect(Array.from(takeAppend(q, 2)!)).toEqual([1, 2])
    expect(Array.from(takeAppend(q, 2)!)).toEqual([3, 4])
    expect(Array.from(takeAppend(q, 2)!)).toEqual([5])
    expect(takeAppend(q, 2)).toBeNull()
  })
  test('hands a single fitting chunk over as is', () => {
    const c = bytes(4)
    const q = [c]
    expect(takeAppend(q, 4)).toBe(c)
    expect(q).toEqual([])
  })
})

