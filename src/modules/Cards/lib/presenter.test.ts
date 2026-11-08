import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardJob, CardJobEditor, CardJobState } from '@/common/types/ipc'
import { useCardsStore } from '../store/cardsStore'
import { islandSurface, type IslandOptions, type IslandPatch, type IslandSurface } from './island'
import { Presenter, type PresenterApi } from './presenter'

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
const OTHER: IslandOptions = { icon: 'add_card', word: 'other', mini: '', pinned: false, durationMs: null }
const shown = () => islandSurface.current()

function surface() {
  const updates: IslandPatch[] = []
  const announced: string[] = []
  const api: IslandSurface = {
    ...islandSurface,
    update: (id, patch) => {
      updates.push(patch)
      islandSurface.update(id, patch)
    },
    announce: (message) => announced.push(message),
  }
  return { api, updates, announced }
}

function fakeApi(): PresenterApi {
  return {
    cardsJobCancel: async () => {
      throw new Error('unexpected cancel')
    },
    cardsJobDelete: async () => {
      throw new Error('unexpected delete')
    },
    cardsJobEdit: async () => {
      throw new Error('unexpected edit')
    },
    cardsJobRetry: async () => {
      throw new Error('unexpected retry')
    },
  }
}

beforeEach(() => {
  islandSurface.hide()
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

describe('card task presenter', () => {
  it('changes the dismissal window only on a state transition', () => {
    const job = JOB({ id: 'j', state: 'generating', phase: 'image', imageProvider: 'openai', attempt: 1 })
    useCardsStore.getState().upsert(job)
    useCardsStore.getState().trackTask(job)
    const s = surface()
    const presenter = new Presenter('j', { surface: s.api, api: fakeApi(), notify: vi.fn(), sendHold: async () => undefined })
    presenter.render()
    expect(shown().options.durationMs).toBeNull()

    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'generating', version: 2, phase: 'image', imageProvider: 'gemini', attempt: 2 }))
    presenter.render()
    expect(s.updates.at(-1)?.options?.durationMs).toBeUndefined()
    expect(shown().message).toContain('gemini')
    expect(shown().message).toContain('попытка 2')
    expect(s.announced.at(-1)).toContain('gemini')

    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'added', version: 3, hasCommittedNote: true }))
    presenter.render()
    expect(s.updates.at(-1)?.options?.durationMs).toBe(10_000)
    expect(shown().options.actions?.map((a) => a.label)).toEqual(['Редактировать', 'Удалить из Anki'])

    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'added', version: 4, hasCommittedNote: true, phase: 'sync' }))
    presenter.render()
    expect(s.updates.at(-1)?.options?.durationMs).toBeUndefined()
  })

  it('collapses only while the card is being produced', () => {
    const job = JOB({ id: 'j', state: 'grace', remainingMs: 5000 })
    useCardsStore.getState().upsert(job)
    useCardsStore.getState().trackTask(job)
    const presenter = new Presenter('j', { surface: surface().api, api: fakeApi(), notify: vi.fn(), sendHold: async () => undefined })
    presenter.render()
    expect(shown().options).toMatchObject({ pinned: true, steps: undefined })

    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'generating', version: 2, phase: 'image' }))
    presenter.render()
    expect(shown().options).toMatchObject({ pinned: false, steps: { current: 3, total: 5 }, mini: 'картинка', word: 'bring' })

    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'failed', version: 3, error: 'нет Anki' }))
    presenter.render()
    expect(shown().options).toMatchObject({ pinned: true, steps: undefined, tone: 'error' })
  })

  it('never updates, announces or revives a replaced or hidden message', () => {
    const job = JOB({ id: 'j', state: 'grace', remainingMs: 5000 })
    useCardsStore.getState().upsert(job)
    useCardsStore.getState().trackTask(job)
    const s = surface()
    const presenter = new Presenter('j', { surface: s.api, api: fakeApi(), notify: vi.fn(), sendHold: async () => undefined })
    presenter.render()
    const oldId = presenter.toastId!
    islandSurface.show('Новая задача', OTHER)
    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'generating', version: 2, phase: 'image' }))
    presenter.render()
    expect(s.updates).toHaveLength(0)
    expect(s.announced).toHaveLength(0)
    expect(shown().message).toBe('Новая задача')
    presenter.dispose()
    expect(shown().message).toBe('Новая задача')

    islandSurface.hide()
    islandSurface.show('Ещё одна', OTHER)
    expect(oldId).not.toBe(shown().seq)
  })

  it('does not resurrect a confirmation after its own dismissal time', () => {
    const job = JOB({ id: 'j', state: 'queued' })
    useCardsStore.getState().upsert(job)
    useCardsStore.getState().trackTask(job)
    const s = surface()
    const presenter = new Presenter('j', { surface: s.api, api: fakeApi(), notify: vi.fn(), sendHold: async () => undefined })
    presenter.render()
    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'added', version: 2, hasCommittedNote: true }))
    presenter.render()
    islandSurface.hide(presenter.toastId!)
    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'added', version: 3, hasCommittedNote: true }))
    presenter.render()
    expect(shown().message).toBeNull()
    expect(s.updates).toHaveLength(1)
    expect(s.announced.at(-1)).toContain('добавлено')
  })

  it('reads the latest revision at click time and stays pending until Anki confirms', async () => {
    const job = JOB({ id: 'j', state: 'grace', remainingMs: 5000 })
    useCardsStore.getState().upsert(job)
    useCardsStore.getState().trackTask(job)
    const s = surface()
    const pending = Promise.withResolvers<CardJob>()
    const cancel = vi.fn((_id: string, _revision: number) => pending.promise)
    const api = { ...fakeApi(), cardsJobCancel: cancel }
    const presenter = new Presenter('j', { surface: s.api, api, notify: vi.fn(), sendHold: async () => undefined })
    presenter.render()
    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'grace', version: 2, revision: 7, remainingMs: 4000 }))
    presenter.render()
    const running = shown().options.actions?.[0]?.run()
    expect(cancel).toHaveBeenCalledWith('j', 7)
    // The call is still pending: the island must not claim a cancellation yet.
    expect(shown().message).not.toContain('отменено')
    expect(shown().options.durationMs).toBeNull()
    pending.resolve(JOB({ id: 'j', state: 'cancel_requested', version: 3, revision: 8, cancelRequested: true }))
    await running
    expect(shown().message).not.toContain('отменено')
    expect(shown().options.durationMs).toBeNull()
    expect(shown().options.actions).toBeUndefined()

    useCardsStore.getState().upsert(JOB({ id: 'j', state: 'cancelled', version: 4, revision: 9 }))
    presenter.render()
    expect(shown().message).toContain('отменено')
    expect(shown().options.durationMs).toBe(4_000)
  })

  it('awaits the edit acknowledgment before hiding and opening the editor', async () => {
    const job = JOB({ id: 'j', state: 'grace', remainingMs: 5000 })
    useCardsStore.getState().upsert(job)
    useCardsStore.getState().trackTask(job)
    const s = surface()
    const edit = Promise.withResolvers<CardJobEditor>()
    const api = { ...fakeApi(), cardsJobEdit: vi.fn(() => edit.promise) }
    const presenter = new Presenter('j', { surface: s.api, api, notify: vi.fn(), sendHold: async () => undefined })
    presenter.render()
    const editing = shown().options.actions?.at(1)?.run()
    expect(shown().message).not.toBeNull()
    edit.resolve(EDITOR(JOB({ id: 'j', state: 'editing', version: 2 })))
    await editing
    expect(shown().message).toBeNull()
    expect(useCardsStore.getState().editorJobId).toBe('j')
  })

  it('keeps a truthful task visible when an action is rejected', async () => {
    const job = JOB({ id: 'j', state: 'failed', error: 'нет Anki' })
    useCardsStore.getState().upsert(job)
    useCardsStore.getState().trackTask(job)
    const s = surface()
    const notify = vi.fn()
    const api = { ...fakeApi(), cardsJobRetry: vi.fn(async () => Promise.reject(new Error('нет связи'))) }
    const presenter = new Presenter('j', { surface: s.api, api, notify, sendHold: async () => undefined })
    presenter.render()
    await shown().options.actions?.[0]?.run()
    expect(notify).toHaveBeenCalledWith('нет связи')
    expect(shown().message).toContain('нет Anki')
    expect(shown().options.durationMs).toBe(12_000)
  })
})
