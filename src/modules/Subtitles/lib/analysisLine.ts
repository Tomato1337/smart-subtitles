import type { Cue } from '@/common/types/ipc'

/** Cues per analysis batch; mirrors `annotate::BATCH` in the backend. */
export const ANNOT_BATCH = 40

/** A stretch of the film whose dialog analysis is ready, in seconds. */
export type Span = { from: number; to: number }

/**
 * Where the analysis is ready along the timeline. Batches finish out of order — the one at the
 * resume point first, then forward — so this is a set of ranges, not one bar. A batch counts as
 * analyzed when at least one of its cues carries a translation (the rule the consent gate uses
 * too), and ranges separated by less than a second merge, since a one-second break is invisible
 * under the timeline anyway.
 */
export function analyzedSpans(cues: Cue[], annotated: Iterable<number>, batch = ANNOT_BATCH): Span[] {
 const done = new Set(annotated)
 if (cues.length === 0 || done.size === 0) return []
 const spans: Span[] = []
 for (let first = 0; first < cues.length; first += batch) {
  const stop = Math.min(first + batch, cues.length)
  let covered = false
  for (let i = first; i < stop; i++) {
   if (done.has(cues[i].idx)) {
    covered = true
    break
   }
  }
  if (!covered) continue
  const from = cues[first].start
  const to = cues[stop - 1].end
  const prev = spans[spans.length - 1]
  if (prev && from <= prev.to + 1) prev.to = Math.max(prev.to, to)
  else spans.push({ from, to })
 }
 return spans
}
