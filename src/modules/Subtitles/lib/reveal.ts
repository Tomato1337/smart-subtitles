import type { Cue } from '@/common/types/ipc'

export type Reveal = { t0: number; until: number }

/** Fraction 0..1 of the cue already spoken at `absTime`; 1 once it is over (the phrase stays in focus fully lit). */
export function spokenFraction(absTime: number, cue: Cue, offset: number): number {
 const f = (absTime - offset - cue.start) / Math.max(0.001, cue.end - cue.start)
 return Math.min(1, Math.max(0, f))
}

/**
 * Subtitle line state. In hidden mode text is shown only while a reveal window (opened by `A`) is running.
 * `karaoke` is the fraction of the cue already spoken: spoken words are lit, the rest dimmed, in both modes.
 */
export function subtitleVisibility(hideMode: boolean, reveal: Reveal | null, absTime: number, cue: Cue, offset: number): { visible: boolean; karaoke?: number } {
 if (hideMode && !(reveal && absTime < reveal.until)) return { visible: false }
 return { visible: true, karaoke: spokenFraction(absTime, cue, offset) }
}

/** Reveal window for `A` pressed at `t0`: rewind 5 s, show until t0 + 2 s. */
export function startReveal(t0: number): { reveal: Reveal; seekTo: number } {
 return { reveal: { t0, until: t0 + 2 }, seekTo: Math.max(0, t0 - 5) }
}
