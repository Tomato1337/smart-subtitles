import { createRootRoute, createRoute, createRouter, Outlet, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Snackbar } from '@/common/ui/Snackbar'
import { useCardEvents } from '@/modules/Cards'
import { useSessionEvents } from '@/modules/Session'
import { useInirTheme } from '@/modules/Theme'
import { HomePage } from '@/pages/home'
import { PlayerPage } from '@/pages/player'

function Root() {
  const navigate = useNavigate()
  const opened = useCallback(() => void navigate({ to: '/player' }), [navigate])
  useSessionEvents(opened)
  useCardEvents()
  useInirTheme()
  return (
    <>
      <Outlet />
      <Snackbar />
    </>
  )
}

const rootRoute = createRootRoute({ component: Root })
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage })
const playerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/player', component: PlayerPage })

export const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute, playerRoute]) })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
