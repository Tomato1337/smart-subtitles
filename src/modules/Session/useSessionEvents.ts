import { useEffect } from 'react'
import { api, onEvent } from '@/common/api/tauri'
import { toast } from '@/common/ui/toast'
import { useSessionStore } from './store/sessionStore'

/** Bridges backend session events into the store; `onOpened` is called when a session is ready (navigate to the player). */
export function useSessionEvents(onOpened: () => void) {
  useEffect(() => {
    const { setSession, setLoading } = useSessionStore.getState()
    const un = [
      onEvent('session:loading', (e) => { setSession(null); setLoading(e.title) }),
      onEvent('session:opened', (s) => { setSession(s); onOpened() }),
      onEvent('player:error', (e) => { setLoading(null); toast(e.message) }),
      onEvent('toast', (e) => toast(e.message)),
    ]
    void api.sessionCurrent().then((s) => { if (s) { setSession(s); onOpened() } })
    return () => { un.forEach((p) => void p.then((f) => f())) }
  }, [onOpened])
}
