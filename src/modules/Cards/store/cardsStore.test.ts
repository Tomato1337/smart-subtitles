import { beforeEach, describe, expect, it } from 'vitest'
import type { CardJob, CardJobEditor, CardJobState } from '@/common/types/ipc'
import { graceRemaining, useCardsStore } from './cardsStore'

const JOB = (over: Partial<CardJob> & { id: string; state: CardJobState }): CardJob => ({
  origin: 'quick',
  proposalId: null,
  wordIndex: null,
  mediaId: 'm',
  cueIdx: 1,
  span: null,
  title: 'Film',
  cueText: 'It will bring joy.',
  cueStart: 1,
  word: 'bring',
  revision: 0,
  version: 1,
  remainingMs: 0,
  held: false,
  cancelRequested: false,
  draft: null,
  noteId: null,
  hasCommittedNote: false,
  image: null,
  phase: null,
  imageProvider: null,
  attempt: null,
  error: null,
  warnings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const EDITOR = (job: CardJob): CardJobEditor => ({ job, preview: null, fieldValues: null, baselineFields: null })

beforeEach(() => {
  useCardsStore.setState({
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
  })
})

describe('card job hydration', () => {
  it('never lets a late bootstrap overwrite a newer event', () => {
    const s = useCardsStore.getState()
    s.upsert(JOB({ id: 'a', state: 'generating', version: 3, word: 'newer' }))
    s.setPage({ items: [JOB({ id: 'a', state: 'queued', version: 1, word: 'older' })], activeJobs: [], nextCursor: null })
    expect(useCardsStore.getState().jobs.a.word).toBe('newer')
  })

  it('does not replace a row with an equal version', () => {
    const s = useCardsStore.getState()
    s.upsert(JOB({ id: 'a', state: 'queued', version: 2, word: 'first' }))
    s.upsert(JOB({ id: 'a', state: 'queued', version: 2, word: 'second' }))
    expect(useCardsStore.getState().jobs.a.word).toBe('first')
    s.setPage({ items: [JOB({ id: 'a', state: 'queued', version: 2, word: 'bootstrap' })], activeJobs: [], nextCursor: null })
    expect(useCardsStore.getState().jobs.a.word).toBe('first')
  })

  it('orders page rows and live active rows strictly by createdAt then id', () => {
    const s = useCardsStore.getState()
    s.setPage({
      items: [JOB({ id: 'b', state: 'added', version: 2, createdAt: 20 }), JOB({ id: 'a', state: 'added', version: 2, createdAt: 10 })],
      activeJobs: [],
      nextCursor: null,
    })
    expect(useCardsStore.getState().order).toEqual(['b', 'a'])
    s.upsert(JOB({ id: 'c', state: 'queued', createdAt: 30 }))
    expect(useCardsStore.getState().order).toEqual(['c', 'b', 'a'])
    s.upsert(JOB({ id: 'd', state: 'generating', createdAt: 15 }))
    expect(useCardsStore.getState().order).toEqual(['c', 'b', 'd', 'a'])
    // A terminal event for an old row that was never loaded is not history to show.
    s.upsert(JOB({ id: 'z', state: 'added', version: 9, createdAt: 5 }))
    expect(useCardsStore.getState().order).not.toContain('z')
  })

  it('hydrates all active jobs but counts only approved in-flight states', () => {
    const s = useCardsStore.getState()
    s.setPage({
      items: [JOB({ id: 'new', state: 'added', version: 2, createdAt: 30 }), JOB({ id: 'old', state: 'queued', createdAt: 20 })],
      activeJobs: [
        JOB({ id: 'old', state: 'queued', createdAt: 20 }),
        JOB({ id: 'edit', state: 'editing', createdAt: 10 }),
        JOB({ id: 'grace', state: 'grace', createdAt: 5 }),
      ],
      nextCursor: null,
    })
    expect(useCardsStore.getState().order).toEqual(['new', 'old', 'edit', 'grace'])
    expect(useCardsStore.getState().grace.grace).toMatchObject({ version: 1, tick: 0, remainingMs: 0 })
    // `editing` is a persisted explicit hold, not work in flight.
    expect(useCardsStore.getState().activeIds).toEqual(['old', 'grace'])
    s.upsert(JOB({ id: 'old', state: 'added', version: 3, createdAt: 20 }))
    expect(useCardsStore.getState().activeIds).toEqual(['grace'])
  })

  it('keeps loaded rows when the page fails and clears the error on a successful retry', () => {
    const s = useCardsStore.getState()
    s.setPage({ items: [JOB({ id: 'a', state: 'queued', version: 2 })], activeJobs: [], nextCursor: { createdAt: 1, id: 'a' } })
    s.setPageState(false, 'нет связи')
    expect(useCardsStore.getState().pageError).toBe('нет связи')
    expect(useCardsStore.getState().order).toEqual(['a'])
    s.setPage({ items: [JOB({ id: 'a', state: 'queued', version: 3 })], activeJobs: [], nextCursor: null })
    expect(useCardsStore.getState()).toMatchObject({ hydrated: true, pageLoading: false, pageError: null, cursor: null })
  })

  it('appends older pages without replacing newer events or the active set', () => {
    const s = useCardsStore.getState()
    s.setPage({
      items: [JOB({ id: 'b', state: 'queued', createdAt: 20 }), JOB({ id: 'a', state: 'added', version: 3, createdAt: 10 })],
      activeJobs: [JOB({ id: 'b', state: 'queued', createdAt: 20 })],
      nextCursor: { createdAt: 10, id: 'a' },
    })
    s.upsert(JOB({ id: 'a', state: 'failed', version: 4, createdAt: 10 }))
    s.appendPage({
      items: [JOB({ id: 'a', state: 'added', version: 1, createdAt: 10 }), JOB({ id: 'c', state: 'added', createdAt: 5 })],
      activeJobs: [],
      nextCursor: null,
    })
    expect(useCardsStore.getState().jobs.a.state).toBe('failed')
    expect(useCardsStore.getState().order).toEqual(['b', 'a', 'c'])
    expect(useCardsStore.getState().activeIds).toEqual(['b'])
    expect(useCardsStore.getState().cursor).toBeNull()
  })
})

describe('grace deltas', () => {
  it('buffers a future-version tick until its full job arrives', () => {
    const s = useCardsStore.getState()
    s.upsert(JOB({ id: 'g', state: 'grace', version: 2, remainingMs: 4000 }))
    s.setGrace({ jobId: 'g', version: 3, tick: 5, remainingMs: 3000, held: false })
    expect(useCardsStore.getState().grace.g?.remainingMs).toBe(4000)
    expect(useCardsStore.getState().grace.g?.tick).toBe(0)
    s.upsert(JOB({ id: 'g', state: 'grace', version: 3, remainingMs: 3000 }))
    expect(useCardsStore.getState().grace.g?.tick).toBe(5)
    expect(useCardsStore.getState().grace.g?.remainingMs).toBe(3000)
    s.setGrace({ jobId: 'g', version: 3, tick: 4, remainingMs: 100, held: false })
    expect(useCardsStore.getState().grace.g?.remainingMs).toBe(3000)
  })

  it('applies a same-version hold delta over the full row', () => {
    const s = useCardsStore.getState()
    s.upsert(JOB({ id: 'g', state: 'grace', version: 2, remainingMs: 4000, held: true }))
    s.setGrace({ jobId: 'g', version: 2, tick: 1, remainingMs: 4000, held: false })
    expect(useCardsStore.getState().grace.g).toMatchObject({ tick: 1, held: false })
  })

  it('never buffers a tick of a non-grace job and drops buffered ticks when it leaves grace', () => {
    const s = useCardsStore.getState()
    s.upsert(JOB({ id: 'q', state: 'queued', version: 2 }))
    s.setGrace({ jobId: 'q', version: 3, tick: 1, remainingMs: 2000, held: false })
    expect(useCardsStore.getState().pendingGrace.q).toBeUndefined()
    s.upsert(JOB({ id: 'g', state: 'grace', version: 2 }))
    s.setGrace({ jobId: 'g', version: 4, tick: 1, remainingMs: 2000, held: false })
    expect(useCardsStore.getState().pendingGrace.g).toHaveLength(1)
    s.upsert(JOB({ id: 'g', state: 'queued', version: 4 }))
    expect(useCardsStore.getState().pendingGrace.g).toBeUndefined()
    expect(useCardsStore.getState().grace.g).toBeUndefined()
  })

  it('settles a buffered future tick when the page delivers its full row', () => {
    const s = useCardsStore.getState()
    s.setGrace({ jobId: 'g', version: 3, tick: 5, remainingMs: 3200, held: true })
    expect(useCardsStore.getState().pendingGrace.g).toHaveLength(1)
    s.setPage({
      items: [JOB({ id: 'g', state: 'grace', version: 3, remainingMs: 3000, createdAt: 2 })],
      activeJobs: [JOB({ id: 'g', state: 'grace', version: 3, remainingMs: 3000, createdAt: 2 })],
      nextCursor: null,
    })
    expect(useCardsStore.getState().grace.g).toMatchObject({ version: 3, tick: 5, remainingMs: 3200, held: true })
    expect(useCardsStore.getState().pendingGrace.g).toBeUndefined()
  })

  it('keeps the remaining grace while held and counts it down otherwise', () => {
    const at = 1000
    const held = { version: 1, tick: 1, remainingMs: 3000, at, held: true }
    expect(graceRemaining(held, at + 5000)).toBe(3000)
    const running = { ...held, held: false }
    expect(graceRemaining(running, at + 2000)).toBe(1000)
    expect(graceRemaining(running, at + 9000)).toBe(0)
  })
})

describe('task identity and editor snapshots', () => {
  it('treats an already-added match as recent-card access, not a new task', () => {
    useCardsStore.getState().trackTask(JOB({ id: 'done', state: 'added', hasCommittedNote: true, createdAt: 8 }))
    expect(useCardsStore.getState().task).toBeNull()
    expect(useCardsStore.getState().activityOpen).toBe(true)
    expect(useCardsStore.getState().order).toEqual(['done'])
  })

  it('never lets a stale presenter write its toast id onto a newer task', () => {
    const s = useCardsStore.getState()
    s.trackTask(JOB({ id: 'a', state: 'queued' }))
    s.setToastId('a', 7)
    expect(useCardsStore.getState().task).toEqual({ jobId: 'a', toastId: 7 })
    s.trackTask(JOB({ id: 'b', state: 'generating' }))
    s.setToastId('a', 8)
    expect(useCardsStore.getState().task).toEqual({ jobId: 'b', toastId: null })
    s.setToastId('b', 9)
    expect(useCardsStore.getState().task).toEqual({ jobId: 'b', toastId: 9 })
  })

  it('stores the editor response without changing the backend hold on close', () => {
    const job = JOB({ id: 'e', state: 'editing', hasCommittedNote: true, version: 2 })
    useCardsStore.getState().trackTask(job)
    expect(useCardsStore.getState().task).toEqual({ jobId: 'e', toastId: null })
    useCardsStore.getState().openEditor(EDITOR(job))
    expect(useCardsStore.getState()).toMatchObject({ editorJobId: 'e', activityOpen: false, task: null })
    useCardsStore.getState().closeEditor()
    expect(useCardsStore.getState().editor).toBeNull()
    expect(useCardsStore.getState().editorJobId).toBeNull()
    expect(useCardsStore.getState().jobs.e.state).toBe('editing')
  })
})
