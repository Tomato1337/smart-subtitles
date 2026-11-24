import { useCanGoBack, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import type { StatsPeriod } from '@/common/types/ipc'
import { normalizePeriod, normalizeTab, StatsHub, type StatsTab } from '@/modules/Stats'

/** Full-page Learning Statistics route (`/stats?tab=...&period=...`). */
export function StatsPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const scrollRef = useRef<HTMLDivElement>(null)

  const tab = normalizeTab(search.tab)
  const period = normalizePeriod(search.period)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const updateSearch = useCallback(
    (nextTab: StatsTab, nextPeriod: StatsPeriod) => {
      void navigate({
        to: '/stats',
        search: {
          tab: nextTab === 'immersion' ? undefined : nextTab,
          period: nextPeriod === '30d' ? undefined : nextPeriod,
        },
        replace: true,
      })
    },
    [navigate],
  )

  const onBack = useCallback(() => {
    if (canGoBack) router.history.back()
    else void navigate({ to: '/' })
  }, [canGoBack, router, navigate])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-clip bg-[var(--md-sys-color-surface)]">
      <StatsHub
        tab={tab}
        period={period}
        onChangeTab={(next) => updateSearch(next, period)}
        onChangePeriod={(next) => updateSearch(tab, next)}
        onBack={onBack}
        onGoHome={() => void navigate({ to: '/' })}
        onOpenLevelSettings={() => void navigate({ to: '/settings', search: { section: 'level', focus: 'learner.cefr' } })}
      />
    </div>
  )
}
