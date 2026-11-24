import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api, onEvent } from '@/common/api/tauri'
import type { StatsPeriod } from '@/common/types/ipc'

export function useStatsOverview(period: StatsPeriod) {
  const qc = useQueryClient()

  useEffect(() => {
    let alive = true
    const off: (() => void)[] = []
    const refresh = () => void qc.invalidateQueries({ queryKey: ['stats'] })
    void onEvent('anki:index', refresh).then((fn) => (alive ? off.push(fn) : fn()))
    void onEvent('cards:job', refresh).then((fn) => (alive ? off.push(fn) : fn()))
    return () => {
      alive = false
      for (const fn of off) fn()
    }
  }, [qc])

  return useQuery({
    queryKey: ['stats', period],
    queryFn: () => api.statsOverview(period),
    staleTime: 15_000,
  })
}

export function usePatternExamples(patternId: string | null) {
  return useQuery({
    queryKey: ['stats-pattern-examples', patternId],
    queryFn: () => api.statsPatternExamples(patternId!, 15),
    enabled: Boolean(patternId),
    staleTime: 30_000,
  })
}
