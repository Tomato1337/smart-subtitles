import { createRootRoute, createRoute, createRouter, Outlet, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { logEvent } from '@/common/api/eventLog'
import { CardDraftModal, CardIsland, CardsActivityPanel, useCardEvents } from '@/modules/Cards'
import { NotificationCenter, useNotificationEvents } from '@/modules/Notifications'
import { useSessionEvents } from '@/modules/Session'
import { useConfigEvents, useDepsCheck } from '@/modules/Settings'
import { useInirTheme } from '@/modules/Theme'
import { SnackbarHost } from './SnackbarHost'
import { HomePage } from '@/pages/home'
import { PlayerPage } from '@/pages/player'
import { SettingsPage } from '@/pages/settings'
import { StatsPage } from '@/pages/stats'

function Root() {
  const navigate = useNavigate()
  const opened = useCallback(() => void navigate({ to: '/player' }), [navigate])
  useSessionEvents(opened)
  useCardEvents()
  useConfigEvents()
  useDepsCheck()
  useInirTheme()
  useNotificationEvents()
  return (
    <>
      <Outlet />
      <SnackbarHost />
      <CardIsland />
      <CardsActivityPanel />
      <CardDraftModal />
      <NotificationCenter />
    </>
  )
}

export type SettingsSearch = {
  section?: string
  focus?: string
}

export type StatsSearch = {
  tab?: string
  period?: string
}

const rootRoute = createRootRoute({ component: Root })
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage })
const playerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/player', component: PlayerPage })
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    section: typeof search.section === 'string' && search.section ? search.section : undefined,
    focus: typeof search.focus === 'string' && search.focus ? search.focus : undefined,
  }),
  component: SettingsPage,
})
const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stats',
  validateSearch: (search: Record<string, unknown>): StatsSearch => ({
    tab: typeof search.tab === 'string' && search.tab ? search.tab : undefined,
    period: typeof search.period === 'string' && search.period ? search.period : undefined,
  }),
  component: StatsPage,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, playerRoute, settingsRoute, statsRoute]),
})
router.subscribe('onResolved', (e) => logEvent(`route ${e.toLocation.pathname}`))

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
