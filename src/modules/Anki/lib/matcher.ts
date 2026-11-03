import type { AnkiCard, AnkiEntry } from '@/common/types/ipc'
import { lemma, lemmaKey } from './lemma'

const MAX_TOKENS = 4

/** Map from lemma key to card; cards of 1–4 tokens only (longer phrase cards are not matched in subtitles). */
export function buildIndex(cards: AnkiCard[]): Map<string, AnkiEntry> {
  const m = new Map<string, AnkiEntry>()
  for (const c of cards) {
    const key = lemmaKey(c.word)
    const n = key ? key.split(' ').length : 0
    if (n < 1 || n > MAX_TOKENS) continue
    const prev = m.get(key)
    if (!prev || c.interval < prev.interval) m.set(key, { ...c, key })
  }
  return m
}

export type AnkiMatch = { from: number; to: number; entry: AnkiEntry }

/** Greedy longest match (4 → 1 words) over consecutive words, without overlaps. `from`/`to` index `words`, inclusive. */
export function matchWords(words: string[], index: Map<string, AnkiEntry>): AnkiMatch[] {
  const lemmas = words.map((w) => lemma(w.replace(/[^A-Za-z']/g, '')))
  const out: AnkiMatch[] = []
  let i = 0
  while (i < words.length) {
    let hit: AnkiMatch | null = null
    for (let n = Math.min(MAX_TOKENS, words.length - i); n >= 1 && !hit; n--) {
      const entry = index.get(lemmas.slice(i, i + n).join(' '))
      if (entry) hit = { from: i, to: i + n - 1, entry }
    }
    if (hit) {
      out.push(hit)
      i = hit.to + 1
    } else i++
  }
  return out
}

/** Card for a clicked span: lemma key first, then exact lower-case word. */
export function lookupSpan(span: string, index: Map<string, AnkiEntry>, cards: AnkiCard[]): AnkiEntry | undefined {
  const k = lemmaKey(span)
  return index.get(k) ?? (() => {
    const w = span.trim().toLowerCase()
    const c = cards.find((x) => x.word.trim().toLowerCase() === w)
    return c ? { ...c, key: k } : undefined
  })()
}
