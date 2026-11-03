import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { usePlaybackStore } from '@/modules/Player'
import { subtitleVisibility } from '../lib/reveal'
import { useSubsStore } from '../store/subsStore'
import { useFocusedCue } from '../useActiveCue'
import { IconButton } from '@/common/ui/IconButton'
import type { Cue, CueAnnotation } from '@/common/types/ipc'

type Props = {
  onReplay: (cue: Cue) => void
  onCard: (cue: Cue) => void
  onExplain: (cue: Cue) => void
  /** Rendered above the text line (grammar badges). */
  above?: (cue: Cue) => ReactNode
  /** Renders the English line (clickable tokens); `karaoke` is the spoken part of the cue (lit words). */
  renderEn: (cue: Cue, ann: CueAnnotation | undefined, karaoke: number | undefined) => ReactNode
  /** Lift above the control bar while it is visible. */
  lifted: boolean
}

const EN_SHADOW = '0 2px 6px var(--md-sys-color-scrim), 0 0 2px var(--md-sys-color-scrim)'
const RU_SHADOW = '0 1px 4px var(--md-sys-color-scrim)'

export function SubtitleOverlay({ onReplay, onCard, onExplain, above, renderEn, lifted }: Props) {
  const focused = useFocusedCue()
  const { showEn, showRu, hideMode, reveal, annotations, setReveal } = useSubsStore()
  const absTime = usePlaybackStore((s) => s.absTime)
  const playing = usePlaybackStore((s) => s.playing)
  /** Phrase that just left the screen: fades out under the incoming one. */
  const [leaving, setLeaving] = useState<Cue | null>(null)
  const shown = useRef<Cue | null>(null)

  useEffect(() => {
    if (reveal && absTime >= reveal.until) setReveal(null)
  }, [reveal, absTime, setReveal])

  const offset = useSubsStore.getState().offset
  const vis = focused ? subtitleVisibility(hideMode, reveal, absTime, focused, offset) : { visible: false }
  const cue = vis.visible ? focused : null

  useLayoutEffect(() => {
    const prev = shown.current
    shown.current = cue
    if (prev && prev.idx !== cue?.idx) setLeaving(prev)
  }, [cue])

  // Timer, not onAnimationEnd: with reduced motion the animation never runs.
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLeaving(null), 260)
    return () => clearTimeout(t)
  }, [leaving])

  const text = (c: Cue, karaoke: number | undefined, withBadges: boolean) => {
    const ann = annotations.get(c.idx)
    return (
      <>
        {withBadges && above?.(c)}
        {showEn && (
          <div className="type-display-small whitespace-pre-line text-[var(--md-sys-color-on-surface)]" style={{ textShadow: EN_SHADOW }}>
            {renderEn(c, ann, karaoke)}
          </div>
        )}
        {showRu && ann?.ru && (
          <div className="type-title-large mt-1 whitespace-pre-line text-[var(--md-sys-color-on-surface-variant)]" style={{ textShadow: RU_SHADOW }}>
            {ann.ru}
          </div>
        )}
      </>
    )
  }

  if (!cue && !leaving) return null

  return (
    <div
      className="group pointer-events-none absolute inset-x-0 flex justify-center px-16 transition-[bottom] duration-200"
      style={{ bottom: lifted ? 150 : 48 }}
    >
      <div className="relative max-w-[min(90%,1100px)] text-center">
        {cue && (
          <div className={`mb-1 flex justify-center gap-1 transition-opacity duration-150 pointer-events-auto ${playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
            <IconButton icon="replay" label="Повторить" onClick={() => onReplay(cue)} />
            <IconButton icon="add_card" label="Фразу в Anki" onClick={() => onCard(cue)} />
            <IconButton icon="auto_awesome" label="Объяснить фразу агентом" onClick={() => onExplain(cue)} />
          </div>
        )}
        {cue && <div key={cue.idx} className="sub-in pointer-events-auto">{text(cue, vis.karaoke, true)}</div>}
        {leaving && leaving.idx !== cue?.idx && (
          <div key={`out-${leaving.idx}`} aria-hidden className="sub-out absolute inset-x-0 bottom-0">
            {text(leaving, 1, false)}
          </div>
        )}
      </div>
    </div>
  )
}
