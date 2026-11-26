import { describe, expect, test } from 'vitest'
import { formatCountRu, pluralRu } from './pluralRu'

describe('pluralRu & formatCountRu', () => {
  test('picks exact nominative plural forms across 0..125 boundaries', () => {
    const cases: [number, string][] = [
      [0, '0 фильмов'],
      [1, '1 фильм'],
      [2, '2 фильма'],
      [3, '3 фильма'],
      [4, '4 фильма'],
      [5, '5 фильмов'],
      [10, '10 фильмов'],
      [11, '11 фильмов'],
      [12, '12 фильмов'],
      [14, '14 фильмов'],
      [19, '19 фильмов'],
      [20, '20 фильмов'],
      [21, '21 фильм'],
      [22, '22 фильма'],
      [25, '25 фильмов'],
      [101, '101 фильм'],
      [111, '111 фильмов'],
      [112, '112 фильмов'],
      [121, '121 фильм'],
    ]
    for (const [count, expected] of cases) {
      expect(formatCountRu(count, 'фильм', 'фильма', 'фильмов')).toBe(expected)
    }
  })

  test('formats audit nouns and prepositional forms accurately', () => {
    expect(formatCountRu(1, 'разбор', 'разбора', 'разборов')).toBe('1 разбор')
    expect(formatCountRu(2, 'разбор', 'разбора', 'разборов')).toBe('2 разбора')
    expect(formatCountRu(10, 'разбор', 'разбора', 'разборов')).toBe('10 разборов')
    expect(formatCountRu(1, 'клик', 'клика', 'кликов')).toBe('1 клик')
    expect(formatCountRu(4, 'клик', 'клика', 'кликов')).toBe('4 клика')
    expect(formatCountRu(21, 'клик', 'клика', 'кликов')).toBe('21 клик')
    expect(formatCountRu(11, 'клик', 'клика', 'кликов')).toBe('11 кликов')
    expect(pluralRu(1, 'фильме', 'фильмах', 'фильмах')).toBe('фильме')
    expect(pluralRu(2, 'фильме', 'фильмах', 'фильмах')).toBe('фильмах')
    expect(pluralRu(11, 'фильме', 'фильмах', 'фильмах')).toBe('фильмах')
    expect(pluralRu(21, 'фильме', 'фильмах', 'фильмах')).toBe('фильме')
  })

  test('handles negative, fractional, and non-finite inputs safely', () => {
    expect(formatCountRu(-2, 'слово', 'слова', 'слов')).toBe('-2 слова')
    expect(formatCountRu(1.9, 'слово', 'слова', 'слов')).toBe('1 слово')
    expect(pluralRu(Number.NaN, 'фильм', 'фильма', 'фильмов')).toBe('фильмов')
    expect(formatCountRu(Number.NaN, 'фильм', 'фильма', 'фильмов')).toBe('0 фильмов')
    expect(formatCountRu(Number.POSITIVE_INFINITY, 'разбор', 'разбора', 'разборов')).toBe('0 разборов')
  })
})
