import { describe, expect, test } from 'vitest'
import type { AnkiCard } from '@/common/types/ipc'
import { lemma } from './lemma'
import { buildIndex, matchWords } from './matcher'

describe('lemma', () => {
  test('irregular forms', () => {
    expect(lemma('brought')).toBe('bring')
    expect(lemma('brings')).toBe('bring')
    expect(lemma('children')).toBe('child')
  })
})

const card = (word: string, status: AnkiCard['status'] = 'new'): AnkiCard => ({ word, translation: 'x', status, interval: 0 })

describe('matcher', () => {
  const index = buildIndex([card('bring up'), card('bring')])
  const words = (s: string) => s.split(' ')

  test('single word forms match', () => {
    const m = matchWords(words('He brought it'), index)
    expect(m).toHaveLength(1)
    expect(m[0].entry.word).toBe('bring')
  })
  test('phrase needs consecutive words', () => {
    const split = matchWords(words('He brought it up'), index)
    expect(split.map((x) => x.entry.word)).toEqual(['bring'])
    const joined = matchWords(words('brought up the kids'), index)
    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ from: 0, to: 1 })
    expect(joined[0].entry.word).toBe('bring up')
  })
  test('phrase cards longer than four words are ignored', () => {
    expect(buildIndex([card('this is a very long phrase')]).size).toBe(0)
  })
})
