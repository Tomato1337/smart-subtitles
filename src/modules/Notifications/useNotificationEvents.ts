import { useEffect } from 'react'
import { useNotifications } from '@/common/api/notify'
import { onEvent } from '@/common/api/tauri'

/** Loads the persisted notifications and follows new ones raised anywhere in the backend. */
export function useNotificationEvents() {
  useEffect(() => {
    void useNotifications.getState().load()
    const un = onEvent('notification:added', (n) => useNotifications.getState().upsert(n))
    return () => { void un.then((f) => f()) }
  }, [])
}
