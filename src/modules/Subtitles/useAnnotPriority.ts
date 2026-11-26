import { useEffect, useRef } from 'react'
import { api } from '@/common/api/tauri'
import { usePlaybackStore } from '@/modules/Player'
import { lastStartedBefore } from './lib/cues'
import { useSubsStore } from './store/subsStore'

/** Cues per analysis batch; the backend uses the same size, so one priority per batch is enough. */
const BATCH = 40

/**
 * Tells the backend where the viewer is, so the background analysis runs from the current cue on
 * instead of from the start of the film. Sent once per batch, on every jump and wrap-around.
 */
export function useAnnotPriority(mediaId: string) {
  /** Batch of the last sent priority; `null` means nothing has been sent for this film yet. */
  const sent = useRef<number | null>(null)
  useEffect(() => {
    sent.current = null
    let prevCues = useSubsStore.getState().cues
    let prevOffset = useSubsStore.getState().offset
    const apply = () => {
      const { cues, offset } = useSubsStore.getState()
      if (cues.length === 0) {
        sent.current = null
        return
      }
      const i = Math.max(lastStartedBefore(cues, usePlaybackStore.getState().absTime, offset), 0)
      const b = Math.floor(i / BATCH)
      if (b === sent.current) return
      sent.current = b
      api.annotPrioritize(mediaId, i).catch(() => {})
    }
    apply()
    const unPlay = usePlaybackStore.subscribe(apply)
    const unSubs = useSubsStore.subscribe((s) => {
      if (s.cues === prevCues && s.offset === prevOffset) return
      if (s.cues.length < prevCues.length || s.cues[0] !== prevCues[0]) sent.current = null
      prevCues = s.cues
      prevOffset = s.offset
      apply()
    })
    return () => {
      unPlay()
      unSubs()
    }
  }, [mediaId])
}
