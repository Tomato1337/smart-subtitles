import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand/vanilla'
import type { CardJob, CardJobEditor } from '@/common/types/ipc'
import { useCardsStore } from '../store/cardsStore'

const { invokeMock, notifyMock, captured } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  notifyMock: vi.fn(),
  captured: {
    dialogOnClose: null as (() => void) | null,
    buttons: new Map<string, () => void>(),
  },
}))

vi.mock('zustand', async () => {
  const { createStore } = await vi.importActual<typeof import('zustand/vanilla')>('zustand/vanilla')
  return {
    create: (initializer: StateCreator<unknown>) => {
      const store = createStore(initializer)
      const useBound = (selector: (state: unknown) => unknown = (s) => s) => selector(store.getState())
      return Object.assign(useBound, store)
    },
  }
})
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))
vi.mock('@/common/api/eventLog', () => ({
  logEvent: vi.fn(),
}))
vi.mock('@/common/api/notify', () => ({
  notify: notifyMock,
}))
vi.mock('@/modules/Vocab', () => ({
  VocabBadges: () => null,
  useVocabLookup: () => ({ data: undefined }),
}))
vi.mock('@tomato1337/m3e-react', () => ({
  Presence: ({ children }: { children?: ReactNode }) => children ?? null,
  Dialog: ({ onClose, children }: { onClose?: () => void; children?: ReactNode }) => {
    captured.dialogOnClose = onClose ?? null
    return <dialog open>{children}</dialog>
  },
  Button: ({ onClick, children }: { onClick?: () => void; children?: ReactNode }) => {
    if (typeof children === 'string' && onClick) captured.buttons.set(children, onClick)
    return <button type="button">{children}</button>
  },
  Spinner: () => null,
  TextField: () => null,
  toast: vi.fn(),
}))

import { CardDraftModal } from './CardDraftModal'

function makeJob(over: Partial<CardJob> = {}): CardJob {
  return {
    id: 'job-edit-1',
    origin: 'review',
    proposalId: null,
    wordIndex: null,
    mediaId: 'm1',
    cueIdx: 1,
    span: 'bring',
    title: 'Film',
    cueText: 'It will bring joy.',
    cueStart: 1,
    word: 'bring',
    state: 'editing',
    revision: 1,
    version: 1,
    remainingMs: 0,
    held: false,
    cancelRequested: false,
    draft: {
      word: 'bring',
      translation: 'приносить',
      word_type: 'verb',
      cloze_sentence: 'It will {{c1::bring}} joy.',
      full_sentence: 'It will bring joy.',
      sentence_translation: 'Это принесёт радость.',
      image_prompt: 'A warm scene.',
    },
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
  }
}

function renderModal(editor: CardJobEditor, onDismissModal?: (jobId: string) => Promise<void> | void) {
  useCardsStore.getState().openEditor(editor)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <CardDraftModal onDismissModal={onDismissModal} />
    </QueryClientProvider>,
  )
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  invokeMock.mockReset()
  notifyMock.mockReset()
  captured.dialogOnClose = null
  captured.buttons.clear()
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

describe('CardDraftModal dismiss', () => {
  it('calls cards_job_close_edit and upserts the closed job on Dialog close (Esc/backdrop)', async () => {
    const job = makeJob()
    const closed = makeJob({ state: 'cancelled', revision: 2, version: 2, cancelRequested: true })
    invokeMock.mockResolvedValue(closed)

    renderModal({ job, preview: null, fieldValues: null, baselineFields: null })
    expect(captured.dialogOnClose).toBeTypeOf('function')

    captured.dialogOnClose!()
    expect(useCardsStore.getState().editor).toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('cards_job_close_edit', { jobId: job.id })

    await flushMicrotasks()
    expect(useCardsStore.getState().jobs[job.id]).toEqual(closed)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('calls cards_job_close_edit when clicking the «Закрыть» button', async () => {
    const job = makeJob({ id: 'job-btn-1', hasCommittedNote: true, noteId: 42 })
    const restored = makeJob({ id: 'job-btn-1', hasCommittedNote: true, noteId: 42, state: 'added', revision: 2, version: 2 })
    invokeMock.mockResolvedValue(restored)

    renderModal({ job, preview: null, fieldValues: { Expression: 'bring' }, baselineFields: { Expression: 'bring' } })
    const closeBtn = captured.buttons.get('Закрыть')
    expect(closeBtn).toBeTypeOf('function')

    closeBtn!()
    expect(invokeMock).toHaveBeenCalledWith('cards_job_close_edit', { jobId: 'job-btn-1' })

    await flushMicrotasks()
    expect(useCardsStore.getState().jobs['job-btn-1']).toEqual(restored)
  })

  it('reports cards_job_close_edit errors via notify without keeping the modal open', async () => {
    const job = makeJob({ id: 'job-err-1' })
    invokeMock.mockRejectedValue('sqlite locked')

    renderModal({ job, preview: null, fieldValues: null, baselineFields: null })
    captured.dialogOnClose!()
    expect(useCardsStore.getState().editor).toBeNull()

    await flushMicrotasks()
    expect(notifyMock).toHaveBeenCalledWith('error', 'sqlite locked')
  })

  it('uses custom onDismissModal when provided instead of cards_job_close_edit', async () => {
    const job = makeJob({ id: 'job-custom-1' })
    const onDismissModal = vi.fn().mockResolvedValue(undefined)

    renderModal({ job, preview: null, fieldValues: null, baselineFields: null }, onDismissModal)
    captured.dialogOnClose!()

    await flushMicrotasks()
    expect(onDismissModal).toHaveBeenCalledWith('job-custom-1')
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
