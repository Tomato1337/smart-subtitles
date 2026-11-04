import { useEffect } from 'react'
import { notify } from '@/common/api/notify'
import { api, errorText, onEvent } from '@/common/api/tauri'
import { toast } from '@/common/ui/toast'
import { useCardsStore } from './store/cardsStore'

/**
 * Mirrors background Anki adds into the cards store for the live status UI, and notifies about
 * failures (with a retry), partial media and success.
 */
export function useCardEvents() {
 useEffect(() => {
  const un = [
   onEvent('cards:progress', (p) => useCardsStore.getState().progress(p)),
   onEvent('cards:result', (r) => {
    useCardsStore.getState().finish(r)
    const words = `«${r.words.join(', ')}»`
    if (r.error) {
     const retry = () => void api.cardsAdd(r.proposalId, r.indices).catch((e) => notify('error', errorText(e)))
     notify('error', `Anki: ${words} не добавлено — ${r.error}`, { durationMs: 12000, action: { label: 'Повторить', run: retry } })
    } else if (r.warnings.length) {
     notify('warn', `Anki: ${words} добавлено, но ${r.warnings.join('; ')}`, { durationMs: 8000 })
    } else {
     toast(`Anki: ${words} добавлено`, { placement: 'top' })
    }
   }),
  ]
  return () => { un.forEach((p) => void p.then((f) => f())) }
 }, [])
}
