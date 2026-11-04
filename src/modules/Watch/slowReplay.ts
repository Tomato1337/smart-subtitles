export const SLOW_RATE = 0.75

/** A slowed replay of one cue: the rate holds only while the playhead is inside [from, to). */
export type SlowWindow = { from: number; to: number; prevRate: number; armed: boolean; startedAt: number }

/** A plain replay of one cue: it stops (pauses) when the playhead reaches the cue end. */
export type ReplayWindow = { from: number; to: number; armed: boolean; startedAt: number }

export type SlowAction = 'keep' | 'restore' | 'drop' | 'pause'
export type ReplayAction = 'keep' | 'cancel' | 'pause'

/** Seek to the cue may land slightly early (keyframe) — still counts as inside. */
const LEAD = 0.75
/** The seek never reached the cue (failed stream, user moved on): give the speed back. */
const ARM_TIMEOUT_MS = 30_000
/** Stop a little before the cue end so the next (often contiguous) cue does not take focus. */
const END_PAD = 0.06

/**
 * One 25 ms check. 'restore' puts `prevRate` back; 'drop' forgets the window without touching the rate
 * (the user picked another speed by hand); 'pause' means the cue has been played to its end.
 * Before the seek lands the playhead is still at the old spot, so leaving the window counts only after
 * it was entered (`armed`).
 */
export function slowStep(w: SlowWindow, t: number, rate: number, settling: boolean, nowMs: number): SlowAction {
 if (rate !== SLOW_RATE) return 'drop'
 if (settling) return 'keep'
 if (!w.armed) {
  if (t >= w.from - LEAD && t < w.to) w.armed = true
  else if (nowMs - w.startedAt > ARM_TIMEOUT_MS) return 'restore'
  return 'keep'
 }
 if (t >= w.to - END_PAD) return 'pause'
 return t < w.from - LEAD - 0.25 ? 'restore' : 'keep'
}

/**
 * One 25 ms check for a normal-speed replay. 'cancel' when the playhead never reached the cue or the
 * user pulled it back; 'pause' once the replay has reached the cue end.
 */
export function replayStep(w: ReplayWindow, t: number, settling: boolean, nowMs: number): ReplayAction {
 if (settling) return 'keep'
 if (!w.armed) {
  if (t >= w.from - LEAD && t < w.to) w.armed = true
  else if (nowMs - w.startedAt > ARM_TIMEOUT_MS) return 'cancel'
  return 'keep'
 }
 if (t >= w.to - END_PAD) return 'pause'
 return t < w.from - LEAD - 0.25 ? 'cancel' : 'keep'
}
