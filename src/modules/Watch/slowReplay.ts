export const SLOW_RATE = 0.75

/** A slowed replay of one cue: the rate holds only while the playhead is inside [from, to). */
export type SlowWindow = { from: number; to: number; prevRate: number; armed: boolean; startedAt: number }

export type SlowAction = 'keep' | 'restore' | 'drop'

/** Seek to the cue may land slightly early (keyframe) — still counts as inside. */
const LEAD = 0.75
/** The seek never reached the cue (failed stream, user moved on): give the speed back. */
const ARM_TIMEOUT_MS = 30_000

/**
 * One 100 ms check. 'restore' puts `prevRate` back; 'drop' forgets the window without touching the rate
 * (the user picked another speed by hand). Before the seek lands the playhead is still at the old spot,
 * so leaving the window counts only after it was entered (`armed`).
 */
export function slowStep(w: SlowWindow, t: number, rate: number, settling: boolean, nowMs: number): SlowAction {
 if (rate !== SLOW_RATE) return 'drop'
 if (settling) return 'keep'
 if (!w.armed) {
  if (t >= w.from - LEAD && t < w.to) w.armed = true
  else if (nowMs - w.startedAt > ARM_TIMEOUT_MS) return 'restore'
  return 'keep'
 }
 return t >= w.to || t < w.from - LEAD - 0.25 ? 'restore' : 'keep'
}
