import { create } from 'zustand'
import type { SessionLoading, SessionState } from '@/common/types/ipc'

export type LoadingSession = SessionLoading & { startedAt: number }

type SessionStore = {
  session: SessionState | null
  /** Session whose ffprobe is still running, with the timestamp (ms) when loading started. */
  loading: LoadingSession | null
  setSession: (s: SessionState | null) => void
  setLoading: (l: SessionLoading | null, startedAt?: number) => void
}

export const useSessionStore = create<SessionStore>((set) => ({
  session: null,
  loading: null,
  setSession: (session) => set({ session, loading: null }),
  setLoading: (loading, startedAt = Date.now()) =>
    set({ loading: loading ? { ...loading, startedAt } : null }),
}))
