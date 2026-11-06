import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { IconButton } from '@tomato1337/m3e-react'
import { usePlaybackStore } from '@/modules/Player'
import { subtitleVisibility } from '../lib/reveal'
import { useSubsStore } from '../store/subsStore'
import { useFocusedCue, useSpokenFraction } from '../useActiveCue'
import type { Cue, CueAnnotation } from '@/common/types/ipc'

type Props = {
  onReplay: (cue: Cue) => void
  onCard: (cue: Cue) => void
  onExplain: (cue: Cue) => void
  /** Rendered above the text line (grammar badges). Keep it stable (useCallback), like `renderEn`. */
  above?: (cue: Cue, ann: CueAnnotation | undefined) => ReactNode
  /** Renders the English line (clickable tokens); `karaoke` is the spoken part of the cue (lit words). */
  renderEn: (cue: Cue, ann: CueAnnotation | undefined, karaoke: number | undefined) => ReactNode
  /** Lift above the control bar while it is visible. */
  lifted: boolean
}

const EN_SHADOW = '0 2px 6px var(--md-sys-color-scrim), 0 0 2px var(--md-sys-color-scrim)'
const RU_SHADOW = '0 1px 4px var(--md-sys-color-scrim)'

/** Bottom of the default spot: above the control bar while it shows, near the edge otherwise. */
const BASE_LIFTED = 172
const BASE = 48

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
type Pos = { x: number; y: number }
/** Horizontal padding of the overlay wrapper (`px-16`). */
const PAD_X = 64

type LineProps = {
  cue: Cue
  ann: CueAnnotation | undefined
  /** The incoming line follows playback (karaoke); the leaving one stays fully lit. */
  live: boolean
  showEn: boolean
  showRu: boolean
  above: Props['above']
  renderEn: Props['renderEn']
}

/**
 * One subtitle line. Its own component: the karaoke clock re-renders only this line, once per
 * newly lit word, instead of the whole overlay at every 10 Hz tick of the playback time.
 */
const Line = memo(function Line({ cue, ann, live, showEn, showRu, above, renderEn }: LineProps) {
  const spoken = useSpokenFraction(live ? cue : null)
  return (
    <>
      {live && above?.(cue, ann)}
      {showEn && (
        <div className="type-display-small font-semibold whitespace-pre-line text-[var(--app-on-video)]" style={{ textShadow: EN_SHADOW }}>
          {renderEn(cue, ann, live ? spoken : 1)}
        </div>
      )}
      {showRu && ann?.ru && (
        <div className="type-title-large mt-1 whitespace-pre-line text-[var(--app-on-video)]" style={{ textShadow: RU_SHADOW }}>
          {ann.ru}
        </div>
      )}
    </>
  )
})

/** Memoized: re-renders come from its own subscriptions (focused phrase, settings), not from the player screen. */
export const SubtitleOverlay = memo(function SubtitleOverlay({ onReplay, onCard, onExplain, above, renderEn, lifted }: Props) {
  const focused = useFocusedCue()
  // Only what the overlay shows: the whole store also changes on analysis progress, status, embedded load…
  const { showEn, showRu, hideMode, reveal, annotations, setReveal, position, set, offset } = useSubsStore(useShallow((s) => ({
    showEn: s.showEn, showRu: s.showRu, hideMode: s.hideMode, reveal: s.reveal, annotations: s.annotations,
    setReveal: s.setReveal, position: s.position, set: s.set, offset: s.offset,
  })))
  /** Position while the handle is held; written to the (persisted) store once on release. */
  const [dragPos, setDragPos] = useState<Pos | null>(null)
  const drag = useRef<{ px: number; py: number; from: Pos; w: number; h: number; half: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const playing = usePlaybackStore((s) => s.playing)
  // A boolean, so the clock re-renders the overlay only when the line appears or hides (hidden mode).
  const visible = usePlaybackStore((s) => focused !== null && subtitleVisibility(hideMode, reveal, s.absTime, focused, offset).visible)
  /** Phrase that just left the screen: fades out under the incoming one. */
  const [leaving, setLeaving] = useState<Cue | null>(null)
  const shown = useRef<Cue | null>(null)

  // The reveal window closes by the clock without re-rendering the overlay at every tick.
  useEffect(() => {
    if (!reveal) return
    const check = (t: number) => { if (t >= reveal.until) setReveal(null) }
    check(usePlaybackStore.getState().absTime)
    return usePlaybackStore.subscribe((s) => check(s.absTime))
  }, [reveal, setReveal])

  const cue = visible ? focused : null

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

  const line = (c: Cue, live: boolean) => (
    <Line cue={c} ann={annotations.get(c.idx)} live={live} showEn={showEn} showRu={showRu} above={above} renderEn={renderEn} />
  )

  if (!cue && !leaving) return null

  const base = lifted ? BASE_LIFTED : BASE
  const pos = dragPos ?? position

  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const wrap = box.current
    const line = wrap?.firstElementChild
    const area = wrap?.offsetParent?.getBoundingClientRect()
    if (!wrap || !line || !area) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // `left` percentages resolve against the wrapper's content box (inside its px-16 padding).
    const w = wrap.clientWidth - 2 * PAD_X
    const half = Math.min(0.5, line.getBoundingClientRect().width / 2 / w)
    drag.current = { px: e.clientX, py: e.clientY, from: pos ?? { x: 0.5, y: base / area.height }, w, h: area.height, half }
  }
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    // The pointer moves the line by the same distance; the bounds keep the whole line on screen.
    setDragPos({ x: clamp(d.from.x + (e.clientX - d.px) / d.w, d.half, 1 - d.half), y: clamp(d.from.y - (e.clientY - d.py) / d.h, 0, 0.85) })
  }
  const endDrag = () => {
    if (!drag.current) return
    drag.current = null
    if (dragPos) set({ position: dragPos })
    setDragPos(null)
  }

  return (
    <div
      ref={box}
      className={`group pointer-events-none absolute inset-x-0 flex justify-center px-16 ${dragPos ? '' : 'transition-[bottom] duration-200 motion-reduce:transition-none'}`}
      // A moved line still steps up over the control bar when it was left below it.
      style={{ bottom: pos ? `max(${pos.y * 100}%, ${base}px)` : base }}
    >
      <div
        className="relative max-w-[min(90%,1100px)] text-center"
        style={{ '--chunk-underline': '3px', left: pos ? `${(pos.x - 0.5) * 100}%` : undefined } as CSSProperties}
      >
        {cue && (
          <div data-tour="cue-actions" className={`mb-1 flex justify-center gap-1 transition-opacity duration-150 pointer-events-auto ${playing && !dragPos ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
            <IconButton icon="replay" label="Повторить" className="icon-button-on-video" onClick={() => onReplay(cue)} />
            <IconButton icon="add_card" label="Фразу в Anki" className="icon-button-on-video" onClick={() => onCard(cue)} />
            <IconButton icon="auto_awesome" label="Объяснить фразу агентом" className="icon-button-on-video" fill onClick={() => onExplain(cue)} />
            <IconButton
              icon="open_with"
              label="Перетащить субтитры (двойной клик — на место)"
              className="icon-button-on-video cursor-move touch-none"
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => set({ position: null })}
            />
          </div>
        )}
        {cue && <div key={cue.idx} data-tour="subtitle" className="sub-in pointer-events-auto">{line(cue, true)}</div>}
        {leaving && leaving.idx !== cue?.idx && (
          <div
            key={`out-${leaving.idx}`}
            aria-hidden
            className="sub-out absolute inset-x-0 bottom-0"
            onAnimationEnd={(e) => { if (e.target === e.currentTarget) setLeaving(null) }}
          >
            {line(leaving, false)}
          </div>
        )}
      </div>
    </div>
  )
})
