import { create } from 'zustand'

export type Anchor = { left: number; top: number; right: number; bottom: number }
export type ExplainTarget = { cueIdx: number; span: string; anchor: Anchor; pinned: boolean }

type Pick = { cueIdx: number; span: string; anchor: DOMRect }

type ExplainStore = {
  target: ExplainTarget | null
  /** Hover opens after a short delay and closes shortly after the pointer leaves both word and popover. */
  hoverOpen: (p: Pick) => void
  hoverLeave: () => void
  popoverEnter: () => void
  popoverLeave: () => void
  pinOpen: (p: Pick) => void
  close: () => void
}

const OPEN_DELAY = 350
const CLOSE_DELAY = 250
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined

const anchorOf = (r: DOMRect): Anchor => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

export const useExplainStore = create<ExplainStore>((set, get) => {
  const scheduleClose = () => {
    clearTimeout(closeTimer)
    closeTimer = setTimeout(() => { if (!get().target?.pinned) set({ target: null }) }, CLOSE_DELAY)
  }
  return {
    target: null,
    hoverOpen: (p) => {
      clearTimeout(closeTimer)
      clearTimeout(openTimer)
      if (get().target?.pinned) return
      openTimer = setTimeout(() => set({ target: { cueIdx: p.cueIdx, span: p.span, anchor: anchorOf(p.anchor), pinned: false } }), OPEN_DELAY)
    },
    hoverLeave: () => { clearTimeout(openTimer); scheduleClose() },
    popoverEnter: () => clearTimeout(closeTimer),
    popoverLeave: scheduleClose,
    pinOpen: (p) => {
      clearTimeout(openTimer)
      clearTimeout(closeTimer)
      set({ target: { cueIdx: p.cueIdx, span: p.span, anchor: anchorOf(p.anchor), pinned: true } })
    },
    close: () => { clearTimeout(openTimer); clearTimeout(closeTimer); set({ target: null }) },
  }
})
