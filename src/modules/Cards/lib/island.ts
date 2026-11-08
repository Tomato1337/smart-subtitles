import { announce, type ToastAction, type ToastProgress } from '@tomato1337/m3e-react'
import { create } from 'zustand'

export type IslandOptions = {
  /** `null` or absent keeps the message until it is hidden. */
  durationMs?: number | null
  /** Every card action keeps the island up and locks its buttons until it settles (`dismiss: false`). */
  actions?: readonly ToastAction[]
  icon: string
  tone?: 'ok' | 'error'
  progress?: ToastProgress
  /** The step in progress of `total`; drawn as segments in the full form and `n/total` in the pill. */
  steps?: { current: number; total: number }
  /** Word and phase of the collapsed pill. */
  word: string
  mini: string
  /** Stays expanded by itself (grace window, outcome); otherwise it collapses after a few seconds. */
  pinned: boolean
  /** `true` while hover or focus holds the island open, `false` when both leave or it is hidden. */
  onInteractionChange?: (paused: boolean) => void
}

export type IslandState = { message: string | null; options: IslandOptions; seq: number }
export type IslandPatch = { message?: string; options?: Partial<IslandOptions> }

/** What the task presenter drives; tests wrap the same store. */
export type IslandSurface = {
  show: (message: string, options: IslandOptions) => number
  update: (id: number, patch: IslandPatch) => void
  hide: (id?: number) => void
  current: () => IslandState
  announce: (message: string) => void
}

/** Where the player docks the island: its top bar, and whether the bar is hidden right now. */
export type IslandDock = { bar: HTMLElement | null; concealed: boolean }

type IslandStore = IslandState & IslandDock

const EMPTY: IslandOptions = { icon: 'add_card', word: '', mini: '', pinned: false }

/** One card task at a time; a new task replaces the shown one, exactly like the kit's snackbar store. */
export const useIslandStore = create<IslandStore>(() => ({ message: null, options: EMPTY, seq: 0, bar: null, concealed: false }))

export const islandSurface: IslandSurface = {
  show(message, options) {
    const seq = useIslandStore.getState().seq + 1
    useIslandStore.setState({ message, options, seq })
    return seq
  },
  update(id, patch) {
    const s = useIslandStore.getState()
    if (s.message === null || s.seq !== id) return
    useIslandStore.setState({
      message: patch.message ?? s.message,
      options: patch.options ? { ...s.options, ...patch.options } : s.options,
    })
  },
  hide(id) {
    const s = useIslandStore.getState()
    if (s.message === null || (id !== undefined && id !== s.seq)) return
    useIslandStore.setState({ message: null })
  },
  current: () => {
    const { message, options, seq } = useIslandStore.getState()
    return { message, options, seq }
  },
  announce,
}
