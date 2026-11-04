import { create } from 'zustand'
import { DEFAULT_BINDINGS, type Bindings, type HotkeyAction } from '../lib/actions'
import { overridesOf, parseOverrides, rebind } from '../lib/bindings'

const KEY = 'smartsubs.hotkeys'

type HotkeysStore = {
  bindings: Bindings
  /** Returns the action that lost this combo, if any. */
  bind: (action: HotkeyAction, combo: string) => HotkeyAction | null
  unbind: (action: HotkeyAction) => void
  reset: () => void
}

/** Only the overrides are saved, so a new action still starts with its own default key. */
function save(bindings: Bindings): void {
  localStorage.setItem(KEY, JSON.stringify(overridesOf(bindings)))
}

export const useHotkeysStore = create<HotkeysStore>((set, get) => ({
  bindings: parseOverrides(localStorage.getItem(KEY)),
  bind: (action, combo) => {
    const { bindings, stolen } = rebind(get().bindings, action, combo)
    save(bindings)
    set({ bindings })
    return stolen
  },
  unbind: (action) => {
    const bindings: Bindings = { ...get().bindings, [action]: null }
    save(bindings)
    set({ bindings })
  },
  reset: () => {
    const bindings: Bindings = { ...DEFAULT_BINDINGS }
    save(bindings)
    set({ bindings })
  },
}))
