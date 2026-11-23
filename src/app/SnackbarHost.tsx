import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Snackbar } from '@tomato1337/m3e-react'
import { useNotifications } from '@/common/api/notify'
import { overlayTopOffset, WARNING_STACK_EVENT, type OverlayRect } from '@/modules/Notifications'
import { useSessionStore } from '@/modules/Session'

/**
 * The kit's one snackbar, placed with what is actually on screen: a top toast on `/player` goes
 * under the top bar and under any warning popup that shares its horizontal band, while bottom
 * toasts on `/settings` dynamically clear `[data-app-savebar]` when unsaved changes are shown.
 *
 * The host watches DOM mutations only on `/settings` (never on `/player`, so a progress line
 * updating every frame does not schedule layout reads).
 */
export function SnackbarHost({ bottomClearance }: { bottomClearance?: number }) {
 const pathname = useRouterState({ select: (s) => s.location.pathname })
 // The player bar mounts with the session, which can arrive after the route is already `/player`.
 const sessionId = useSessionStore((s) => s.session?.sessionId ?? '')
 const stackBottom = useNotifications((s) => s.stackBottomPx)
 const [anchors, setAnchors] = useState(0)
 const [topOffset, setTopOffset] = useState(72)
 const [saveBarOffset, setSaveBarOffset] = useState(0)
 /** Last value written to the player's CSS variable; avoid rewriting an unchanged inset. */
 const inset = useRef<string | null>(null)

 // The live stack mounts, moves and collapses inside the same route; it announces that explicitly.
 useEffect(() => {
  const bump = () => setAnchors((n) => n + 1)
  window.addEventListener(WARNING_STACK_EVENT, bump)
  return () => window.removeEventListener(WARNING_STACK_EVENT, bump)
 }, [])

 useLayoutEffect(() => {
  let frame = 0
  let alive = true
  const measure = () => {
   frame = 0
   if (!alive) return
   const bar = document.querySelector('[data-app-topbar]')
   const barBottom = bar ? bar.getBoundingClientRect().bottom : 0
   // Move the player's stack first, so the warning rect below is already measured in its new spot.
   const next = `${Math.max(8, Math.ceil(barBottom) + 8)}px`
   if (inset.current !== next) {
    inset.current = next
    document.documentElement.style.setProperty('--app-player-overlay-top', next)
   }
   const warningEl = document.querySelector<HTMLElement>('[data-app-warning-stack]')
   // offsetHeight + the final top ignore the entry transform, so the toast does not settle low.
   const warningTop = Math.max(8, Math.ceil(barBottom) + 8)
   let warning: OverlayRect | null = null
   if (warningEl) {
    const rect = warningEl.getBoundingClientRect()
    warning = { left: rect.left, right: rect.right, top: warningTop, bottom: warningTop + warningEl.offsetHeight }
   }
   const offset = overlayTopOffset(window.innerWidth, barBottom, warning)
   setTopOffset((previous) => (previous === offset ? previous : offset))
  }
  const schedule = () => {
   if (alive && !frame) frame = requestAnimationFrame(measure)
  }
  const observer = new ResizeObserver(schedule)
  const bar = document.querySelector('[data-app-topbar]')
  if (bar) observer.observe(bar)
  const warning = document.querySelector('[data-app-warning-stack]')
  if (warning) observer.observe(warning)
  window.addEventListener('resize', schedule)
  // Weights/fonts can change the bar height after it first paints.
  void document.fonts.ready.then(schedule)
  measure()
  return () => {
   alive = false
   if (frame) cancelAnimationFrame(frame)
   observer.disconnect()
   window.removeEventListener('resize', schedule)
  }
 }, [pathname, sessionId, anchors])

 // On `/settings`, watch for SaveBar mounting/resizing so bottom snackbars lift cleanly above it.
 useLayoutEffect(() => {
  if (pathname !== '/settings') {
   setSaveBarOffset(0)
   return
  }
  let frame = 0
  let alive = true
  let observedEl: HTMLElement | null = null
  const schedule = () => {
   if (alive && !frame) frame = requestAnimationFrame(measure)
  }
  const resizeObserver = new ResizeObserver(schedule)
  const findSaveBar = () =>
   document.querySelector<HTMLElement>('[data-app-savebar], [role="region"][aria-label="Несохранённые изменения"]')

  const measure = () => {
   frame = 0
   if (!alive) return
   const el = findSaveBar()
   if (el !== observedEl) {
    resizeObserver.disconnect()
    observedEl = el
    if (el) resizeObserver.observe(el)
   }
   let next = 0
   if (el && !el.closest('[data-closing]')) {
    const rect = el.getBoundingClientRect()
    if (rect.height > 0) {
     const fixedEl = getComputedStyle(el).position === 'fixed'
      ? el
      : el.closest<HTMLElement>('.m3e-motion-rise')
     const fixedBottom = fixedEl && getComputedStyle(fixedEl).position === 'fixed'
      ? parseFloat(getComputedStyle(fixedEl).bottom) || 0
      : 0
     const settled = fixedEl ? Math.ceil(fixedBottom + el.offsetHeight) + 8 : 0
     const fromRect = Math.ceil(window.innerHeight - rect.top) + 8
     next = Math.max(0, fromRect, settled)
    }
   }
   setSaveBarOffset((previous) => (previous === next ? previous : next))
  }

  const mutationObserver = new MutationObserver(schedule)
  const root = document.getElementById('root') ?? document.body
  mutationObserver.observe(root, {
   childList: true,
   subtree: true,
   attributes: true,
   attributeFilter: ['data-closing', 'data-app-savebar'],
  })
  window.addEventListener('resize', schedule)
  measure()
  return () => {
   alive = false
   if (frame) cancelAnimationFrame(frame)
   mutationObserver.disconnect()
   resizeObserver.disconnect()
   window.removeEventListener('resize', schedule)
  }
 }, [pathname])

 return (
  <Snackbar
   placement={pathname === '/player' ? 'top' : 'bottom'}
   topOffset={topOffset}
   bottomOffset={Math.max(24, bottomClearance ?? 0, saveBarOffset, stackBottom + 8)}
  />
 )
}
