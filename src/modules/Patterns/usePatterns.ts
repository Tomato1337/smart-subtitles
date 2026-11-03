import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/common/api/tauri'
import { usePlaybackStore } from '@/modules/Player'

export const statsKey = ['patterns-stats'] as const

export function usePatternStats() {
  return useQuery({ queryKey: statsKey, queryFn: api.patternsStats })
}

/** Records an exposure when a cue becomes active during normal playback (not within 1 s after a seek). */
export function usePatternExposure(mediaId: string, cueIdx: number) {
  const done = useRef<string>('')
  useEffect(() => {
    if (cueIdx < 0) return
    const key = `${mediaId}:${cueIdx}`
    if (done.current === key) return
    done.current = key
    if (Date.now() - usePlaybackStore.getState().lastSeekAt < 1000) return
    void api.patternsExposure(mediaId, cueIdx)
  }, [mediaId, cueIdx])
}
