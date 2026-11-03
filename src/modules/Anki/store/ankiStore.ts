import { create } from 'zustand'
import type { AnkiCard, AnkiEntry, AnkiLabelMode } from '@/common/types/ipc'
import { buildIndex } from '../lib/matcher'

const KEY = 'smartsubs.ankiLabelMode'

function loadMode(): AnkiLabelMode {
  const v = localStorage.getItem(KEY)
  return v === 'unlearned' || v === 'off' ? v : 'fresh'
}

type AnkiStore = {
  cards: AnkiCard[]
  index: Map<string, AnkiEntry>
  labelMode: AnkiLabelMode
  setCards: (c: AnkiCard[]) => void
  setLabelMode: (m: AnkiLabelMode) => void
}

export const useAnkiStore = create<AnkiStore>((set) => ({
  cards: [],
  index: new Map(),
  labelMode: loadMode(),
  setCards: (cards) => set({ cards, index: buildIndex(cards) }),
  setLabelMode: (labelMode) => {
    localStorage.setItem(KEY, labelMode)
    set({ labelMode })
  },
}))

export const STATUS_RU: Record<AnkiCard['status'], string> = {
  new: 'новое', learning: 'изучается', young: 'молодое', learned: 'выучено', weak: 'трудное', leech: 'пиявка',
}

const VISIBLE: Record<AnkiLabelMode, ReadonlySet<AnkiCard['status']>> = {
  fresh: new Set(['new', 'learning']),
  unlearned: new Set(['new', 'learning', 'young', 'weak', 'leech']),
  off: new Set(),
}

export const isLabelVisible = (mode: AnkiLabelMode, status: AnkiCard['status']) => VISIBLE[mode].has(status)
