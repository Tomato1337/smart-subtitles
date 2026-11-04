import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { onEvent } from '@/common/api/tauri'
import { toast } from '@/common/ui/toast'

/** A config saved by the UI or by an agent: refetch what depends on it, announce agent-made edits. */
export function useConfigEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    const un = onEvent('config:changed', ({ by }) => {
      void qc.invalidateQueries({ queryKey: ['config'] })
      void qc.invalidateQueries({ queryKey: ['llm-providers'] })
      void qc.invalidateQueries({ queryKey: ['setup'] })
      if (by === 'agent') toast('Настройки обновлены агентом')
    })
    return () => { void un.then((f) => f()) }
  }, [qc])
}
