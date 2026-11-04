import { useEffect } from 'react'
import { notify } from '@/common/api/notify'
import { api, errorText, onEvent } from '@/common/api/tauri'
import { useSubsStore } from './store/subsStore'

/** Loads cues for a media and keeps them in sync with backend events. */
export function useSubtitlesData(mediaId: string, subOffset: number) {
  useEffect(() => {
    const st = useSubsStore.getState()
    st.reset(mediaId, subOffset)
    let alive = true
    const load = () =>
      api.subsList(mediaId).then((l) => {
        if (!alive) return
        useSubsStore.getState().setCues(l.cues, l.annotations)
        // Consent and batch counters: the gate and the progress chip read them from the store.
        api.annotStatus(mediaId).then((a) => { if (alive) useSubsStore.getState().setAnnot(a) }).catch(() => { })
        // Embedded subtitles: a load in progress, or the confirmation dialog waiting for an answer.
        void api.subsEmbeddedState(mediaId).then((e) => { if (alive) useSubsStore.getState().setEmbedded(e) }).catch(() => { })
      }).catch((e) => notify('error', errorText(e)))

    const un = [
      onEvent('subs:status', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().setStatus(e) }),
      onEvent('subs:updated', (e) => { if (e.mediaId === mediaId) void load() }),
      // The backend matched the subtitle timing to the speech: shift without reloading the cues.
      onEvent('subs:offset', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().setOffset(e.offset) }),
      onEvent('subs:embedded', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().setEmbedded(e.state) }),
      onEvent('annot:updated', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().applyAnnotations(e.cues) }),
      onEvent('annot:failed', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().markFailed(e.firstIdx) }),
      onEvent('annot:progress', (e) => { if (e.mediaId === mediaId) useSubsStore.getState().setAnnot(e) }),
    ]
    void load()
    return () => {
      alive = false
      un.forEach((p) => void p.then((f) => f()))
    }
  }, [mediaId, subOffset])
}
