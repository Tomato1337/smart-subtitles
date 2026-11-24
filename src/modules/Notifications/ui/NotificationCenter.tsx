import { useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { animateExit, Button, Icon, IconButton, Presence, toastStore } from '@tomato1337/m3e-react'
import { useNotifications, type NotifyAction } from '@/common/api/notify'
import type { AppNotification, NotifyLevel } from '@/common/types/ipc'
import { useSessionStore } from '@/modules/Session'
import { overlaysReachBoundary } from '../lib/placement'

/** Toasts on screen at once; older ones are already collapsing into the center. */
const MAX_TOASTS = 3
/** How often expired toasts are noticed. */
const TICK_MS = 250

export const NOTIFICATION_PANEL_ID = 'notification-center-panel'

/** The live warning stack (dis)appeared or was collapsed; the snackbar host re-reads its anchors. */
export const WARNING_STACK_EVENT = 'smartsubs:warning-stack'

export function warningStackChanged(): void {
  window.dispatchEvent(new Event(WARNING_STACK_EVENT))
}

export type NotificationTriggerKind = 'header' | 'floating'
export type ContainsTarget = { contains: (node: Node) => boolean }

const triggerRegistry = new Map<ContainsTarget, NotificationTriggerKind>()
const triggerListeners = new Set<() => void>()
let activeHeaderTrigger: ContainsTarget | null = null

function refreshHeaderSnapshot() {
  let next: ContainsTarget | null = null
  for (const [el, kind] of triggerRegistry) {
    if (kind === 'header') next = el
  }
  activeHeaderTrigger = next
  for (const listener of triggerListeners) listener()
}

/** Registers a mounted trigger button so outside-click checks and header anchoring track it across route transitions. */
export function registerNotificationTrigger(el: ContainsTarget, kind: NotificationTriggerKind): () => void {
  triggerRegistry.set(el, kind)
  refreshHeaderSnapshot()
  return () => {
    if (triggerRegistry.delete(el)) refreshHeaderSnapshot()
  }
}

export function getRegisteredTriggers(): ContainsTarget[] {
  return [...triggerRegistry.keys()]
}

function subscribeTriggers(listener: () => void): () => void {
  triggerListeners.add(listener)
  return () => {
    triggerListeners.delete(listener)
  }
}

function getHeaderTriggerSnapshot(): ContainsTarget | null {
  return activeHeaderTrigger
}

/** True when `target` is inside the notification panel or any mounted trigger button (`onDown` must not fight clicks). */
export function isInsideNotificationControls(
  target: unknown,
  panel: ContainsTarget | null,
  triggers: Iterable<ContainsTarget> = triggerRegistry.keys(),
): boolean {
  if (target == null || typeof target !== 'object') return false
  if (typeof Node !== 'undefined' && !(target instanceof Node)) return false
  const node = target as Node
  if (panel?.contains(node)) return true
  for (const trigger of triggers) {
    if (trigger.contains(node)) return true
  }
  return false
}

/** Computes top-right panel coordinates below the Home/Settings header trigger, with safe viewport clamping. */
export function headerAnchorStyle(
  rect: { bottom: number; right: number } | null,
  viewportWidth: number,
  viewportHeight: number,
): { top: number; right: number; maxHeight: number } {
  const hasRect = !!rect && rect.bottom > 0 && rect.right > 0
  const top = hasRect ? Math.max(16, Math.round(rect.bottom + 8)) : 96
  const maxRight = Math.max(12, viewportWidth - 32)
  const right = hasRect ? Math.max(12, Math.min(maxRight, Math.round(viewportWidth - rect.right))) : 24
  const maxHeight = Math.max(200, Math.min(Math.round(viewportHeight * 0.6), viewportHeight - top - 16))
  return { top, right, maxHeight }
}

/** Resolves top-right notification panel and toast placement for the active route. */
export function notificationRouteLayout(
  pathname: string,
  hasHeaderTrigger: boolean,
): {
  player: boolean
  anchorToHeader: boolean
  panelPositionClass: string
  toastRightClass: 'right-3' | 'right-4'
} {
  const player = pathname === '/player'
  const knownHeaderRoute = pathname === '/' || pathname === '/settings' || pathname === '/stats'
  const anchorToHeader = !player && (knownHeaderRoute || hasHeaderTrigger)
  const panelPositionClass = player
    ? 'top-18 right-3 origin-top-right max-h-[60vh]'
    : anchorToHeader
      ? 'origin-top-right'
      : 'top-18 right-4 origin-top-right max-h-[60vh]'
  return {
    player,
    anchorToHeader,
    panelPositionClass,
    toastRightClass: player ? 'right-3' : 'right-4',
  }
}

/** Computes top inset (px) for non-player live notification toasts below the header bell or topbar. */
export function liveToastTopOffset(
  triggerRect: { bottom: number; height?: number } | null,
  topbarRect: { bottom: number; height?: number } | null,
): number {
  if (triggerRect && (triggerRect.bottom > 0 || (triggerRect.height ?? 0) > 0)) {
    return Math.max(16, Math.round(triggerRect.bottom + 8))
  }
  if (topbarRect && (topbarRect.bottom > 0 || (topbarRect.height ?? 0) > 0)) {
    return Math.max(16, Math.round(topbarRect.bottom + 8))
  }
  return 76
}

const LEVEL: Record<NotifyLevel, { icon: string; stripe: string; tileBg: string; tileFg: string }> = {
  error: {
    icon: 'error',
    stripe: 'var(--md-sys-color-error)',
    tileBg: 'var(--md-sys-color-error-container)',
    tileFg: 'var(--md-sys-color-on-error-container)',
  },
  warn: {
    icon: 'warning',
    stripe: 'var(--app-warning)',
    tileBg: 'var(--app-warning-container)',
    tileFg: 'var(--app-on-warning-container)',
  },
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
  // The floating popup borrows the shared tonal snackbar recipe; the stored row keeps its denser surface.
  const surface = floating
    ? 'm3e-snackbar-surface'
    : 'bg-[var(--md-sys-color-surface-container-highest)]'
  return (
    <div
      className={`relative flex items-start ${floating ? 'gap-2.5' : 'gap-2 py-2 pr-1 pl-5'} ${surface}`}
      style={floating ? undefined : { borderRadius: 'var(--md-sys-shape-corner-medium)' }}
    >
      {/* Only the denser center rows carry an inset stripe; the 28px-corner floating popup uses a circular semantic icon tile. */}
      {!floating && (
        <span aria-hidden className="absolute top-2 bottom-2 left-1.5 w-1 rounded-full" style={{ background: style.stripe }} />
      )}
      {floating ? (
        <span
          className="shrink-0"
          data-part="icon"
          style={{
            borderRadius: 'var(--md-sys-shape-corner-full)',
            background: style.tileBg,
            color: style.tileFg,
          }}
        >
          <Icon name={style.icon} fill />
        </span>
      ) : (
        <span className="shrink-0" style={{ color: style.stripe }}>
          <Icon name={style.icon} />
        </span>
      )}
      <div className={floating ? 'flex min-w-0 grow flex-col gap-0.5 py-1' : 'min-w-0 grow'}>
        <div className="type-body-medium select-text whitespace-pre-wrap break-words">{n.message}</div>
        <div className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">{stamp(n.createdAt)}</div>
      </div>
      {action && (floating ? (
        <Button variant="text" size="md" className="type-emph shrink-0" onClick={action.run}>
          {action.label}
        </Button>
      ) : (
        // The stored row keeps its original compact action height; only the popup uses the 56 px target.
        <button
          type="button"
          className="state-layer type-label-large relative shrink-0 rounded-full px-3 py-1.5 text-[var(--md-sys-color-primary)]"
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
      <IconButton icon={closeIcon} label={closeLabel} tipPos="left" onClick={onClose} />
    </div>
  )
}

/** Tonal header bell button for Home and Settings topbars; always visible with an unread count badge when non-empty. */
export function NotificationHeaderButton({
  size = 'lg',
  className = '',
}: {
  size?: 'md' | 'lg'
  className?: string
}) {
  const items = useNotifications((s) => s.items)
  const open = useNotifications((s) => s.open)
  const setOpen = useNotifications((s) => s.setOpen)
  const btnRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const el = btnRef.current
    if (!el) return
    return registerNotificationTrigger(el, 'header')
  }, [])

  const count = items.length
  const hasError = items.some((i) => i.level === 'error')
  const buttonSize = size === 'md' ? 40 : 56
  const buttonRadius = size === 'md' ? 20 : 28

  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <IconButton
        ref={btnRef}
        icon="notifications"
        label={count > 0 ? `Уведомления (${count})` : 'Уведомления'}
        variant="secondary"
        size={size}
        tipPos="bottom"
        noTip={open}
        pressRadius={size === 'lg' ? '18px' : undefined}
        data-tour="notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={NOTIFICATION_PANEL_ID}
        onClick={() => setOpen(!open)}
        style={{
          '--m3e-icon-button-size': `${buttonSize}px`,
          '--m3e-icon-button-radius': `${buttonRadius}px`,
        } as CSSProperties}
      />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="type-label-small pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 leading-none ring-2 ring-[var(--md-sys-color-surface)]"
          style={{
            background: hasError ? 'var(--md-sys-color-error)' : 'var(--app-warning)',
            color: hasError ? 'var(--md-sys-color-on-error)' : 'var(--md-sys-color-surface)',
          }}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </span>
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
  const btnRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const el = btnRef.current
    if (!el) return
    return registerNotificationTrigger(el, 'floating')
  }, [])

  // While it pops out (the list has just emptied) it keeps the last count and colour.
  const [last, setLast] = useState(items)
  if (items.length > 0 && items !== last) setLast(items)
  const shown = items.length > 0 ? items : last
  const hasError = shown.some((i) => i.level === 'error')
  return (
    <button
      ref={btnRef}
      type="button"
      aria-label="Уведомления"
      data-tour="notifications"
      onClick={() => setOpen(!open)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={NOTIFICATION_PANEL_ID}
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
 * Popups flying in as a stack at the top-right on every route, newest on top under the header bell
 * or player top bar. Each one, when its time is up (or on "Удалить"), shrinks upward into the
 * notification center before leaving the list.
 */
type StackFit = 'checking' | 'fit' | 'tight'

function LiveToasts({
  player,
  pathname,
  headerTrigger,
}: {
  player: boolean
  pathname: string
  headerTrigger: ContainsTarget | null
}) {
  const live = useNotifications((s) => s.live)
  const items = useNotifications((s) => s.items)
  const actions = useNotifications((s) => s.actions)
  const open = useNotifications((s) => s.open)
  const pauseLive = useNotifications((s) => s.pauseLive)
  const resumeLive = useNotifications((s) => s.resumeLive)
  // The player's top bar and subtitle anchors mount with the session, possibly after the route.
  const sessionId = useSessionStore((s) => s.session?.sessionId ?? '')
  const boxRef = useRef<HTMLDivElement>(null)
  /** Popup wrappers by id, for their exit motion. */
  const cards = useRef(new Map<number, HTMLDivElement>())
  const hiding = useRef(new Set<number>())
  // A persistent top toast shares the header band; the stack must fit above the subtitle/control zone.
  const hasTopToast = useSyncExternalStore(toastStore.subscribe, () => {
    const toast = toastStore.get()
    return toast.message !== null && (toast.options.placement ?? 'bottom') === 'top'
  })
  const [fit, setFit] = useState<StackFit>(player ? 'checking' : 'fit')
  const [revision, setRevision] = useState(0)
  const [nonPlayerTop, setNonPlayerTop] = useState(76)
  const active = !open && live.length > 0
  const checking = player && fit === 'checking'
  const stackPresent = active && (!player || fit !== 'tight')
  const newest = live.at(-1)?.id

  // A popup leaves through its exit animation (`data-closing` → `.toast-in-top[data-closing]` in
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
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el || typeof el.showPopover !== 'function') return
    if (stackPresent) {
      if (el.matches(':popover-open')) el.hidePopover()
      el.showPopover()
    } else if (el.matches(':popover-open')) {
      el.hidePopover()
    }
  }, [stackPresent, newest])

  // Window size changes the available band; a fresh measurement is needed even without new popups.
  useEffect(() => {
    const onResize = () => setRevision((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The persistent toast wraps differently as its text/actions change; its real height is what
  // decides the collapse, so remeasure when it resizes rather than on every countdown tick.
  useEffect(() => {
    if (!player || !hasTopToast) return
    const toast = document.querySelector('.m3e-snackbar')
    if (!toast) return
    const observer = new ResizeObserver(() => setRevision((n) => n + 1))
    observer.observe(toast)
    return () => observer.disconnect()
  }, [player, hasTopToast])

  // Non-player routes sit under the top-right header bell or topbar without needing boundary collapse.
  useLayoutEffect(() => {
    setFit(player ? 'checking' : 'fit')
  }, [active, live, hasTopToast, revision, player, sessionId])

  // Anchor non-player live popups directly under the header bell (or [data-app-topbar], fallback 76px).
  useLayoutEffect(() => {
    if (player || !active) return
    let alive = true
    const update = () => {
      if (!alive) return
      const triggerRect = headerTrigger instanceof HTMLElement ? headerTrigger.getBoundingClientRect() : null
      const topbar = document.querySelector('[data-app-topbar]')
      const topbarRect = topbar ? topbar.getBoundingClientRect() : null
      const next = liveToastTopOffset(triggerRect, topbarRect)
      setNonPlayerTop((prev) => (prev === next ? prev : next))
    }
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (observer) {
      const headerEl = headerTrigger instanceof Element ? (headerTrigger.closest('header') ?? headerTrigger) : null
      if (headerEl) observer.observe(headerEl)
      if (headerTrigger instanceof Element && headerTrigger !== headerEl) observer.observe(headerTrigger)
      const topbar = document.querySelector('[data-app-topbar]')
      if (topbar) observer.observe(topbar)
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    void document.fonts?.ready.then(update)
    return () => {
      alive = false
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [player, pathname, active, headerTrigger, revision])

  // On /player, show popups only while the measured warning stack plus persistent top toast stays above
  // the subtitle/control zone. A narrow window that still fits keeps its popups.
  useLayoutEffect(() => {
    if (!active || !player || fit !== 'checking') return
    const el = boxRef.current
    if (!el) return
    const bar = document.querySelector('[data-app-topbar]')
    const headerBottom = bar ? bar.getBoundingClientRect().bottom : 0
    const rect = el.getBoundingClientRect()
    // offsetHeight plus the fixed top ignore the entry transform; the settled stack is what matters.
    const stackTop = Math.max(8, Math.ceil(headerBottom) + 8)
    const stack = { left: rect.left, right: rect.right, top: stackTop, bottom: stackTop + el.offsetHeight }
    const toast = document.querySelector('.m3e-snackbar[data-placement="top"]')
    const toastHeight = toast && toast.matches(':popover-open') ? toast.getBoundingClientRect().height : 0
    let boundaryTop: number | null = null
    // Whichever of the subtitle root and the control overlay starts higher is the hard limit.
    for (const selector of ['[data-app-subtitles]', '[data-app-player-controls]', '[data-tour="subtitle"]', '[data-tour="seek"]']) {
      const boundary = document.querySelector(selector)
      if (!boundary) continue
      const bRect = boundary.getBoundingClientRect()
      if (bRect.height > 0) boundaryTop = boundaryTop === null ? bRect.top : Math.min(boundaryTop, bRect.top)
    }
    const tight = boundaryTop !== null && overlaysReachBoundary({
      viewportWidth: window.innerWidth,
      headerBottom,
      stack,
      toastHeight,
      boundaryTop,
    })
    setFit(tight ? 'tight' : 'fit')
  }, [active, fit, live, hasTopToast, revision, player])

  // The snackbar host re-reads its anchors instead of watching the whole document for mutations.
  useEffect(() => { warningStackChanged() }, [stackPresent, player])

  // A popup collapsed by measurement gets no pointerleave: release its hover pause so it can expire.
  useEffect(() => {
    if (stackPresent || !active) return
    for (const item of live) if (item.paused) resumeLive(item.id)
  }, [stackPresent, active, live, resumeLive])

  // Popups always live at the top-right, so bottom-left clearance is never reserved.
  useEffect(() => {
    useNotifications.getState().setStackBottomPx(0)
  }, [live, player, stackPresent])
  useEffect(() => () => { useNotifications.getState().setStackBottomPx(0) }, [])

  useEffect(() => {
    if (live.length === 0) return
    const t = window.setInterval(() => {
      const now = Date.now()
      for (const l of live) if (!l.paused && l.until <= now) beginHide(l.id)
    }, TICK_MS)
    return () => window.clearInterval(t)
  }, [live, beginHide])

  if (!active || (player && fit === 'tight')) return null
  const shown = live.slice(-MAX_TOASTS)
  // Newest at the top, right under the top bar or header bell on every route.
  const deck = [...shown].reverse()
  return (
    <div
      ref={boxRef}
      popover="manual"
      data-app-warning-stack={player ? '' : undefined}
      // The UA's popover box (centered, bordered, Canvas colours, scrolling) reset to a plain stack.
      className={`fixed inset-auto z-[200] m-0 flex w-[min(90vw,380px)] flex-col gap-2 overflow-visible border-0 bg-transparent p-0 text-inherit ${player ? 'right-3' : 'right-4'}`}
      style={{
        top: player ? 'var(--app-player-overlay-top, 72px)' : `${nonPlayerTop}px`,
        // The one frame spent measuring must not flash a stack that will not fit.
        ...(checking ? { visibility: 'hidden' as const } : undefined),
      }}
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
            className="relative toast-in-top"
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
 * Notification center: top-right live popups that collapse into the bell, and a top-right panel
 * listing every warn/error until the user deletes it.
 */
export function NotificationCenter() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const headerTrigger = useSyncExternalStore(subscribeTriggers, getHeaderTriggerSnapshot)
  const items = useNotifications((s) => s.items)
  const open = useNotifications((s) => s.open)
  const setOpen = useNotifications((s) => s.setOpen)
  const clear = useNotifications((s) => s.clear)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevCount = useRef(items.length)
  const [headerPos, setHeaderPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null)

  const { player, anchorToHeader, panelPositionClass } =
    notificationRouteLayout(pathname, headerTrigger !== null)

  // Never keep a panel opened on one route lingering over another route.
  useEffect(() => {
    setOpen(false)
  }, [pathname, setOpen])

  // Close the panel when the user clears/removes the last notification, without blocking opening an empty panel from Home/Settings.
  useEffect(() => {
    if (prevCount.current > 0 && items.length === 0) setOpen(false)
    prevCount.current = items.length
  }, [items.length, setOpen])

  // Measure header bell button on non-player routes so the panel anchors cleanly below its bottom-right edge.
  useLayoutEffect(() => {
    if (!open || !anchorToHeader) {
      setHeaderPos(null)
      return
    }
    const update = () => {
      const rect = headerTrigger instanceof HTMLElement ? headerTrigger.getBoundingClientRect() : null
      setHeaderPos(headerAnchorStyle(rect, window.innerWidth, window.innerHeight))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorToHeader, headerTrigger])

  // Escape and a click outside both the panel and any registered trigger button close the panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: PointerEvent) => {
      if (isInsideNotificationControls(e.target, panelRef.current)) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, setOpen])

  const panelStyle: CSSProperties = {
    borderRadius: 'var(--md-sys-shape-corner-large)',
    ...(anchorToHeader && headerPos ? { top: headerPos.top, right: headerPos.right, maxHeight: headerPos.maxHeight } : null),
    ...(anchorToHeader && !headerPos ? { top: 96, right: 24, maxHeight: '60vh' } : null),
  }

  // No early return when the list empties: the button and the panel play their exit first.
  return (
    <>
      <LiveToasts player={player} pathname={pathname} headerTrigger={headerTrigger} />
      <Presence>
        {open && (
          <div
            ref={panelRef}
            id={NOTIFICATION_PANEL_ID}
            aria-label="Центр уведомлений"
            role="dialog"
            className={`m3e-motion-pop fixed z-[200] flex w-[min(90vw,420px)] flex-col bg-[var(--md-sys-color-surface-container-high)] shadow-xl ${panelPositionClass}`}
            style={panelStyle}
          >
            <div className="flex items-center gap-2 py-2 pr-2 pl-4">
              <div className="type-title-medium grow">Уведомления</div>
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clear()}
                  className="state-layer type-label-large relative shrink-0 rounded-full px-3 py-1.5 text-[var(--md-sys-color-primary)]"
                >
                  Очистить все
                </button>
              )}
              <IconButton icon="close" label="Закрыть" onClick={() => setOpen(false)} />
            </div>
            {/* overflow-x-hidden: a tooltip's abs-positioned box must not create a horizontal scrollbar. */}
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center text-[var(--md-sys-color-on-surface-variant)]">
                <Icon name="notifications_none" size={28} />
                <div className="type-title-small text-[var(--md-sys-color-on-surface)]">Уведомлений пока нет</div>
                <div className="type-body-small">Здесь появятся предупреждения и ошибки.</div>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 overflow-x-hidden overflow-y-auto px-2 pb-2">
                {[...items].reverse().map((n) => <Row key={n.id} n={n} />)}
              </div>
            )}
          </div>
        )}
      </Presence>
    </>
  )
}
