import { create } from 'zustand'
import type { AnnotStatus, Cue, CueAnnotation, EmbeddedState, SubsStatus } from '@/common/types/ipc'

export type SubtitleSettings = {
 showEn: boolean
 showRu: boolean
 hideMode: boolean
 sidebarOpen: boolean
 showSidebarTranslation: boolean
 sidebarFont: 'S' | 'M' | 'L'
 patterns: boolean
 /**
  * Where the user dragged the subtitles, as fractions of the video area: `x` is the horizontal
  * centre, `y` the bottom edge measured from the bottom. null = the default spot above the controls.
  */
 position: { x: number; y: number } | null
}

const KEY = 'smartsubs.settings'
const DEFAULTS: SubtitleSettings = {
 showEn: true, showRu: true, hideMode: false, sidebarOpen: true, showSidebarTranslation: true, sidebarFont: 'M', patterns: true, position: null,
}

function load(): SubtitleSettings {
 try {
  return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SubtitleSettings>) }
 } catch {
  return DEFAULTS
 }
}

type SubsStore = SubtitleSettings & {
 mediaId: string | null
 cues: Cue[]
 annotations: Map<number, CueAnnotation>
 status: SubsStatus | null
 offset: number
 /** Hidden-mode reveal window: show subtitles until absolute time `until`; `t0` is where `A` was pressed. */
 reveal: { t0: number; until: number } | null
 failedBatches: Set<number>
 /** Background analysis of the current film; null until the backend has answered. */
 annot: AnnotStatus | null
 /** Embedded (in-file) subtitle load of the current film; null when there is none. */
 embedded: EmbeddedState | null
 set: (p: Partial<SubtitleSettings>) => void
 reset: (mediaId: string, offset: number) => void
 setCues: (cues: Cue[], annotations: CueAnnotation[]) => void
 applyAnnotations: (a: CueAnnotation[]) => void
 setStatus: (s: SubsStatus | null) => void
 setOffset: (o: number) => void
 setReveal: (r: { t0: number; until: number } | null) => void
 markFailed: (firstIdx: number) => void
 setAnnot: (a: AnnotStatus) => void
 setEmbedded: (e: EmbeddedState | null) => void
}

/** What the analysis UI needs from the store: cues, their annotations and the written-off batches. */
export type SubsSnapshot = Pick<SubsStore, 'cues' | 'offset' | 'annotations' | 'failedBatches'>

export const useSubsStore = create<SubsStore>((set, get) => ({
 ...load(),
 mediaId: null,
 cues: [],
 annotations: new Map(),
 status: null,
 offset: 0,
 reveal: null,
 failedBatches: new Set(),
 annot: null,
 embedded: null,
 set: (p) => {
  set(p)
  const s = get()
  const persisted: SubtitleSettings = {
   showEn: s.showEn, showRu: s.showRu, hideMode: s.hideMode, sidebarOpen: s.sidebarOpen,
   showSidebarTranslation: s.showSidebarTranslation, sidebarFont: s.sidebarFont, patterns: s.patterns, position: s.position,
  }
  localStorage.setItem(KEY, JSON.stringify(persisted))
 },
 reset: (mediaId, offset) => set({ mediaId, offset, cues: [], annotations: new Map(), status: null, reveal: null, failedBatches: new Set(), annot: null, embedded: null }),
 setCues: (cues, annotations) => set({ cues, annotations: new Map(annotations.map((a) => [a.idx, a])) }),
 applyAnnotations: (a) =>
  set((s) => {
   const m = new Map(s.annotations)
   for (const x of a) m.set(x.idx, x)
   return { annotations: m }
  }),
 setStatus: (status) => set({ status }),
 setOffset: (offset) => set({ offset }),
 setReveal: (reveal) => set({ reveal }),
 markFailed: (firstIdx) => set((s) => ({ failedBatches: new Set(s.failedBatches).add(firstIdx) })),
 setAnnot: (annot) => set({ annot }),
 setEmbedded: (embedded) => set({ embedded }),
}))
