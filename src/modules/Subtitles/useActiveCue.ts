import { useMemo } from 'react'
import { usePlaybackStore } from '@/modules/Player'
import type { Cue } from '@/common/types/ipc'
import { findCueIndex, focusedCueIndex } from './lib/cues'
import { spokenFraction } from './lib/reveal'
import { useSubsStore } from './store/subsStore'

/** Cue being spoken right now (or -1), re-rendering only when the index itself changes. */
export function useActiveCueIndex(): number {
  const cues = useSubsStore((s) => s.cues)
  const offset = useSubsStore((s) => s.offset)
  return usePlaybackStore((s) => findCueIndex(cues, s.absTime, offset))
}

/** Phrase held in focus: stays after it is spoken until the next one starts. Drives the overlay, sidebar highlight and scroll. */
export function useFocusedCueIndex(): number {
  const cues = useSubsStore((s) => s.cues)
  const offset = useSubsStore((s) => s.offset)
  return usePlaybackStore((s) => focusedCueIndex(cues, s.absTime, offset))
}

export function useFocusedCue() {
  const idx = useFocusedCueIndex()
  const cues = useSubsStore((s) => s.cues)
  return useMemo(() => (idx >= 0 ? cues[idx] : null), [idx, cues])
}

/** Spoken part of `cue` (0..1, step 0.01) for the karaoke highlight; undefined and no re-renders when `cue` is null. */
export function useSpokenFraction(cue: Cue | null): number | undefined {
  const offset = useSubsStore((s) => s.offset)
  return usePlaybackStore((s) => (cue ? Math.round(spokenFraction(s.absTime, cue, offset) * 100) / 100 : undefined))
}
