import { useEffect } from 'react'
import { toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, onEvent } from '@/common/api/tauri'
import { useSessionStore } from './store/sessionStore'

/** Bridges backend session events into the store; `onOpened` is called when a session is ready (navigate to the player). */
export function useSessionEvents(onOpened: () => void) {
  useEffect(() => {
    const { setSession, setLoading } = useSessionStore.getState()
    const un = [
      onEvent('session:loading', (e) => { setSession(null); setLoading(e.title) }),
      onEvent('session:opened', (s) => { setSession(s); onOpened() }),
      onEvent('player:error', (e) => { setLoading(null); notify('error', e.message) }),
      onEvent('toast', (e) => toast(e.message)),
    ]
    void api.sessionCurrent().then((s) => { if (s) { setSession(s); onOpened() } })
    return () => { un.forEach((p) => void p.then((f) => f())) }
  }, [onOpened])
}
