import { create } from 'zustand'
import type { SessionState } from '@/common/types/ipc'

type SessionStore = {
  session: SessionState | null
  /** Title of a session whose ffprobe is still running. */
  loading: string | null
  setSession: (s: SessionState | null) => void
  setLoading: (t: string | null) => void
}

export const useSessionStore = create<SessionStore>((set) => ({
  session: null,
  loading: null,
  setSession: (session) => set({ session, loading: null }),
  setLoading: (loading) => set({ loading }),
}))
