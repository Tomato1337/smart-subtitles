import type { Cue } from '@/common/types/ipc'

/** Index of the cue active at media time `t` (cue window shifted by `offset`), or -1. */
export function findCueIndex(cues: Cue[], t: number, offset: number): number {
  let lo = 0
  let hi = cues.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start + offset <= t) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  // Cues may overlap slightly: walk back while an earlier one still covers `t`.
  for (let i = best; i >= 0 && i >= best - 2; i--) {
    if (t < cues[i].end + offset) return i
  }
  return -1
}

/** Cue to jump to for the "previous" button: restarts the current cue if it has played > 1 s. */
export function prevCueIndex(cues: Cue[], t: number, offset: number): number {
  const cur = findCueIndex(cues, t, offset)
  if (cur >= 0 && t - (cues[cur].start + offset) > 1) return cur
  const ref = cur >= 0 ? cur : lastStartedBefore(cues, t, offset)
  return Math.max(0, cur >= 0 ? cur - 1 : ref)
}

export function nextCueIndex(cues: Cue[], t: number, offset: number): number {
  const cur = findCueIndex(cues, t, offset)
  if (cur >= 0) return Math.min(cues.length - 1, cur + 1)
  const prev = lastStartedBefore(cues, t, offset)
  return Math.min(cues.length - 1, prev + 1)
}

/** Index of the last cue that has started by `t` (the active one, or the previous one during a gap); -1 before the first. */
export function lastStartedBefore(cues: Cue[], t: number, offset: number): number {
  let lo = 0
  let hi = cues.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start + offset <= t) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

/** Moment cue `i` leaves focus: when the next cue starts, or when the final cue ends. */
export function focusEnd(cues: Cue[], i: number, offset: number): number {
  return (i + 1 < cues.length ? cues[i + 1].start : cues[i].end) + offset
}

/** Cue held in focus at `t`: the last started one stays until the next starts (the final one until its end); -1 before the first. */
export function focusedCueIndex(cues: Cue[], t: number, offset: number): number {
  const i = lastStartedBefore(cues, t, offset)
  return i >= 0 && t < focusEnd(cues, i, offset) ? i : -1
}
