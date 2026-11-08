import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Snackbar } from '@tomato1337/m3e-react'
import { useNotifications } from '@/common/api/notify'
import { overlayTopOffset, WARNING_STACK_EVENT, type OverlayRect } from '@/modules/Notifications'
import { useSessionStore } from '@/modules/Session'

/**
 * The kit's one snackbar, placed with what is actually on screen: a top toast goes under the top bar
 * and under any warning popup that shares its horizontal band; the player's warning stack reads the
 * same measured inset instead of the old fixed 72 px.
 *
 * The host subscribes only to placement data: the route and player session (the bar mounts per
 * screen), the warning stack's lifecycle event (it mounts, moves and collapses) and its bottom
 * offset. It never watches the document body, so a progress line updating every frame does not
 * schedule layout reads.
 */
export function SnackbarHost({ bottomClearance }: { bottomClearance?: number }) {
 const pathname = useRouterState({ select: (s) => s.location.pathname })
 // The player bar mounts with the session, which can arrive after the route is already `/player`.
 const sessionId = useSessionStore((s) => s.session?.sessionId ?? '')
 // The bottom-left warning stack publishes its height; only this host re-renders with it.
 const stackBottom = useNotifications((s) => s.stackBottomPx)
 const [anchors, setAnchors] = useState(0)
 const [topOffset, setTopOffset] = useState(72)
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

 return <Snackbar placement={pathname === '/player' ? 'top' : 'bottom'} topOffset={topOffset} bottomOffset={Math.max(96, bottomClearance ?? 0, stackBottom + 8)} />
}
