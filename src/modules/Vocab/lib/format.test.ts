import { describe, expect, it } from 'vitest'
import type { VocabInfo } from '@/common/types/ipc'
import { formatCorpusSummary, mergeSpanAndChunk, resolveFrequencyBadge } from './format'

function makeVocab(patch: Partial<VocabInfo> = {}): VocabInfo {
  return {
    query: 'decide',
    lemma: 'decide',
    isPhrase: false,
    found: true,
    tier: 'core',
    cefr: 'A2',
    cefrSource: 'CEFR-J 1.5',
    aboveLevel: false,
    ranks: { ngsl: 241, ngslSpoken: 279, bsl: null, subtitles: 412 },
    zipf: 5.4,
    business: false,
    spoken: true,
    filmCount: 3,
    parts: [],
    ...patch,
  }
}

describe('resolveFrequencyBadge', () => {
  it('prefers corpus tier over AI estimate for single words', () => {
    const badge = resolveFrequencyBadge(makeVocab({ tier: 'core' }), 'rare')
    expect(badge?.label).toBe('Базовое')
    expect(badge?.tone).toBe('success')
    expect(badge?.isAiEstimate).toBe(false)
    expect(badge?.hint).toContain('NGSL #241')
  })

  it('uses distinct hint for rare words missing from the 50k subtitle list', () => {
    const badge = resolveFrequencyBadge(
      makeVocab({
        query: 'xyzzy',
        lemma: null,
        found: false,
        tier: 'rare',
        cefr: null,
        cefrSource: null,
        ranks: { ngsl: null, ngslSpoken: null, bsl: null, subtitles: null },
        zipf: null,
      }),
    )
    expect(badge?.label).toBe('Редкое')
    expect(badge?.tone).toBe('warning')
    expect(badge?.hint).toContain('Нет в топ-50 000')
    expect(badge?.isAiEstimate).toBe(false)
  })

  it('falls back to AI frequency for unindexed multi-word expressions', () => {
    const badge = resolveFrequencyBadge(
      makeVocab({
        query: 'bail on',
        lemma: 'bail on',
        isPhrase: true,
        found: false,
        tier: null,
        cefr: null,
        cefrSource: null,
        ranks: { ngsl: null, ngslSpoken: null, bsl: null, subtitles: null },
        zipf: null,
        parts: [
          { word: 'bail', lemma: 'bail', tier: 'common', cefr: 'B2', functionWord: false },
          { word: 'on', lemma: 'on', tier: 'core', cefr: 'A1', functionWord: true },
        ],
      }),
      'common',
    )
    expect(badge?.label).toBe('Частое')
    expect(badge?.tone).toBe('primary')
    expect(badge?.isAiEstimate).toBe(true)
    expect(badge?.hint).toContain('Оценка ИИ')
  })

  it('returns null when neither corpus nor AI frequency exists (e.g. pure number)', () => {
    const num = makeVocab({
      query: '2024',
      lemma: null,
      found: false,
      tier: null,
      cefr: null,
      ranks: { ngsl: null, ngslSpoken: null, bsl: null, subtitles: null },
      zipf: null,
    })
    expect(resolveFrequencyBadge(num, null)).toBeNull()
  })
})

describe('formatCorpusSummary & mergeSpanAndChunk', () => {
  it('formats phrase constituent words when phrase is unindexed', () => {
    const summary = formatCorpusSummary(
      makeVocab({
        query: 'bail on someone',
        isPhrase: true,
        found: false,
        tier: null,
        cefr: null,
        ranks: { ngsl: null, ngslSpoken: null, bsl: null, subtitles: null },
        zipf: null,
        parts: [
          { word: 'bail', lemma: 'bail', tier: 'common', cefr: 'B2', functionWord: false },
          { word: 'on', lemma: 'on', tier: 'core', cefr: 'A1', functionWord: true },
          { word: 'someone', lemma: 'someone', tier: 'core', cefr: 'A1', functionWord: true },
        ],
      }),
    )
    expect(summary).toBe('слова: bail (частое, B2)')
  })

  it('prefers indexed canonical chunk over unindexed span while preserving max filmCount', () => {
    const span = makeVocab({ query: 'mull it over', isPhrase: true, found: false, tier: null, filmCount: 4 })
    const chunk = makeVocab({ query: 'mull over', isPhrase: true, found: true, tier: 'rare', cefr: 'C2', filmCount: 1 })
    const merged = mergeSpanAndChunk(span, chunk)
    expect(merged?.query).toBe('mull over')
    expect(merged?.cefr).toBe('C2')
    expect(merged?.filmCount).toBe(4)
  })
})
