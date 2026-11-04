import { create } from 'zustand'

/**
 * The word under the pointer in the overlay or the dialog list, shared so the list can light up
 * every occurrence of it. Kept out of `subsStore`: the sidebar reads that store whole and would
 * re-render on every hover.
 */
export const useHoverWord = create<{ word: string | null; setWord: (w: string | null) => void }>((set) => ({
 word: null,
 setWord: (word) => set({ word }),
}))

/** Comparison key of a word token: case and apostrophe style do not matter. */
export const wordKey = (text: string) => text.toLowerCase().replace(/[\u2018\u2019]/g, "'")
