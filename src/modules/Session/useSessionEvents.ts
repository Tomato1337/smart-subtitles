import { useEffect } from 'react'
import { toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, onEvent } from '@/common/api/tauri'
import type { SessionLoading, SessionState } from '@/common/types/ipc'
import { useSessionStore } from './store/sessionStore'

type SessionBridgeDeps = {
  onEvent: typeof onEvent
  sessionCurrent: () => Promise<SessionState | null>
  setSession: (s: SessionState | null) => void
  setLoading: (l: SessionLoading | null) => void
  onError: (msg: string) => void
  onToast: (msg: string) => void
  onOpened: () => void
}

/** Subscribes to live session events and hydrates the startup session unless a live event already arrived. */
export function attachSessionEvents({
  onEvent: subscribe,
  sessionCurrent,
  setSession,
  setLoading,
  onError,
  onToast,
  onOpened,
}: SessionBridgeDeps): () => void {
  let alive = true
  let liveEventSeen = false

  const un = [
    subscribe('session:loading', (e) => {
      liveEventSeen = true
      setSession(null)
      setLoading(e)
    }),
    subscribe('session:opened', (s) => {
      liveEventSeen = true
      setSession(s)
      onOpened()
    }),
    subscribe('player:error', (e) => {
      liveEventSeen = true
      setLoading(null)
      onError(e.message)
    }),
    subscribe('toast', (e) => onToast(e.message)),
  ]

  void sessionCurrent()
    .then((s) => {
      if (!alive || liveEventSeen || !s) return
      setSession(s)
      onOpened()
    })
    .catch(() => {})

  return () => {
    alive = false
    un.forEach((p) => void p.then((f) => f()))
  }
}

/** Bridges backend session events into the store; `onOpened` is called when a session is ready (navigate to the player). */
export function useSessionEvents(onOpened: () => void) {
  useEffect(() => {
    const { setSession, setLoading } = useSessionStore.getState()
    return attachSessionEvents({
      onEvent,
      sessionCurrent: api.sessionCurrent,
      setSession,
      setLoading,
      onError: (msg) => notify('error', msg),
      onToast: (msg) => toast(msg),
      onOpened,
    })
  }, [onOpened])
}
