import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { placeCard, resolveStep, visibleSteps, type Rect, type TourStep } from '../lib/tour'

/** Ring of the spotlight around the target, px. */
const SPOT_PAD = 6
/** Repaint period of the spotlight: the bars and the subtitle line it points at move and fade in 200 ms. */
const TICK_MS = 250
const SCRIM = 'color-mix(in srgb, var(--md-sys-color-scrim) 60%, transparent)'
const BUTTON = 'state-layer type-label-large relative rounded-full px-4 py-2'
const TEXT_BUTTON = `${BUTTON} state-on-surface whitespace-nowrap text-[var(--md-sys-color-primary)] disabled:cursor-default disabled:opacity-40`
const TONAL_BUTTON = `${BUTTON} state-on-surface flex w-full items-center justify-center bg-[var(--md-sys-color-secondary-container)] text-center text-[var(--md-sys-color-on-secondary-container)]`
const FILLED_BUTTON = `${BUTTON} state-on-primary whitespace-nowrap bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]`

/** Box of the element marked `data-tour="<id>"`; `null` while it is absent or has no size (a hidden panel). */
function boxOf(id: string | null): Rect | null {
 if (id === null) return null
 const el = document.querySelector(`[data-tour="${id}"]`)
 if (!el) return null
 const r = el.getBoundingClientRect()
 return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
}

/** Which of a step's targets are on screen: the tour skips or centers the steps whose elements are gone. */
const present = (id: string) => boxOf(id) !== null

/**
 * Guided tour over the player: everything is dimmed except a cut-out around the element of the current
 * step, and a card explains it. The tour only shows — every click and key of the player is blocked.
 */
export function TourOverlay({ steps, onClose }: { steps: readonly TourStep[]; onClose: () => void }) {
 const [index, setIndex] = useState(() => resolveStep(steps, 0, 1, present)?.index ?? 0)
 const [box, setBox] = useState<Rect | null>(null)
 /** Card corner, measured after each step render; the first frame stays hidden until it is known. */
 const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
 /** Bumped on window resize: the spotlight and the card both have to be measured again. */
 const [view, setView] = useState(0)
 const card = useRef<HTMLDivElement>(null)
 const next = useRef<HTMLButtonElement>(null)
 const step = steps[index]
 const action = step.action

 // The step on screen may lose its element (the subtitles went away, a panel closed): move on to the
 // next showable step instead of pointing at nothing. The same pass keeps the cut-out glued to bars
 // that slide or fade.
 useLayoutEffect(() => {
  const move = () => {
   const at = resolveStep(steps, index, 1, present)
   if (!at) {
    setBox(null)
    return
   }
   if (at.index !== index) {
    setIndex(at.index)
    return
   }
   const to = boxOf(at.target)
   setBox((prev) => {
    const same = prev !== null && to !== null && prev.left === to.left && prev.top === to.top && prev.width === to.width && prev.height === to.height
    return same ? prev : to
   })
  }
  move()
  const t = setInterval(move, TICK_MS)
  return () => clearInterval(t)
 }, [steps, index, view])

 useLayoutEffect(() => {
  const onResize = () => setView((v) => v + 1)
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
 }, [])

 useLayoutEffect(() => {
  const el = card.current
  if (!el) return
  const size = el.getBoundingClientRect()
  const to = placeCard(box, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight })
  setPos((prev) => (prev !== null && prev.left === to.left && prev.top === to.top ? prev : to))
 }, [box, index, view])

 useEffect(() => {
  next.current?.focus()
 }, [index])

 const go = useCallback((dir: 1 | -1) => {
  const at = resolveStep(steps, index + dir, dir, present)
  if (at) setIndex(at.index)
  // Nothing after this step: it was the last one, and the tour is done.
  else if (dir === 1) onClose()
 }, [steps, index, onClose])

 // Capture on window: the player's hotkeys (bubble on window) and the Escape handlers of the menus
 // below (capture on document) never see a key while the tour is up.
 useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
   e.stopImmediatePropagation()
   if (e.key === 'ArrowRight') {
    e.preventDefault()
    go(1)
    return
   }
   if (e.key === 'ArrowLeft') {
    e.preventDefault()
    go(-1)
    return
   }
   if (e.key === 'Escape') {
    e.preventDefault()
    onClose()
    return
   }
   // Enter and Space press the focused button, Tab moves the focus on.
   if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') return
   e.preventDefault()
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
 }, [go, onClose])

 const visible = visibleSteps(steps, present)
 const last = resolveStep(steps, index + 1, 1, present) === null

 return (
  <div className="fixed inset-0 z-[195]">
   {box ? (
    <div
     aria-hidden
     className="pointer-events-none absolute transition-all duration-200"
     style={{
      left: box.left - SPOT_PAD,
      top: box.top - SPOT_PAD,
      width: box.width + SPOT_PAD * 2,
      height: box.height + SPOT_PAD * 2,
      borderRadius: 12,
      boxShadow: `0 0 0 9999px ${SCRIM}`,
      outline: '2px solid var(--md-sys-color-primary)',
     }}
    />
   ) : (
    <div className="absolute inset-0" style={{ background: SCRIM }} />
   )}
   <div
    ref={card}
    role="dialog"
    aria-label="Обзор возможностей"
    className="md-pop absolute w-[380px] max-w-[calc(100vw-16px)] bg-[var(--md-sys-color-surface-container-high)] p-5 shadow-xl"
    style={{
     borderRadius: 'var(--md-sys-shape-corner-extra-large)',
     left: pos?.left ?? 0,
     top: pos?.top ?? 0,
     visibility: pos === null ? 'hidden' : 'visible',
    }}
   >
    <div className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">
     {Math.max(1, visible.indexOf(index) + 1)} / {visible.length}
    </div>
    <h2 className="type-title-large mt-1">{step.title}</h2>
    {step.body.map((text) => <p key={text} className="type-body-medium mt-2">{text}</p>)}
    {action && (
     <button type="button" onClick={() => { onClose(); action.run() }} className={`mt-4 ${TONAL_BUTTON}`}>{action.label}</button>
    )}
    <div className="mt-4 flex flex-wrap items-center gap-2">
     {last ? null : <button type="button" onClick={onClose} className={TEXT_BUTTON}>Пропустить</button>}
     <div className="ml-auto flex items-center gap-2">
      <button type="button" disabled={visible[0] === index} onClick={() => go(-1)} className={TEXT_BUTTON}>Назад</button>
      <button ref={next} type="button" onClick={() => go(1)} className={FILLED_BUTTON}>{last ? 'Готово' : 'Далее'}</button>
     </div>
    </div>
   </div>
  </div>
 )
}
