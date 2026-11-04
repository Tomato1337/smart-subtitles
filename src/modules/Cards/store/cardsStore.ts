import { create } from 'zustand'
import type { CardsPhase, CardsProgress, CardsResult } from '@/common/types/ipc'

export const CARD_PHASE_RU: Record<CardsPhase, string> = {
  queued: 'В очереди на добавление…',
  preparing: 'Проверяю Anki и готовлю карточку…',
  clip: 'Вырезаю клип из сцены…',
  image: 'Генерирую картинку…',
  audio: 'Готовлю озвучку…',
  anki: 'Добавляю карточку в Anki…',
  sync: 'Синхронизирую с AnkiWeb…',
}

type CardsStore = {
  draft: { cueIdx: number; span: string | null } | null
  /** Live phases of background adds by proposal id; the agent proposal reads them. */
  phases: Record<number, CardsPhase>
  openDraft: (cueIdx: number, span?: string | null) => void
  closeDraft: () => void
  progress: (p: CardsProgress) => void
  finish: (r: CardsResult) => void
}

export const useCardsStore = create<CardsStore>((set) => ({
  draft: null,
  phases: {},
  openDraft: (cueIdx, span = null) => set({ draft: { cueIdx, span } }),
  closeDraft: () => set({ draft: null }),
  progress: (p) =>
    set((s) => ({ phases: { ...s.phases, [p.proposalId]: p.phase } })),
  finish: (r) =>
    set((s) => {
      const phases = { ...s.phases }
      delete phases[r.proposalId]
      return { phases }
    }),
}))
