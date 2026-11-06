import { useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animateExit, Icon, IconButton, Presence } from '@tomato1337/m3e-react'
import { useNotifications, type NotifyAction } from '@/common/api/notify'
import type { AppNotification, NotifyLevel } from '@/common/types/ipc'

/** Toasts on screen at once; older ones are already collapsing into the center. */
const MAX_TOASTS = 3
/** How often expired toasts are noticed. */
const TICK_MS = 250

/** The one visible trigger button: floating on the home screen, inside the top bar in the player. */
let buttonEl: HTMLButtonElement | null = null

const LEVEL: Record<NotifyLevel, { icon: string; stripe: string }> = {
 error: { icon: 'error', stripe: 'var(--md-sys-color-error)' },
 warn: { icon: 'warning', stripe: 'var(--app-warning)' },
}

function stamp(createdAt: number): string {
 return new Date(createdAt * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

type CardProps = {
 n: AppNotification
 action?: NotifyAction
 onClose: () => void
 closeIcon: string
 closeLabel: string
 /** A standalone popup needs its own surface and shadow; a row inside the panel does not. */
 floating?: boolean
}

/** One notification: identical markup for the popups and for the center rows. */
function Card({ n, action, onClose, closeIcon, closeLabel, floating = false }: CardProps) {
 const style = LEVEL[n.level]
 const surface = floating
  ? 'bg-[var(--md-sys-color-surface-container-high)] shadow-lg'
  : 'bg-[var(--md-sys-color-surface-container-highest)]'
 return (
  <div
   className={`relative flex items-start gap-2 py-2 pr-1 pl-5 ${surface}`}
   style={{ borderRadius: 'var(--md-sys-shape-corner-medium)' }}
  >
   {/* An inset pill rather than a border-left: it stays inside the rounded corners of the card. */}
   <span aria-hidden className="absolute top-2 bottom-2 left-1.5 w-1 rounded-full" style={{ background: style.stripe }} />
   <span className="shrink-0" style={{ color: style.stripe }}><Icon name={style.icon} /></span>
   <div className="min-w-0 grow">
    <div className="type-body-medium select-text whitespace-pre-wrap break-words">{n.message}</div>
    <div className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">{stamp(n.createdAt)}</div>
   </div>
   {action && (
    <button
     type="button"
     className="state-layer type-label-large relative shrink-0 rounded-full px-3 py-1.5 text-[var(--md-sys-color-primary)]"
     onClick={action.run}
    >
     {action.label}
    </button>
   )}
   <IconButton icon={closeIcon} label={closeLabel} tipPos="left" onClick={onClose} />
  </div>
 )
}

/** Colored bell with a count; red when an error is present, orange otherwise. Pops in and out. */
export function NotificationButton({ className = '' }: { className?: string }) {
 const any = useNotifications((s) => s.items.length > 0)
 return <Presence>{any && <Bell className={className} />}</Presence>
}

function Bell({ className }: { className: string }) {
 const items = useNotifications((s) => s.items)
 const open = useNotifications((s) => s.open)
 const setOpen = useNotifications((s) => s.setOpen)
 // While it pops out (the list has just emptied) it keeps the last count and colour.
 const [last, setLast] = useState(items)
 if (items.length > 0 && items !== last) setLast(items)
 const shown = items.length > 0 ? items : last
 const hasError = shown.some((i) => i.level === 'error')
 return (
  <button
   ref={(el) => { buttonEl = el }}
   type="button"
   aria-label="Уведомления"
   data-tour="notifications"
   onClick={() => setOpen(!open)}
   aria-expanded={open}
   className={`m3e-motion-pop state-layer flex shrink-0 items-center justify-center rounded-full shadow-lg ${className}`}
   style={{ background: hasError ? 'var(--md-sys-color-error)' : 'var(--app-warning)', color: 'var(--md-sys-color-surface)' }}
  >
   <Icon name="notifications" size={20} />
   <span
    className="type-label-small absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full px-1"
    style={{ background: 'var(--md-sys-color-surface-container-highest)', color: 'var(--md-sys-color-on-surface)' }}
   >
    {shown.length > 99 ? '99+' : shown.length}
   </span>
  </button>
 )
}

/**
 * Popups flying in as a stack, newest nearest the button: from the left edge on the home screen, from
 * under the top bar in the player. Each one, when its time is up (or on "Скрыть"), shrinks into the
 * notification center before leaving the list.
 */
function LiveToasts({ top }: { top: boolean }) {
 const live = useNotifications((s) => s.live)
 const items = useNotifications((s) => s.items)
 const actions = useNotifications((s) => s.actions)
 const open = useNotifications((s) => s.open)
 const pauseLive = useNotifications((s) => s.pauseLive)
 const resumeLive = useNotifications((s) => s.resumeLive)
 const boxRef = useRef<HTMLDivElement>(null)
 /** Popup wrappers by id, for their exit motion. */
 const cards = useRef(new Map<number, HTMLDivElement>())
 const hiding = useRef(new Set<number>())

 // A popup leaves through its exit animation (`data-closing` → `.toast-in*[data-closing]` in
 // main.css); the store drops it once that has finished, not after a duration copied from the CSS.
 const beginHide = useCallback((id: number, remove = false) => {
  if (hiding.current.has(id)) return
  hiding.current.add(id)
  const finish = () => {
   hiding.current.delete(id)
   const st = useNotifications.getState()
   if (remove) void st.remove(id)
   else st.hideLive(id)
  }
  const el = cards.current.get(id)
  if (el) void animateExit(el).then(finish)
  else finish()
 }, [])

 // A manual popover: the stack lives in the top layer, so it stays visible over a modal dialog;
 // re-shown when a popup arrives to stay the topmost layer (behind an open modal it is inert —
 // dismiss and actions work once the dialog closes).
 const visible = !open && live.length > 0
 const newest = live.at(-1)?.id
 useLayoutEffect(() => {
  const el = boxRef.current
  if (!visible || !el || typeof el.showPopover !== 'function') return
  if (el.matches(':popover-open')) el.hidePopover()
  el.showPopover()
 }, [visible, newest])

 // Publish where the stack ends so the info snackbar can stay out of its way.
 useEffect(() => {
  const el = boxRef.current
  const set = useNotifications.getState().setStackBottomPx
  set(!el || top ? 0 : Math.round(window.innerHeight - el.getBoundingClientRect().top))
 }, [live, top])
 useEffect(() => () => { useNotifications.getState().setStackBottomPx(0) }, [])

 useEffect(() => {
  if (live.length === 0) return
  const t = window.setInterval(() => {
   const now = Date.now()
   for (const l of live) if (!l.paused && l.until <= now) beginHide(l.id)
  }, TICK_MS)
  return () => window.clearInterval(t)
 }, [live, beginHide])

 if (!visible) return null
 const shown = live.slice(-MAX_TOASTS)
 // Home: newest at the bottom (near the button). Player: newest at the top, right under the top bar.
 const deck = top ? [...shown].reverse() : shown
 return (
  <div
   ref={boxRef}
   popover="manual"
   // The UA's popover box (centered, bordered, Canvas colours, scrolling) reset to a plain stack.
   className={`fixed inset-auto z-[200] m-0 flex w-[min(90vw,380px)] flex-col gap-2 overflow-visible border-0 bg-transparent p-0 text-inherit ${top ? 'top-18 right-3' : 'bottom-20 left-4'}`}
  >
   {deck.map((l) => {
    const n = items.find((x) => x.id === l.id)
    if (!n) return null
    return (
     <div
      key={l.id}
      ref={(el) => {
       if (el) cards.current.set(l.id, el)
       return () => { cards.current.delete(l.id) }
      }}
      className={`relative ${top ? 'toast-in-top' : 'toast-in'}`}
      onPointerEnter={() => pauseLive(l.id)}
      onPointerLeave={() => resumeLive(l.id)}
     >
      <Card
       n={n}
       action={actions.get(n.id)}
       closeIcon="close"
       closeLabel="Удалить"
       floating
       onClose={() => beginHide(n.id, true)}
      />
     </div>
    )
   })}
  </div>
 )
}

function Row({ n }: { n: AppNotification }) {
 const action = useNotifications((s) => s.actions.get(n.id))
 const remove = useNotifications((s) => s.remove)
 return <Card n={n} action={action} closeIcon="delete" closeLabel="Удалить" onClose={() => void remove(n.id)} />
}

/**
 * Floating notification center: popups that collapse into one button, and a panel listing every
 * warn/error until the user deletes it. On the player screen everything hugs the top bar so it stays
 * out of the picture; on the home screen it sits in the bottom-left corner.
 */
export function NotificationCenter() {
 const player = useRouterState({ select: (s) => s.location.pathname === '/player' })
 const items = useNotifications((s) => s.items)
 const open = useNotifications((s) => s.open)
 const setOpen = useNotifications((s) => s.setOpen)
 const clear = useNotifications((s) => s.clear)
 const panelRef = useRef<HTMLDivElement>(null)

 // Deleting the last notification also hides the panel and the button.
 useEffect(() => {
  if (items.length === 0) setOpen(false)
 }, [items.length, setOpen])

 // Escape and a click outside both the panel and its button close the panel.
 useEffect(() => {
  if (!open) return
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
  const onDown = (e: PointerEvent) => {
   const t = e.target
   if (t instanceof Node && (panelRef.current?.contains(t) || buttonEl?.contains(t))) return
   setOpen(false)
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDown, true)
  return () => {
   window.removeEventListener('keydown', onKey)
   window.removeEventListener('pointerdown', onDown, true)
  }
 }, [open, setOpen])

 // No early return when the list empties: the button and the panel play their exit first.
 return (
  <>
   <LiveToasts top={player} />
   {!player && <NotificationButton className="fixed bottom-4 left-4 z-[200] size-12" />}
   <Presence>
    {open && (
     <div
      ref={panelRef}
      aria-label="Центр уведомлений"
      role="dialog"
      className={`m3e-motion-pop fixed z-[200] flex max-h-[60vh] w-[min(90vw,420px)] flex-col bg-[var(--md-sys-color-surface-container-high)] shadow-xl ${player ? 'top-18 right-3 origin-top-right' : 'bottom-20 left-4 origin-bottom-left'}`}
      style={{ borderRadius: 'var(--md-sys-shape-corner-large)' }}
     >
      <div className="flex items-center gap-2 py-2 pr-2 pl-4">
       <div className="type-title-medium grow">Уведомления</div>
       <button
        type="button"
        onClick={() => void clear()}
        className="state-layer type-label-large relative shrink-0 rounded-full px-3 py-1.5 text-[var(--md-sys-color-primary)]"
       >
        Очистить все
       </button>
       <IconButton icon="close" label="Закрыть" onClick={() => setOpen(false)} />
      </div>
      {/* overflow-x-hidden: a tooltip's abs-positioned box must not create a horizontal scrollbar. */}
      <div className="flex flex-col gap-1.5 overflow-x-hidden overflow-y-auto px-2 pb-2">
       {[...items].reverse().map((n) => <Row key={n.id} n={n} />)}
      </div>
     </div>
    )}
   </Presence>
  </>
 )
}
