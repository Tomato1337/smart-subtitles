import { useEffect } from 'react'
import { api, errorText, onEvent } from '@/common/api/tauri'
import { toast } from '@/common/ui/toast'
import { useSubsStore } from './store/subsStore'

/** Loads cues for a media and keeps them in sync with backend events. */
export function useSubtitlesData(mediaId: string, subOffset: number) {
  useEffect(() => {
    const st = useSubsStore.getState()
    st.reset(mediaId, subOffset)
    let alive = true
    const load = () =>
      api.subsList(mediaId).then((l) => { if (alive) useSubsStore.getState().setCues(l.cues, l.annotations) }).catch((e) => toast(errorText(e)))

    const un = [
      onEvent('subs:status', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().setStatus(e) }),
      onEvent('subs:updated', (e) => { if (e.mediaId === mediaId) void load() }),
      // The backend matched the subtitle timing to the speech: shift without reloading the cues.
      onEvent('subs:offset', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().setOffset(e.offset) }),
      onEvent('annot:updated', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().applyAnnotations(e.cues) }),
      onEvent('annot:failed', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().markFailed(e.firstIdx) }),
    ]
    void load()
    return () => {
      alive = false
      un.forEach((p) => void p.then((f) => f()))
    }
  }, [mediaId, subOffset])
}
