import { create } from 'zustand'

export type Live = { text: string; tool: string | null; busy: boolean; error: string | null }
const IDLE: Live = { text: '', tool: null, busy: false, error: null }

/** Film chat panel state; the history itself lives in the backend (one thread per film). */
type AgentStore = {
  open: boolean
  live: Live
  setOpen: (open: boolean) => void
  toggle: () => void
  begin: () => void
  delta: (text: string) => void
  tool: (name: string) => void
  finish: (error?: string) => void
  reset: () => void
}

export const useAgentStore = create<AgentStore>((set) => ({
  open: false,
  live: IDLE,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  begin: () => set({ live: { ...IDLE, busy: true } }),
  delta: (text) => set((s) => ({ live: { ...s.live, busy: true, text: s.live.text + text, tool: null } })),
  tool: (name) => set((s) => ({ live: { ...s.live, tool: name } })),
  finish: (error) => set({ live: { ...IDLE, error: error ?? null } }),
  reset: () => set({ open: false, live: IDLE }),
}))
