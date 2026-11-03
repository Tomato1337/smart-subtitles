import { useCallback, useMemo, type CSSProperties } from 'react'
import type { Cue, CueAnnotation } from '@/common/types/ipc'
import { useAnkiDecor } from '@/modules/Anki'
import { CueText, tokenize, useSpokenFraction, useSubsStore, type SpanPick } from '@/modules/Subtitles'

type Props = {
  cue: Cue
  ann: CueAnnotation | undefined
  karaoke?: number
  /** Follow playback: light up the words of this cue as they are spoken (sidebar's focused row). */
  live?: boolean
  onPick?: (p: SpanPick) => void
  onHover?: (p: SpanPick | null) => void
}

/** Double underline of a grammar pattern (drawn only on words outside chunks). */
export const PATTERN_UNDERLINE: CSSProperties = { textDecoration: 'underline double', textDecorationColor: 'var(--app-kind-grammar)', textUnderlineOffset: '4px' }

/** English cue text with chunk underlines, grammar double underlines and Anki labels. Used by overlay and sidebar. */
export function CueLine({ cue, ann, karaoke, live, onPick, onHover }: Props) {
  const spoken = useSpokenFraction(live ? cue : null)
  const tokens = useMemo(() => tokenize(cue.text), [cue.text])
  const { decorate: anki, hasLabels } = useAnkiDecor(cue, tokens)
  const showPatterns = useSubsStore((s) => s.patterns)

  const decorate = useCallback(
    (t: { start: number; end: number; text: string; isWord: boolean }, i: number) => {
      const a = anki(t, i)
      const inChunk = ann?.chunks.some((c) => t.start >= c.startChar && t.end <= c.endChar)
      const inPattern = showPatterns && !inChunk && ann?.patterns.some((p) => t.start >= p.startChar && t.end <= p.endChar)
      if (!inPattern) return a
      return { label: a?.label, style: { ...a?.style, ...PATTERN_UNDERLINE } }
    },
    [anki, ann, showPatterns],
  )

  return (
    <span className={hasLabels ? 'block pt-5' : undefined}>
      <CueText cue={cue} chunks={ann?.chunks ?? []} karaoke={karaoke ?? spoken} onPick={onPick} onHover={onHover} decorate={decorate} />
    </span>
  )
}
