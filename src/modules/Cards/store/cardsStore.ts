import { create } from 'zustand'

type CardsStore = {
  draft: { cueIdx: number; span: string | null } | null
  openDraft: (cueIdx: number, span?: string | null) => void
  closeDraft: () => void
}

export const useCardsStore = create<CardsStore>((set) => ({
  draft: null,
  openDraft: (cueIdx, span = null) => set({ draft: { cueIdx, span } }),
  closeDraft: () => set({ draft: null }),
}))
