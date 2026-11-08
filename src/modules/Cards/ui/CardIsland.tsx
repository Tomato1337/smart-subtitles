import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { announce, Button, clearExit, closeTopLayer, Icon, Spinner, useLatest, WavyProgress, type ToastAction } from '@tomato1337/m3e-react'
import { islandSurface, useIslandStore, type IslandOptions } from '../lib/island'

/** A task in work collapses this long after it was shown or stopped being pinned. */
const COLLAPSE_MS = 3000
/** After the pointer or focus leaves, so a brush past the pill does not flicker it. */
const LEAVE_MS = 700
const MINI_HEIGHT = 40
const GAP = 12
const EDGE = 16

type Shown = { message: string; options: IslandOptions; seq: number }
type Place = { x: number; mini: number; full: number }
type Box = { w: number; h: number }

/** Auto-dismissal that can be paused and resumed with its remaining time kept. */
type Countdown = { run(): void; pause(): void }

function countdown(ms: number, done: () => void): Countdown {
 let remaining = ms
 let since = 0
 let timer: ReturnType<typeof setTimeout> | undefined
 return {
  run() {
   if (timer !== undefined) return
   since = performance.now()
   timer = setTimeout(done, remaining)
  },
  pause() {
   if (timer === undefined) return
   clearTimeout(timer)
   timer = undefined
   remaining = Math.max(0, remaining - (performance.now() - since))
  },
 }
}

/** A failed action goes to the global error handler instead of tearing down the island. */
async function settle(action: ToastAction): Promise<void> {
 try {
  await action.run()
 } catch (error) {
  reportError(error)
 }
}

/** The player's top bar: the pill sits on its button row, the full card right under it. */
function usePlace(dock: HTMLElement | null): Place | null {
 const [place, setPlace] = useState<Place | null>(null)
 useLayoutEffect(() => {
  if (!dock) {
   setPlace(null)
   return
  }
  let frame = 0
  const measure = () => {
   frame = 0
   const box = dock.getBoundingClientRect()
   // The bar's right cluster is exactly one button row high, whatever the title block below it does.
   const row = (dock.querySelector('[data-app-topbar]')?.lastElementChild ?? dock).getBoundingClientRect()
   const next = { x: Math.round(box.left + box.width / 2), mini: Math.round(row.top + (row.height - MINI_HEIGHT) / 2), full: Math.round(row.bottom + GAP) }
   setPlace((p) => (p && p.x === next.x && p.mini === next.mini && p.full === next.full ? p : next))
  }
  const schedule = () => {
   if (!frame) frame = requestAnimationFrame(measure)
  }
  // The side panels resize the video column and with it the bar.
  const observer = new ResizeObserver(schedule)
  observer.observe(dock)
  window.addEventListener('resize', schedule)
  measure()
  return () => {
   if (frame) cancelAnimationFrame(frame)
   observer.disconnect()
   window.removeEventListener('resize', schedule)
  }
 }, [dock])
 return place
}

/** Both forms are laid out all the time; the surface animates its size to the shown one. */
function useBox(ref: RefObject<HTMLElement | null>, live: boolean): Box {
 const [box, setBox] = useState<Box>({ w: 0, h: 0 })
 useLayoutEffect(() => {
  const el = ref.current
  if (!el) return
  const measure = () => setBox((b) => (b.w === el.offsetWidth && b.h === el.offsetHeight ? b : { w: el.offsetWidth, h: el.offsetHeight }))
  const observer = new ResizeObserver(measure)
  observer.observe(el)
  measure()
  return () => observer.disconnect()
 }, [ref, live])
 return box
}

/**
 * Status of the current card task as a dynamic island. A new task shows the full card; a task in
 * work collapses into a pill after a few seconds, and the pill shows and hides with the player's
 * controls. Hover or focus expands it and keeps it expanded. The grace window and the outcome stay
 * expanded on their own. The island is a manual popover like the kit's snackbar, so it sits above
 * the player's panels; the snackbar stays free for other messages.
 */
export function CardIsland() {
 const message = useIslandStore((s) => s.message)
 const options = useIslandStore((s) => s.options)
 const seq = useIslandStore((s) => s.seq)
 const dock = useIslandStore((s) => s.bar)
 const concealed = useIslandStore((s) => s.concealed)
 const [shown, setShown] = useState<Shown | null>(null)
 const [hover, setHover] = useState(false)
 const [focus, setFocus] = useState(false)
 /** The task whose action is still running; its buttons stay locked. */
 const [pending, setPending] = useState<number | null>(null)
 const [open, setOpen] = useState(true)
 const [openedSeq, setOpenedSeq] = useState(0)
 /**
  * Expanded from the pill by hover or focus: the card then grows down from the pill instead of
  * jumping below the bar, which would pull it out from under the pointer and collapse it again.
  */
 const [fromPill, setFromPill] = useState(false)
 const el = useRef<HTMLDivElement>(null)
 const fullRef = useRef<HTMLDivElement>(null)
 const miniRef = useRef<HTMLDivElement>(null)

 const visible = message !== null
 if (visible && (shown?.seq !== seq || shown.message !== message || shown.options !== options)) {
  setShown({ message, options, seq })
 }
 // A hidden popover gets no pointerleave/blur; the next task must not start held.
 if (!visible && (hover || focus)) {
  setHover(false)
  setFocus(false)
 }
 // Every new task enters expanded.
 if (visible && openedSeq !== seq) {
  setOpenedSeq(seq)
  setOpen(true)
  setFromPill(false)
 }
 const interacting = visible && (hover || focus)
 const busy = pending !== null && pending === shown?.seq
 const o = shown?.options
 const hold = !!o?.pinned || interacting || busy
 const expanded = hold || open
 const durationMs = options.durationMs ?? null
 // Back to the bar's edge once the user is done: with the collapse, or at once for a pinned outcome.
 if (fromPill && !interacting && !busy && (o?.pinned || !open)) setFromPill(false)
 const place = usePlace(dock)
 const full = useBox(fullRef, !!shown)
 const mini = useBox(miniRef, !!shown)

 const latest = useLatest({ message, options, paused: interacting || busy })
 const progress = useLatest(o?.progress)
 // Stable, so WavyProgress keeps one frame loop across updates and reads the newest progress.
 const clock = useCallback(() => {
  const p = progress.current
  return p?.clock ? p.clock() : (p?.value ?? 0)
 }, [progress])

 // Show or raise once per task, never for an update of the same task.
 useLayoutEffect(() => {
  const p = el.current
  if (!p || !visible) return
  clearExit(p)
  // Re-showing moves it to the top of the top layer (above a dialog opened meanwhile).
  if (p.matches(':popover-open')) p.hidePopover()
  p.showPopover()
  const { message: text, options: opts } = latest.current
  announce(opts.actions ? `${text}. ${opts.actions.map((a) => a.label).join(', ')}` : (text ?? ''))
 }, [visible, seq, latest])

 // Collapse: a few seconds after the task is shown or unpinned, shortly after hover or focus leaves.
 const leftByUser = useRef(false)
 useLayoutEffect(() => {
  leftByUser.current = false
 }, [seq])
 useEffect(() => {
  if (!visible) return
  if (hold) {
   leftByUser.current = interacting
   setOpen(true)
   return
  }
  const timer = setTimeout(() => setOpen(false), leftByUser.current ? LEAVE_MS : COLLAPSE_MS)
  return () => clearTimeout(timer)
 }, [visible, seq, hold, interacting])

 // Dismissal: restarts for a new task or a changed duration, keeps its remainder otherwise.
 const timer = useRef<Countdown | null>(null)
 useEffect(() => {
  if (!visible || durationMs === null) return
  const c = countdown(durationMs, () => islandSurface.hide(seq))
  timer.current = c
  if (!latest.current.paused) c.run()
  return () => {
   c.pause()
   timer.current = null
  }
 }, [visible, seq, durationMs, latest])

 useEffect(() => {
  if (interacting || busy) timer.current?.pause()
  else timer.current?.run()
 }, [interacting, busy])

 // An update can remove the focused action; the browser then moves focus without a blur event.
 useLayoutEffect(() => {
  if (focus && !el.current?.contains(document.activeElement)) setFocus(false)
 }, [focus, shown])

 // One hold per task; released when interaction ends, on replacement, on hide and on unmount.
 useEffect(() => {
  if (!interacting) return
  const onChange = latest.current.options.onInteractionChange
  onChange?.(true)
  return () => onChange?.(false)
 }, [interacting, seq, latest])

 // Hide with the exit motion, then drop the content.
 useEffect(() => {
  const p = el.current
  if (visible || !shown || !p) return
  if (!p.matches(':popover-open')) {
   setShown(null)
   return
  }
  const ctl = new AbortController()
  void closeTopLayer(p, () => p.hidePopover(), ctl.signal).then((completed) => {
   if (completed) setShown(null)
  })
  return () => ctl.abort()
 }, [visible, shown])

 const runAction = (action: ToastAction) => {
  const now = islandSurface.current()
  // A click on an exiting or replaced task, or while an action runs, does nothing.
  if (now.message === null || now.seq !== shown?.seq || busy) return
  const id = now.seq
  setPending(id)
  void settle(action).then(() => setPending((p) => (p === id ? null : p)))
 }

 const box = expanded ? full : mini
 const style = {
  '--card-island-x': place ? `${place.x}px` : '50%',
  '--card-island-top': `${place ? (expanded && !fromPill ? place.full : place.mini) : EDGE}px`,
  ...(box.w > 0 && { width: `${box.w}px`, height: `${box.h}px` }),
 } as CSSProperties
 return (
  <div
   ref={el}
   popover="manual"
   className="card-island m3e-snackbar-surface"
   data-mini={expanded ? undefined : ''}
   data-concealed={!expanded && concealed ? '' : undefined}
   data-tone={o?.tone}
   style={style}
   onPointerEnter={() => {
    if (!expanded) setFromPill(true)
    setHover(true)
   }}
   onPointerLeave={() => setHover(false)}
   onFocus={() => {
    if (!expanded) setFromPill(true)
    setFocus(true)
   }}
   onBlur={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false)
   }}
  >
   {shown && o && (
    <>
     {/* The full card stays in the accessibility tree while collapsed: it is the real content, and
              tabbing to one of its actions expands the island. */}
     <div ref={fullRef} data-part="full" data-off={expanded ? undefined : ''}>
      <span data-part="icon">
       <Icon name={o.icon} size={24} />
      </span>
      <div data-part="body">
       <span key={shown.seq} data-part="message" title={shown.message}>{shown.message}</span>
       {o.progress && (
        <span
         data-part="progress"
         role="progressbar"
         aria-label={o.progress.label}
         aria-valuemin={0}
         aria-valuemax={100}
         aria-valuenow={Math.round(Math.min(1, Math.max(0, o.progress.value)) * 100)}
         className={interacting || busy ? 'm3e-wavy-idle' : undefined}
        >
         <WavyProgress value={o.progress.value} clock={clock} animated amp={2} len={20} stroke={4} />
        </span>
       )}
       {o.steps && (
        <span data-part="steps" aria-hidden="true">
         {Array.from({ length: o.steps.total }, (_, i) => (
          <i key={i} data-done={o.steps && i < o.steps.current ? '' : undefined} />
         ))}
        </span>
       )}
      </div>
      {o.actions && (
       <div data-part="actions">
        {o.actions.map((a) => (
         <Button
          key={a.label}
          size="sm"
          variant={a.variant ?? 'text'}
          aria-disabled={busy || undefined}
          onClick={() => runAction(a)}
         >
          {a.label}
         </Button>
        ))}
       </div>
      )}
     </div>
     <div ref={miniRef} data-part="mini" aria-hidden="true" data-off={expanded ? '' : undefined}>
      {o.tone ? <Icon name={o.icon} size={20} /> : <Spinner size={20} width={3} />}
      <b>«{o.word}»</b>
      <span>{o.steps ? `${o.mini} · ${o.steps.current}/${o.steps.total}` : o.mini}</span>
     </div>
    </>
   )}
  </div>
 )
}

/**
 * The player docks the island on its top bar; the collapsed pill then shows and hides with the
 * controls. Without a dock (other screens) the pill stays visible at the top edge.
 */
export function useCardIslandDock(bar: RefObject<HTMLElement | null>, controlsVisible: boolean) {
 useLayoutEffect(() => {
  useIslandStore.setState({ bar: bar.current })
  return () => useIslandStore.setState({ bar: null, concealed: false })
 }, [bar])
 useEffect(() => {
  useIslandStore.setState({ concealed: !controlsVisible })
 }, [controlsVisible])
}
