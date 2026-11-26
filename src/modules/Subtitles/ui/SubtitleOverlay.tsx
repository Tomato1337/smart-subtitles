import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { animateExit, clearExit, IconButton } from '@tomato1337/m3e-react'
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

/** Clamps subtitle bottom inset so the overlay stays clear of both the control bar and TopBar. */
export function clampOverlayBottomPx(requestedBottom: number, baseBottom: number, stageHeight: number, topClear: number, lineHeight: number): number {
  if (!(stageHeight > 0)) return Math.max(baseBottom, requestedBottom)
  const ceiling = stageHeight - topClear - lineHeight
  const effectiveBase = Math.min(baseBottom, Math.max(BASE, ceiling))
  const maxBottom = Math.max(effectiveBase, ceiling)
  return Math.min(maxBottom, Math.max(effectiveBase, requestedBottom))
}

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
    <div className="type-display-small min-w-0 font-semibold whitespace-pre-line break-words [overflow-wrap:anywhere] text-[var(--app-on-video)]" style={{ textShadow: EN_SHADOW }}>
     {renderEn(cue, ann, live ? spoken : 1)}
    </div>
   )}
   {showRu && ann?.ru && (
    <div className="type-title-large mt-1 min-w-0 whitespace-pre-line break-words [overflow-wrap:anywhere] text-[var(--app-on-video)]" style={{ textShadow: RU_SHADOW }}>
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
 const drag = useRef<{ px: number; py: number; from: Pos; w: number; h: number; half: number; maxY: number } | null>(null)
 const box = useRef<HTMLDivElement>(null)
 const leavingRef = useRef<HTMLDivElement>(null)
 const playing = usePlaybackStore((s) => s.playing)
 // A boolean, so the clock re-renders the overlay only when the line appears or hides (hidden mode).
 const visible = usePlaybackStore((s) => focused !== null && subtitleVisibility(hideMode, reveal, s.absTime, focused, offset).visible)
 /** Phrase that just left the screen: fades out under the incoming one. */
 const [leaving, setLeaving] = useState<Cue | null>(null)
 const shown = useRef<Cue | null>(null)
 const [bounds, setBounds] = useState({ topClear: 96, bottomBase: BASE_LIFTED, stageH: 0, lineH: 0 })

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

 useLayoutEffect(() => {
  if (!leaving) return
  const el = leavingRef.current
  if (!el) { setLeaving(null); return }
  const ctl = new AbortController()
  void animateExit(el, ctl.signal).then(() => {
   if (!ctl.signal.aborted) setLeaving(null)
  })
  return () => {
   ctl.abort()
   clearExit(el)
  }
 }, [leaving])

 useLayoutEffect(() => {
  const wrap = box.current
  const stage = wrap?.offsetParent as HTMLElement | null
  if (!wrap || !stage) return
  const measure = () => {
   const stageRect = stage.getBoundingClientRect()
   const topbar = lifted ? stage.querySelector('[data-app-topbar]') : null
   const topClear = topbar ? Math.max(8, Math.ceil(topbar.getBoundingClientRect().bottom - stageRect.top) + 8) : 16
   const controls = lifted ? stage.querySelector('[data-app-player-controls]') : null
   const controlsH = controls ? Math.ceil(controls.getBoundingClientRect().height) : 0
   const bottomBase = lifted ? Math.max(BASE_LIFTED, controlsH + 24) : BASE
   const lineH = wrap.offsetHeight
   setBounds((b) =>
    b.topClear === topClear && b.bottomBase === bottomBase && b.stageH === stageRect.height && b.lineH === lineH
     ? b
     : { topClear, bottomBase, stageH: stageRect.height, lineH },
   )
  }
  measure()
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
  ro?.observe(stage)
  ro?.observe(wrap)
  const topbar = stage.querySelector('[data-app-topbar]')
  if (topbar) ro?.observe(topbar)
  const controls = stage.querySelector('[data-app-player-controls]')
  if (controls) ro?.observe(controls)
  return () => ro?.disconnect()
 }, [lifted, cue?.idx, showEn, showRu])

 const line = (c: Cue, live: boolean) => (
  <Line cue={c} ann={annotations.get(c.idx)} live={live} showEn={showEn} showRu={showRu} above={above} renderEn={renderEn} />
 )

 if (!cue && !leaving) return null

 const base = lifted ? bounds.bottomBase : BASE
 const pos = dragPos ?? position
 const requestedBottom = pos ? Math.max(pos.y * (bounds.stageH || 0), base) : base
 const bottomPx = clampOverlayBottomPx(requestedBottom, base, bounds.stageH, bounds.topClear, bounds.lineH)

 const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
  const wrap = box.current
  const lineEl = wrap?.firstElementChild
  const area = wrap?.offsetParent?.getBoundingClientRect()
  if (!wrap || !lineEl || !area || area.height <= 0) return
  const cs = getComputedStyle(wrap)
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const w = wrap.clientWidth - padX
  if (w <= 0) return
  e.currentTarget.setPointerCapture(e.pointerId)
  const half = Math.min(0.5, lineEl.getBoundingClientRect().width / 2 / w)
  const maxY = Math.max(0, Math.min(0.85, (area.height - bounds.topClear - wrap.offsetHeight) / area.height))
  drag.current = { px: e.clientX, py: e.clientY, from: pos ?? { x: 0.5, y: bottomPx / area.height }, w, h: area.height, half, maxY }
 }
 const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
  const d = drag.current
  if (!d || d.w <= 0 || d.h <= 0) return
  // The pointer moves the line by the same distance; the bounds keep the whole line on screen.
  setDragPos({ x: clamp(d.from.x + (e.clientX - d.px) / d.w, d.half, 1 - d.half), y: clamp(d.from.y - (e.clientY - d.py) / d.h, 0, d.maxY) })
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
   data-app-subtitles
   className={`group pointer-events-none absolute inset-x-0 flex justify-center px-4 sm:px-16 ${dragPos ? '' : 'transition-[bottom] duration-200 motion-reduce:transition-none'}`}
   style={{ bottom: pos || bounds.stageH > 0 ? bottomPx : base }}
  >
   <div
    className="relative min-w-0 max-w-[min(90%,1100px)] text-center"
    style={{ '--chunk-underline': '3px', left: pos ? `${(pos.x - 0.5) * 100}%` : undefined } as CSSProperties}
   >
    {cue && (
     <div data-tour="cue-actions" className={`mb-1 flex justify-center gap-1 transition-opacity duration-150 pointer-events-auto ${playing && !dragPos ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : 'opacity-100'}`}>
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
      ref={leavingRef}
      key={`out-${leaving.idx}`}
      aria-hidden
      className="sub-out absolute inset-x-0 bottom-0"
     >
      {line(leaving, false)}
     </div>
    )}
   </div>
  </div>
 )
})
