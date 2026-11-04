import { create } from 'zustand'
import type { AppNotification, NotifyLevel } from '@/common/types/ipc'
import { logEvent } from './eventLog'
import { api } from './tauri'

/** A toast lives this long before it collapses into the center. */
const DEFAULT_MS = 5000
/** Local (not persisted) rows get negative ids so they can never collide with the database's. */
let localSeq = -1

export type NotifyAction = { label: string; run: () => void }
export type NotifyOptions = { durationMs?: number; action?: NotifyAction }

/** A toast currently popped; `until` is a local `Date.now()` deadline. */
export type LiveNotification = { id: number; until: number; /** Hovered: the countdown is frozen. */ paused?: boolean; remaining?: number }

type State = {
 /** Persisted rows, ascending id (oldest first). */
 items: AppNotification[]
 live: LiveNotification[]
 /** Action callbacks are closures: they exist until the app restarts, by design. */
 actions: Map<number, NotifyAction>
 open: boolean
 /** Distance from the viewport bottom to the top of the popup stack; 0 when it is not shown. */
 stackBottomPx: number
 setStackBottomPx: (v: number) => void
 upsert: (n: AppNotification, durationMs?: number) => void
 hideLive: (id: number) => void
 pauseLive: (id: number) => void
 resumeLive: (id: number) => void
 remove: (id: number) => Promise<void>
 clear: () => Promise<void>
 load: () => Promise<void>
 setOpen: (open: boolean) => void
}

/**
 * Notification center state. A row reaches `upsert` twice for a frontend-raised notification (the
 * `notification:added` event and the command result, in either order), so a known id never re-pops.
 */
export const useNotifications = create<State>((set, get) => ({
 items: [],
 live: [],
 actions: new Map(),
 open: false,
 stackBottomPx: 0,
 setStackBottomPx: (v) => set({ stackBottomPx: v }),
 upsert: (n, durationMs) =>
  set((s) => {
   if (!s.items.some((i) => i.id === n.id)) {
    const live = s.open ? s.live : [...s.live, { id: n.id, until: Date.now() + (durationMs ?? DEFAULT_MS) }]
    return { items: [...s.items, n].sort((a, b) => a.id - b.id), live }
   }
   if (durationMs === undefined) return {}
   return { live: s.live.map((l) => (l.id === n.id ? { ...l, until: Date.now() + durationMs } : l)) }
  }),
 hideLive: (id) => set((s) => ({ live: s.live.filter((l) => l.id !== id) })),
 // Hovering a popup freezes its countdown; leaving resumes it with the time that was left.
 pauseLive: (id) =>
  set((s) => ({ live: s.live.map((l) => (l.id === id && !l.paused ? { ...l, paused: true, remaining: Math.max(0, l.until - Date.now()) } : l)) })),
 resumeLive: (id) =>
  set((s) => ({ live: s.live.map((l) => (l.id === id && l.paused ? { ...l, paused: false, until: Date.now() + (l.remaining ?? DEFAULT_MS) } : l)) })),
 remove: async (id) => {
  set((s) => {
   const actions = new Map(s.actions)
   actions.delete(id)
   return { items: s.items.filter((i) => i.id !== id), live: s.live.filter((l) => l.id !== id), actions }
  })
  try {
   await api.notificationsRemove(id)
  } catch {
   await get().load()
  }
 },
 clear: async () => {
  set({ items: [], live: [], actions: new Map() })
  try {
   await api.notificationsClear()
  } catch {
   await get().load()
  }
 },
 load: async () => {
  try {
   set({ items: await api.notificationsList() })
  } catch {
   logEvent('notifications: load failed')
  }
 },
 setOpen: (open) => set((s) => ({ open, live: open ? [] : s.live })),
}))

/**
 * Raises a warn/error notification: the backend stores it (it survives a restart) and pops a toast.
 * Never throws, so a broken backend cannot turn into an `unhandledrejection` loop.
 */
export function notify(level: NotifyLevel, message: string, options?: NotifyOptions): void {
 api
  .notificationsPush(level, message)
  .then((n) => {
   const action = options?.action
   if (action) useNotifications.setState((s) => ({ actions: new Map(s.actions).set(n.id, action) }))
   useNotifications.getState().upsert(n, options?.durationMs)
  })
  .catch(() => {
   // The store is unreachable: the message still belongs in the center, just not on disk.
   logEvent(`notify failed: ${message}`)
   const row: AppNotification = { id: localSeq--, level, message, createdAt: Math.floor(Date.now() / 1000) }
   const action = options?.action
   if (action) useNotifications.setState((s) => ({ actions: new Map(s.actions).set(row.id, action) }))
   useNotifications.getState().upsert(row, options?.durationMs)
  })
}
