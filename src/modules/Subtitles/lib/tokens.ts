export type Token = { text: string; start: number; end: number; isWord: boolean }

let segmenter: Intl.Segmenter | null = null

/** Splits a cue into word and non-word tokens; offsets index into `text`. */
export function tokenize(text: string): Token[] {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'word' })
  const out: Token[] = []
  for (const s of segmenter.segment(text)) {
    out.push({ text: s.segment, start: s.index, end: s.index + s.segment.length, isWord: s.isWordLike ?? false })
  }
  return out
}
