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
export function ankiTokenDecor(label?: string): { style: CSSProperties; label?: ReactNode } {
  return {
    style: { borderBottom: '2px dashed var(--app-anki-label)' },
    label: label && (
      <span
        className="type-label-small pointer-events-none absolute bottom-full left-0 mb-0.5 whitespace-nowrap px-1.5 py-0.5 font-medium"
        style={{ background: 'var(--app-anki-label-container)', color: 'var(--app-anki-on-label-container)', borderRadius: 'var(--md-sys-shape-corner-extra-small)' }}
      >
        {label}
      </span>
    ),
  }
}

/** Per-cue Anki decoration for CueText: dashed underline over matched words and a label chip over the first one. */
export function useAnkiDecor(cue: Cue | null, tokens: Tok[] | null): { decorate: Decor; hasLabels: boolean } {
  const index = useAnkiStore((s) => s.index)
  const mode = useAnkiStore((s) => s.labelMode)
  return useMemo(() => {
    if (!cue || !tokens || mode === 'off' || index.size === 0) return { decorate: () => undefined, hasLabels: false }
    const wordIdx = tokens.flatMap((t, i) => (t.isWord ? [i] : []))
    const matches = matchWords(wordIdx.map((i) => tokens[i].text), index).filter((m) => isLabelVisible(mode, m.entry.status))
    const first = new Map<number, string>()
    const covered = new Set<number>()
    let hasLabels = false
    for (const m of matches) {
      for (let k = m.from; k <= m.to; k++) covered.add(wordIdx[k])
      const label = labelText(m.entry.translation)
      if (label) { first.set(wordIdx[m.from], label); hasLabels = true }
    }
    const decorate: Decor = (_t, i) => (covered.has(i) ? ankiTokenDecor(first.get(i)) : undefined)
    return { decorate, hasLabels }
  }, [cue, tokens, index, mode])
}
