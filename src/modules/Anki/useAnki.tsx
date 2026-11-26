import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import { api, onEvent } from '@/common/api/tauri'
import type { Cue } from '@/common/types/ipc'
import { matchWords } from './lib/matcher'
import { isLabelVisible, useAnkiStore } from './store/ankiStore'

/** Keeps the store in sync with the backend's `anki:index` event. */
export function useAnkiEvents() {
  useEffect(() => {
    const un = onEvent('anki:index', (cards) => useAnkiStore.getState().setCards(cards))
    // The backend's refresh on session open fires before this listener exists: ask again once subscribed.
    void un.then(() => api.ankiRefresh())
    return () => { void un.then((f) => f()) }
  }, [])
}

type Tok = { text: string; isWord: boolean }

/** Label text: translation cut at the first `,`/`;`/`(` and at 24 characters. */
export function labelText(translation: string): string {
  const t = translation.split(/[,;(]/)[0].trim()
  return t.length > 24 ? `${t.slice(0, 23)}…` : t
}

type Decor = (token: Tok, index: number) => { style?: CSSProperties; label?: ReactNode } | undefined

/** Look of a word matched to an Anki card: dashed underline; `label` adds the translation chip above it. */
export function ankiTokenDecor(label?: string, tier = 0): { style: CSSProperties; label?: ReactNode } {
  const bottom = tier > 0 ? `calc(100% + ${2 + tier * 22}px)` : '100%'
  return {
    style: { borderBottom: '2px dashed var(--app-anki-label)' },
    label: label && (
      <span
        className="type-label-small pointer-events-none absolute left-0 mb-0.5 max-w-[180px] truncate whitespace-nowrap px-1.5 py-0.5 font-medium"
        style={{
          bottom,
          background: 'var(--app-anki-label-container)',
          color: 'var(--app-anki-on-label-container)',
          borderRadius: 'var(--md-sys-shape-corner-extra-small)',
        }}
      >
        {label}
      </span>
    ),
  }
}

export type PlacedAnkiLabel = { tokenIndex: number; label: string; tier: number }

/** Staggers adjacent Anki translation chips into vertical tiers so neighboring labels never collide horizontally. */
export function assignAnkiLabelTiers(
  entries: ReadonlyArray<{ tokenIndex: number; charStart: number; label: string }>,
): { placed: Map<number, PlacedAnkiLabel>; rows: number } {
  const placed = new Map<number, PlacedAnkiLabel>()
  const tierEnds: number[] = []
  const ordered = [...entries].sort((a, b) => a.charStart - b.charStart || a.tokenIndex - b.tokenIndex)
  for (const e of ordered) {
    const widthChars = Math.max(6, Math.min(20, Math.ceil(e.label.length * 0.72) + 2))
    let tier = 0
    while (tier < tierEnds.length && tierEnds[tier] > e.charStart) tier++
    tierEnds[tier] = e.charStart + widthChars
    placed.set(e.tokenIndex, { tokenIndex: e.tokenIndex, label: e.label, tier })
  }
  return { placed, rows: tierEnds.length }
}

/** Per-cue Anki decoration for CueText: dashed underline over matched words and a label chip over the first one. */
export function useAnkiDecor(
  cue: Cue | null,
  tokens: Array<Tok & { start?: number }> | null,
): { decorate: Decor; hasLabels: boolean; labelRows: number } {
  const index = useAnkiStore((s) => s.index)
  const mode = useAnkiStore((s) => s.labelMode)
  return useMemo(() => {
    if (!cue || !tokens || mode === 'off' || index.size === 0) return { decorate: () => undefined, hasLabels: false, labelRows: 0 }
    const wordIdx = tokens.flatMap((t, i) => (t.isWord ? [i] : []))
    const matches = matchWords(wordIdx.map((i) => tokens[i].text), index).filter((m) => isLabelVisible(mode, m.entry.status))
    const covered = new Set<number>()
    const entries: { tokenIndex: number; charStart: number; label: string }[] = []
    let fallbackChar = 0
    for (const m of matches) {
      for (let k = m.from; k <= m.to; k++) covered.add(wordIdx[k])
      const label = labelText(m.entry.translation)
      const tokIdx = wordIdx[m.from]
      if (label && tokIdx !== undefined) {
        const charStart = tokens[tokIdx]?.start ?? (fallbackChar += 10)
        entries.push({ tokenIndex: tokIdx, charStart, label })
      }
    }
    const { placed, rows } = assignAnkiLabelTiers(entries)
    const hasLabels = placed.size > 0
    const decorate: Decor = (_t, i) => {
      if (!covered.has(i)) return undefined
      const info = placed.get(i)
      return ankiTokenDecor(info?.label, info?.tier)
    }
    return { decorate, hasLabels, labelRows: rows }
  }, [cue, tokens, index, mode])
}
