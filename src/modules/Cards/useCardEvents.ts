import { useEffect } from 'react'
import { api, errorText, onEvent } from '@/common/api/tauri'
import { toast } from '@/common/ui/toast'

/** Notifies about background Anki adds that failed (with a retry) or lost some media. Success stays silent. */
export function useCardEvents() {
  useEffect(() => {
    const un = onEvent('cards:result', (r) => {
      const words = `«${r.words.join(', ')}»`
      if (r.error) {
        const retry = () => void api.cardsAdd(r.proposalId, r.indices).catch((e) => toast(errorText(e)))
        toast(`Anki: ${words} не добавлено — ${r.error}`, { durationMs: 12000, action: { label: 'Повторить', run: retry } })
      } else if (r.warnings.length) {
        toast(`Anki: ${words} добавлено, но ${r.warnings.join('; ')}`, { durationMs: 8000 })
      }
    })
    return () => { void un.then((f) => f()) }
  }, [])
}
