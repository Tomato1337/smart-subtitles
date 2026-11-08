import { create } from 'zustand'
import type { CardJob, CardJobEditor, JobCursor, JobGrace } from '@/common/types/ipc'

/** States the activity button counts as work in flight; an explicit editor hold is not work. */
export const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'grace', 'queued', 'drafting', 'generating', 'committing', 'resolving', 'cancel_requested', 'deleting',
])

/** The displayed grace clock of one job; `remainingMs` is the last authoritative snapshot. */
export type GraceView = { version: number; tick: number; remainingMs: number; at: number; held: boolean }

/** What the card island is showing; `toastId` is the island's message identity (`seq`). */
export type CardTask = { jobId: string; toastId: number | null }

export type CardPage = { items: CardJob[]; activeJobs: CardJob[]; nextCursor: JobCursor | null }

type CardsStore = {
  /** The open job editor, if any. Closing it never leaves the backend editing hold. */
  editor: CardJobEditor | null
  editorJobId: string | null
  jobs: Record<string, CardJob>
  /** Visible jobs, newest first by `(createdAt, id)`; page rows plus live active work. */
  order: string[]
  /** Known jobs the activity button counts. */
  activeIds: string[]
  cursor: JobCursor | null
  hydrated: boolean
  pageLoading: boolean
  pageError: string | null
  activityOpen: boolean
  task: CardTask | null
  grace: Record<string, GraceView>
  /** Deltas whose version is newer than the loaded job: buffered until that full row arrives. */
  pendingGrace: Record<string, JobGrace[]>
  openEditor: (editor: CardJobEditor) => void
  setEditor: (editor: CardJobEditor) => void
  closeEditor: () => void
  setActivityOpen: (open: boolean) => void
  upsert: (job: CardJob) => void
  setPage: (page: CardPage) => void
  appendPage: (page: CardPage) => void
  setPageState: (loading: boolean, error?: string | null) => void
  setGrace: (delta: JobGrace) => void
  trackTask: (job: CardJob) => void
  setToastId: (jobId: string, id: number | null) => void
  clearTask: (jobId?: string) => void
}

/** Milliseconds left on a grace job, from the latest backend snapshot and the local clock. */
export function graceRemaining(g: GraceView, now: number = performance.now()): number {
  if (g.held) return g.remainingMs
  return Math.max(0, g.remainingMs - (now - g.at))
}

/** The page and the UI use one order: descending `(created_at, id)`. */
function newestFirst(a: CardJob, b: CardJob): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

function sortedIds(jobs: Record<string, CardJob>, ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => jobs[id]).sort((a, b) => newestFirst(jobs[a], jobs[b]))
}

/** An explicit editor/toast row must be reachable even if it is not an active page row. */
function visibleOrder(jobs: Record<string, CardJob>, order: string[], job: CardJob): string[] {
  return order.includes(job.id) ? order : sortedIds({ ...jobs, [job.id]: job }, [...order, job.id])
}

function activeIds(jobs: Record<string, CardJob>): string[] {
  return sortedIds(jobs, Object.values(jobs).filter((j) => ACTIVE_STATES.has(j.state)).map((j) => j.id))
}

/** A page can deliver the full row that a buffered future grace tick was waiting for. */
function settleGrace(
  jobs: Record<string, CardJob>,
  grace: Record<string, GraceView>,
  pendingGrace: Record<string, JobGrace[]>,
  ids: Iterable<string>,
): { grace: Record<string, GraceView>; pendingGrace: Record<string, JobGrace[]> } {
  let nextGrace = grace
  let nextPending = pendingGrace
  for (const id of ids) {
    const job = jobs[id]
    if (!job) continue
    if (job.state !== 'grace') {
      if (nextGrace[id] || nextPending[id]) {
        nextGrace = { ...nextGrace }
        delete nextGrace[id]
        nextPending = { ...nextPending }
        delete nextPending[id]
      }
      continue
    }
    // An existing clock of this version is authoritative; a repeated page must not rewind it.
    if (nextGrace[id]?.version === job.version) continue
    const buffered = nextPending[id] ?? []
    const settled = graceFor(job, buffered, nextGrace[id], performance.now())
    if (settled.view) nextGrace = { ...nextGrace, [id]: settled.view }
    nextPending = { ...nextPending }
    if (settled.pending.length) nextPending[id] = settled.pending
    else delete nextPending[id]
  }
  return { grace: nextGrace, pendingGrace: nextPending }
}

const MAX_PENDING_GRACE = 12

/** Keeps only deltas that can still matter: future versions, newest tick first. */
function bufferGrace(list: JobGrace[], delta: JobGrace): JobGrace[] {
  const next = list.filter((d) => d.version > delta.version || (d.version === delta.version && d.tick > delta.tick))
  next.push(delta)
  return next.sort((a, b) => a.version - b.version || a.tick - b.tick).slice(-MAX_PENDING_GRACE)
}

/** Applies the buffered delta of exactly the row's version and drops stale/non-applicable ones. */
function graceFor(job: CardJob, pending: JobGrace[], current: GraceView | undefined, now: number): { view?: GraceView; pending: JobGrace[] } {
  if (job.state !== 'grace') return { pending: [] }
  const exact = pending.filter((d) => d.version === job.version).sort((a, b) => b.tick - a.tick)[0]
  const future = pending.filter((d) => d.version > job.version)
  if (exact) {
    return {
      view: { version: job.version, tick: exact.tick, remainingMs: exact.remainingMs, at: now, held: exact.held },
      pending: future,
    }
  }
  return {
    view: {
      version: job.version,
      tick: current?.version === job.version ? current.tick : 0,
      remainingMs: job.remainingMs,
      at: now,
      held: job.held,
    },
    pending: future,
  }
}

export const useCardsStore = create<CardsStore>((set, get) => ({
  editor: null,
  editorJobId: null,
  jobs: {},
  order: [],
  activeIds: [],
  cursor: null,
  hydrated: false,
  pageLoading: false,
  pageError: null,
  activityOpen: false,
  task: null,
  grace: {},
  pendingGrace: {},
  openEditor: (editor) => {
    get().upsert(editor.job)
    set((s) => ({
      editor,
      editorJobId: editor.job.id,
      activityOpen: false,
      task: s.task?.jobId === editor.job.id ? null : s.task,
      order: visibleOrder(s.jobs, s.order, editor.job),
    }))
  },
  setEditor: (editor) => {
    get().upsert(editor.job)
    set((s) => ({
      editor,
      editorJobId: editor.job.id,
      order: visibleOrder(s.jobs, s.order, editor.job),
    }))
  },
  closeEditor: () => set({ editor: null, editorJobId: null }),
  setActivityOpen: (activityOpen) => set({ activityOpen }),
  upsert: (job) =>
    set((s) => {
      const prev = s.jobs[job.id]
      // SQLite owns the version; an equal row may be a stale bootstrap copy.
      if (prev && prev.version >= job.version) return s
      const jobs = { ...s.jobs, [job.id]: job }
      const wasActive = prev ? ACTIVE_STATES.has(prev.state) : false
      const visible = s.order.includes(job.id) || ACTIVE_STATES.has(job.state) || wasActive || s.task?.jobId === job.id
      // A terminal event for an old row that was never loaded does not widen the page.
      const order = visible ? sortedIds(jobs, [...s.order, job.id]) : s.order
      let grace = s.grace
      let pendingGrace = s.pendingGrace
      if (job.state === 'grace') {
        const buffered = s.pendingGrace[job.id] ?? []
        const next = graceFor(job, buffered, grace[job.id], performance.now())
        if (next.view) grace = { ...grace, [job.id]: next.view }
        pendingGrace = { ...s.pendingGrace }
        if (next.pending.length) pendingGrace[job.id] = next.pending
        else delete pendingGrace[job.id]
      } else if (grace[job.id] || s.pendingGrace[job.id]) {
        // Leaving grace invalidates both the clock and any future grace tick.
        grace = { ...grace }
        delete grace[job.id]
        pendingGrace = { ...s.pendingGrace }
        delete pendingGrace[job.id]
      }
      return { jobs, order, activeIds: activeIds(jobs), grace, pendingGrace }
    }),
  setPage: (page) =>
    set((s) => {
      const jobs = { ...s.jobs }
      const ids = [...s.order]
      for (const job of [...page.items, ...page.activeJobs]) {
        const prev = jobs[job.id]
        // A late first fetch must never overwrite a newer event.
        if (!prev || prev.version < job.version) jobs[job.id] = job
        if (!ids.includes(job.id)) ids.push(job.id)
      }
      const settled = settleGrace(jobs, s.grace, s.pendingGrace, ids)
      return {
        jobs,
        order: sortedIds(jobs, ids),
        activeIds: activeIds(jobs),
        grace: settled.grace,
        pendingGrace: settled.pendingGrace,
        cursor: page.nextCursor,
        hydrated: true,
        pageLoading: false,
        pageError: null,
      }
    }),
  appendPage: (page) =>
    set((s) => {
      const jobs = { ...s.jobs }
      const ids = [...s.order]
      for (const job of page.items) {
        const prev = jobs[job.id]
        if (!prev || prev.version < job.version) jobs[job.id] = job
        if (!ids.includes(job.id)) ids.push(job.id)
      }
      const settled = settleGrace(jobs, s.grace, s.pendingGrace, ids)
      // Later pages carry no active rows: the event-hydrated ones simply stay.
      return {
        jobs,
        order: sortedIds(jobs, ids),
        activeIds: activeIds(jobs),
        grace: settled.grace,
        pendingGrace: settled.pendingGrace,
        cursor: page.nextCursor,
        pageLoading: false,
        pageError: null,
      }
    }),
  setPageState: (pageLoading, pageError = null) => set({ pageLoading, pageError }),
  setGrace: (d) =>
    set((s) => {
      const job = s.jobs[d.jobId]
      if (!job) {
        // No row yet: a future delta waits for its full version.
        return { pendingGrace: { ...s.pendingGrace, [d.jobId]: bufferGrace(s.pendingGrace[d.jobId] ?? [], d) } }
      }
      if (job.state !== 'grace') return s
      if (d.version > job.version) {
        return { pendingGrace: { ...s.pendingGrace, [d.jobId]: bufferGrace(s.pendingGrace[d.jobId] ?? [], d) } }
      }
      if (d.version < job.version) return s
      const current = s.grace[d.jobId]
      if (current && current.tick >= d.tick) return s
      return {
        grace: {
          ...s.grace,
          [d.jobId]: { version: d.version, tick: d.tick, remainingMs: d.remainingMs, at: performance.now(), held: d.held },
        },
      }
    }),
  trackTask: (job) => {
    get().upsert(job)
    // A matching already-added row is recent-card access, not a new task toast.
    if (job.state === 'added') {
      set((s) => ({ activityOpen: true, order: visibleOrder(s.jobs, s.order, job) }))
      return
    }
    set((s) => ({
      task: { jobId: job.id, toastId: s.task?.jobId === job.id ? s.task.toastId : null },
      order: visibleOrder(s.jobs, s.order, job),
    }))
  },
  setToastId: (jobId, toastId) =>
    set((s) => (s.task?.jobId === jobId ? { task: { jobId, toastId } } : s)),
  clearTask: (jobId) => set((s) => (s.task && (!jobId || s.task.jobId === jobId) ? { task: null } : s)),
}))
