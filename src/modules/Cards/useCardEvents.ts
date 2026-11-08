import { useEffect } from 'react'
import { toast } from '@tomato1337/m3e-react'
import { api, errorText, onEvent } from '@/common/api/tauri'
import { islandSurface, useIslandStore } from './lib/island'
import { Presenter } from './lib/presenter'
import { useCardsStore } from './store/cardsStore'

type PresenterEntry = { presenter: Presenter; refs: number }

/**
 * Presenters outlive one effect run: React StrictMode's setup→cleanup→setup must reuse the same
 * message instead of creating a second toast and hold lease.
 */
const presenters = new Map<string, PresenterEntry>()

function attachPresenter(jobId: string): Presenter {
 const entry = presenters.get(jobId)
 if (entry) {
  entry.refs += 1
  return entry.presenter
 }
 const created: PresenterEntry = { presenter: new Presenter(jobId), refs: 1 }
 presenters.set(jobId, created)
 return created.presenter
}

function detachPresenter(jobId: string) {
 const entry = presenters.get(jobId)
 if (!entry) return
 entry.refs -= 1
 if (entry.refs > 0) return
 // A real unmount has no synchronous re-attach; StrictMode does, and cancels this microtask.
 queueMicrotask(() => {
  const current = presenters.get(jobId)
  if (current !== entry || current.refs > 0) return
  presenters.delete(jobId)
  entry.presenter.dispose()
 })
}

/**
 * Mirrors durable card jobs into the store and keeps the island of the current job alive.
 * Root-mounted: a missing listener loses no state, because SQLite owns it.
 */
export function useCardEvents() {
 useEffect(() => {
  let alive = true
  let unlisten: Array<() => void> = []
  const store = useCardsStore.getState()
  store.setPageState(true, null)
  // Subscribe before asking for the page, so an event emitted during bootstrap is not lost.
  const listeners = [
   onEvent('cards:job', (job) => useCardsStore.getState().upsert(job)),
   onEvent('cards:grace', (delta) => useCardsStore.getState().setGrace(delta)),
   onEvent('cards:result', (r) => {
    const state = useCardsStore.getState()
    // Errors and warnings are already persisted by the backend; this only reports a clean batch.
    if (!r.error && r.warnings.length === 0 && r.cancelled === 0 && r.added > 0 && !state.task) {
     toast(`Anki: «${r.words.join(', ')}» добавлено`, { icon: 'task_alt' })
    }
   }),
  ]
  const attached = listeners.map((pending) =>
   pending
    .then((un) => {
     if (alive) unlisten.push(un)
     else un()
    })
    .catch(() => undefined),
  )
  void Promise.all(attached).then(() => {
   if (!alive) return
   // Subscribe before asking for the page, so an event emitted during bootstrap is not lost.
   return api
    .cardsJobs(null)
    .then((page) => {
     if (alive) useCardsStore.getState().setPage(page)
    })
    .catch((e) => {
     if (alive) useCardsStore.getState().setPageState(false, errorText(e))
    })
  })
  return () => {
   alive = false
   unlisten.forEach((un) => un())
   unlisten = []
  }
 }, [])

 // The island follows the wanted job until it is replaced, hidden or finished.
 const task = useCardsStore((s) => s.task)
 const jobId = task?.jobId ?? null
 const version = useCardsStore((s) => (jobId ? s.jobs[jobId]?.version : undefined))
 const state = useCardsStore((s) => (jobId ? s.jobs[jobId]?.state : undefined))
 const phase = useCardsStore((s) => (jobId ? s.jobs[jobId]?.phase : undefined))

 useEffect(() => {
  if (!jobId) return
  const presenter = attachPresenter(jobId)
  presenter.render()
  return () => detachPresenter(jobId)
 }, [jobId])

 // A hidden or replaced island ends the current task; no React render happens on island updates.
 useEffect(() => {
  const unsubscribe = useIslandStore.subscribe(() => {
   const state = useCardsStore.getState()
   if (!state.task || state.task.toastId === null) return
   const shown = islandSurface.current()
   if (shown.message === null || shown.seq !== state.task.toastId) state.clearTask(state.task.jobId)
  })
  return () => {
   unsubscribe()
  }
 }, [])

 useEffect(() => {
  if (!jobId) return
  presenters.get(jobId)?.presenter.render()
 }, [jobId, version, state, phase])

 // The countdown text changes once per second while the job is in grace.
 useEffect(() => {
  if (!jobId || state !== 'grace') return
  const timer = window.setInterval(() => presenters.get(jobId)?.presenter.render(), 1000)
  return () => window.clearInterval(timer)
 }, [jobId, state])
}
