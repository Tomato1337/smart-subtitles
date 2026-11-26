import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { CueAnnotation } from '@/common/types/ipc'
import { PatternBadges } from './PatternBadges'

describe('PatternBadges', () => {
  test('deduplicates repeated patternId occurrences within one cue', () => {
    const qc = new QueryClient()
    const ann: CueAnnotation = {
      idx: 0,
      ru: '',
      chunks: [],
      patterns: [
        { patternId: 'THIRD_COND', startChar: 0, endChar: 10 },
        { patternId: 'THIRD_COND', startChar: 15, endChar: 25 },
        { patternId: 'MUST_HAVE_TO', startChar: 26, endChar: 35 },
      ],
    }
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <PatternBadges ann={ann} />
      </QueryClientProvider>,
    )
    const buttons = html.match(/<button /g) ?? []
    expect(buttons).toHaveLength(2)
  })
})
