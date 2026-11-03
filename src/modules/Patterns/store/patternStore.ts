import { create } from 'zustand'

type PatternStore = { openId: string | null; open: (id: string) => void; close: () => void }

export const usePatternStore = create<PatternStore>((set) => ({
  openId: null,
  open: (openId) => set({ openId }),
  close: () => set({ openId: null }),
}))
