import { createRootRoute, createRoute, createRouter, Outlet, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Snackbar } from '@tomato1337/m3e-react'
import { logEvent } from '@/common/api/eventLog'
import { useNotifications } from '@/common/api/notify'
import { useCardEvents } from '@/modules/Cards'
import { NotificationCenter, useNotificationEvents } from '@/modules/Notifications'
import { useSessionEvents } from '@/modules/Session'
import { useConfigEvents, useDepsCheck } from '@/modules/Settings'
import { useInirTheme } from '@/modules/Theme'
import { HomePage } from '@/pages/home'
import { PlayerPage } from '@/pages/player'

function Root() {
  const navigate = useNavigate()
  const opened = useCallback(() => void navigate({ to: '/player' }), [navigate])
  useSessionEvents(opened)
  useCardEvents()
  useConfigEvents()
  useDepsCheck()
  useInirTheme()
  useNotificationEvents()
  // Info messages must not cover the warning/error popups stacked above the bell.
  const stackBottom = useNotifications((s) => s.stackBottomPx)
  return (
    <>
      <Outlet />
      <Snackbar bottomOffset={Math.max(96, stackBottom + 8)} />
      <NotificationCenter />
    </>
  )
}

const rootRoute = createRootRoute({ component: Root })
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage })
const playerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/player', component: PlayerPage })

export const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute, playerRoute]) })
router.subscribe('onResolved', (e) => logEvent(`route ${e.toLocation.pathname}`))

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
