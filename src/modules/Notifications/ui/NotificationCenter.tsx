import { useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNotifications, type NotifyAction } from '@/common/api/notify'
import type { AppNotification, NotifyLevel } from '@/common/types/ipc'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'

/** Toasts on screen at once; older ones are already collapsing into the center. */
const MAX_TOASTS = 3
/** How often expired toasts are noticed. */
const TICK_MS = 250
/** Must match the `.toast-out*` animations in main.css. */
const OUT_MS = 240

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
 exiting?: boolean
 /** A standalone popup needs its own surface and shadow; a row inside the panel does not. */
 floating?: boolean
 /** Player layout: popups drop out of the top bar and shrink back up into it. */
 top?: boolean
}

/** One notification: identical markup for the popups and for the center rows. */
function Card({ n, action, onClose, closeIcon, closeLabel, exiting = false, floating = false, top = false }: CardProps) {
 const style = LEVEL[n.level]
 const enter = top ? 'toast-in-top' : 'toast-in'
 const leave = top ? 'toast-out-top' : 'toast-out'
 const surface = floating ? `bg-[var(--md-sys-color-surface-container-high)] shadow-lg ${exiting ? leave : enter}` : ''
 return (
  <div
   className={`relative flex items-start gap-2 py-2 pr-1 pl-3 ${surface}`}
   style={{ borderLeft: `4px solid ${style.stripe}`, borderRadius: floating ? 'var(--md-sys-shape-corner-medium)' : undefined }}
  >
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

/** Colored bell with a count; red when an error is present, orange otherwise. Hidden when empty. */
export function NotificationButton({ className = '' }: { className?: string }) {
 const items = useNotifications((s) => s.items)
 const open = useNotifications((s) => s.open)
 const setOpen = useNotifications((s) => s.setOpen)
 if (items.length === 0) return null
 const hasError = items.some((i) => i.level === 'error')
 return (
  <button
   ref={(el) => { buttonEl = el }}
   type="button"
   aria-label="Уведомления"
   data-tour="notifications"
   onClick={() => setOpen(!open)}
   className={`md-pop state-layer flex shrink-0 items-center justify-center rounded-full shadow-lg ${className}`}
   style={{ background: hasError ? 'var(--md-sys-color-error)' : 'var(--app-warning)', color: 'var(--md-sys-color-surface)' }}
  >
   <Icon name="notifications" size={20} />
   <span
    className="type-label-small absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full px-1"
    style={{ background: 'var(--md-sys-color-surface-container-highest)', color: 'var(--md-sys-color-on-surface)' }}
   >
    {items.length > 99 ? '99+' : items.length}
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
 const [exiting, setExiting] = useState<number[]>([])
 const timers = useRef<number[]>([])
 const boxRef = useRef<HTMLDivElement>(null)

 const beginHide = useCallback((id: number, remove = false) => {
  setExiting((x) => (x.includes(id) ? x : [...x, id]))
  timers.current.push(window.setTimeout(() => {
   const st = useNotifications.getState()
   if (remove) void st.remove(id)
   else st.hideLive(id)
   setExiting((x) => x.filter((v) => v !== id))
  }, OUT_MS))
 }, [])

 useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)) }, [])

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

 if (open || live.length === 0) return null
 const shown = live.slice(-MAX_TOASTS)
 // Home: newest at the bottom (near the button). Player: newest at the top, right under the top bar.
 const deck = top ? [...shown].reverse() : shown
 return (
  <div ref={boxRef} className={`fixed z-[200] flex w-[min(90vw,380px)] flex-col gap-2 ${top ? 'top-16 right-3' : 'bottom-20 left-4'}`}>
   {deck.map((l) => {
    const n = items.find((x) => x.id === l.id)
    if (!n) return null
    return (
     <div
      key={l.id}
      className="relative"
      onPointerEnter={() => pauseLive(l.id)}
      onPointerLeave={() => resumeLive(l.id)}
     >
      <Card
       n={n}
       action={actions.get(n.id)}
       closeIcon="close"
       closeLabel="Удалить"
       exiting={exiting.includes(l.id)}
       floating
       top={top}
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

 if (items.length === 0) return null
 return (
  <>
   <LiveToasts top={player} />
   {!player && <NotificationButton className="fixed bottom-4 left-4 z-[200] size-12" />}
   {open && (
    <div
     ref={panelRef}
     aria-label="Центр уведомлений"
     role="dialog"
     className={`md-pop fixed z-[200] flex max-h-[60vh] w-[min(90vw,420px)] flex-col bg-[var(--md-sys-color-surface-container-high)] shadow-xl ${player ? 'top-16 right-3 origin-top-right' : 'bottom-20 left-4 origin-bottom-left'}`}
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
     <div className="overflow-x-hidden overflow-y-auto pb-2">
      {[...items].reverse().map((n) => <Row key={n.id} n={n} />)}
     </div>
    </div>
   )}
  </>
 )
}
