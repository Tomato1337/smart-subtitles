import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { VocabInfo } from '@/common/types/ipc'
import { pluralTimesRu, VocabBadges } from './VocabBadges'

const baseVocab: VocabInfo = {
  query: 'test',
  lemma: 'test',
  isPhrase: false,
  found: true,
  tier: 'core',
  cefr: 'A1',
  cefrSource: 'CEFR',
  aboveLevel: false,
  ranks: { ngsl: 100, ngslSpoken: null, bsl: null, subtitles: 100 },
  zipf: 5.5,
  business: false,
  spoken: true,
  filmCount: 2,
  parts: [],
}

describe('VocabBadges pluralization', () => {
  test('formats Russian «раз»/«раза» forms correctly', () => {
    expect(pluralTimesRu(1)).toBe('раз')
    expect(pluralTimesRu(2)).toBe('раза')
    expect(pluralTimesRu(3)).toBe('раза')
    expect(pluralTimesRu(4)).toBe('раза')
    expect(pluralTimesRu(5)).toBe('раз')
    expect(pluralTimesRu(11)).toBe('раз')
    expect(pluralTimesRu(12)).toBe('раз')
    expect(pluralTimesRu(14)).toBe('раз')
    expect(pluralTimesRu(21)).toBe('раз')
    expect(pluralTimesRu(22)).toBe('раза')
  })

  test('renders proper Russian plural title in VocabBadges', () => {
    const html2 = renderToStaticMarkup(<VocabBadges vocab={{ ...baseVocab, filmCount: 2 }} />)
    expect(html2).toContain('2 раза')
    expect(html2).not.toContain('раз(а)')

    const html12 = renderToStaticMarkup(<VocabBadges vocab={{ ...baseVocab, filmCount: 12 }} />)
    expect(html12).toContain('12 раз')
  })
})
