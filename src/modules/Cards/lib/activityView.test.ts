import { describe, expect, it } from 'vitest'
import type { CardJob, CardJobState } from '@/common/types/ipc'
import {
  activityButtonState,
  activityProgress,
  activitySubtitle,
  archivedHiddenLabel,
  countActivityJobs,
  filterActivityJobs,
  isArchivedState,
  isInWorkState,
  jobActionsModel,
  jobBadgeKind,
  jobStatusChip,
} from './activityView'

const JOB = (over: Partial<CardJob> & { id: string; state: CardJobState }): CardJob => ({
  origin: 'quick',
  proposalId: null,
  wordIndex: null,
  mediaId: 'm1',
  cueIdx: 1,
  span: null,
  title: 'Шоу Трумана',
  cueText: 'Can I borrow that?',
  cueStart: 848,
  word: 'borrow',
  revision: 1,
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

describe('activityView classification & counts', () => {
  it('partitions all 14 CardJobState values cleanly', () => {
    const allStates: CardJobState[] = [
      'grace',
      'queued',
      'drafting',
      'generating',
      'editing',
      'committing',
      'resolving',
      'cancel_requested',
      'cancelled',
      'added',
      'deleting',
      'deleted',
      'failed',
      'interrupted',
    ]
    const jobs = allStates.map((state, i) => JOB({ id: String(i), state }))
    const counts = countActivityJobs(jobs)

    expect(counts).toEqual({
      allVisible: 12,
      allTotal: 14,
      working: 11,
      active: 8,
      drafts: 1,
      errors: 2,
      anki: 1,
      archived: 2,
    })
    for (const s of allStates) {
      const archived = isArchivedState(s)
      const inWork = isInWorkState(s)
      expect(Number(archived) + Number(inWork) + Number(s === 'added')).toBe(1)
    }
  })

  it('builds Russian header subtitle and hidden-archive text', () => {
    expect(activitySubtitle(countActivityJobs([]), true)).toBe('Очередь и история добавлений в Anki')
    const sample = [
      JOB({ id: '1', state: 'generating' }),
      JOB({ id: '2', state: 'grace' }),
      JOB({ id: '3', state: 'editing' }),
      JOB({ id: '4', state: 'failed' }),
      JOB({ id: '5', state: 'added' }),
      JOB({ id: '6', state: 'added' }),
      JOB({ id: '7', state: 'cancelled' }),
    ]
    const counts = countActivityJobs(sample)
    expect(activitySubtitle(counts, true)).toBe('2 в работе · 1 черновик · 1 ошибка · 2 в Anki')
    expect(activitySubtitle(counts, false)).toBe('Показаны все, включая отменённые и удалённые')
    expect(activitySubtitle(countActivityJobs([JOB({ id: '1', state: 'cancelled' })]), true)).toBe('Все карточки в архиве')
    expect(archivedHiddenLabel(1)).toBe('Скрыта 1 отменённая или удалённая')
    expect(archivedHiddenLabel(9)).toBe('Скрыто 9 отменённых и удалённых')
  })
})

describe('activityView filtering & search', () => {
  const jobs = [
    JOB({
      id: '1',
      state: 'generating',
      word: 'as long as I can remember',
      title: 'Sintel',
      cueText: "I've been alone for as long as I can remember.",
      draft: {
        word: 'as long as I can remember',
        translation: 'сколько себя помню',
        word_type: 'idiom',
        cloze_sentence: '',
        full_sentence: '',
        sentence_translation: '',
        image_prompt: '',
      },
    }),
    JOB({ id: '2', state: 'editing', word: 'borrow', title: 'Шоу Трумана', cueText: 'Can I borrow that?' }),
    JOB({ id: '3', state: 'added', word: 'everything', title: 'Шоу Трумана', cueText: "We've tried everything." }),
    JOB({ id: '4', state: 'cancelled', word: 'Fiji', title: 'Шоу Трумана', cueText: 'Fiji?' }),
    JOB({ id: '5', state: 'deleted', word: 'pizza', title: 'Шоу Трумана', cueText: 'This is my favorite pizza place.' }),
  ]

  it('hides cancelled and deleted by default and reveals them when toggled off', () => {
    expect(filterActivityJobs(jobs, { tab: 'all', hideCancelled: true, query: '' }).map((j) => j.id)).toEqual(['1', '2', '3'])
    expect(filterActivityJobs(jobs, { tab: 'all', hideCancelled: false, query: '' }).map((j) => j.id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('filters by tab (working vs anki)', () => {
    expect(filterActivityJobs(jobs, { tab: 'working', hideCancelled: false, query: '' }).map((j) => j.id)).toEqual(['1', '2'])
    expect(filterActivityJobs(jobs, { tab: 'anki', hideCancelled: false, query: '' }).map((j) => j.id)).toEqual(['3'])
  })

  it('searches across word, draft translation, cue text, and film title', () => {
    expect(filterActivityJobs(jobs, { tab: 'all', hideCancelled: true, query: 'сколько' }).map((j) => j.id)).toEqual(['1'])
    expect(filterActivityJobs(jobs, { tab: 'all', hideCancelled: true, query: 'sintel' }).map((j) => j.id)).toEqual(['1'])
    expect(filterActivityJobs(jobs, { tab: 'all', hideCancelled: true, query: "we've tried" }).map((j) => j.id)).toEqual(['3'])
    expect(filterActivityJobs(jobs, { tab: 'all', hideCancelled: false, query: 'Шоу Трумана' }).map((j) => j.id)).toEqual([
      '2',
      '3',
      '4',
      '5',
    ])
  })
})

describe('activityView action safety & state invariants', () => {
  it('never allows Cancel on a job with a committed Anki note, allowing Delete instead', () => {
    const committedStates: CardJobState[] = ['added', 'editing', 'committing', 'resolving', 'failed', 'interrupted']
    for (const state of committedStates) {
      const m = jobActionsModel(JOB({ id: 'c', state, hasCommittedNote: true }))
      expect(m.canCancel).toBe(false)
      expect(m.canDelete).toBe(true)
      expect(m.canEdit).toBe(true)
    }
  })

  it('allows Cancel and forbids Delete when note is not yet committed', () => {
    const uncommittedCancelable: CardJobState[] = ['grace', 'queued', 'drafting', 'generating', 'committing', 'editing', 'failed', 'interrupted']
    for (const state of uncommittedCancelable) {
      const m = jobActionsModel(JOB({ id: 'u', state, hasCommittedNote: false }))
      expect(m.canCancel).toBe(true)
      expect(m.canDelete).toBe(false)
    }
  })

  it('disables Edit and Cancel during cancel_requested and deleting', () => {
    for (const state of ['cancel_requested', 'deleting'] as const) {
      const m = jobActionsModel(JOB({ id: 't', state, hasCommittedNote: false }))
      expect(m.canEdit).toBe(false)
      expect(m.canCancel).toBe(false)
      expect(m.canDelete).toBe(false)
      expect(m.canRetry).toBe(false)
    }
  })

  it('forbids Cancel on resolving and enables Retry on failed, interrupted, and resolving', () => {
    const resolving = jobActionsModel(JOB({ id: 'r', state: 'resolving', hasCommittedNote: false }))
    expect(resolving.canCancel).toBe(false)
    expect(resolving.canRetry).toBe(true)
    expect(resolving.canEdit).toBe(true)
    expect(resolving.retryLabel).toBe('Повторить')

    const interrupted = jobActionsModel(JOB({ id: 'i', state: 'interrupted', hasCommittedNote: false }))
    expect(interrupted.canRetry).toBe(true)
    expect(interrupted.retryLabel).toBe('Продолжить')
  })

  it('strips all actions from archived rows (cancelled, deleted)', () => {
    for (const state of ['cancelled', 'deleted'] as const) {
      const m = jobActionsModel(JOB({ id: 'a', state, hasCommittedNote: state === 'deleted' }))
      expect(m.canEdit).toBe(false)
      expect(m.canCancel).toBe(false)
      expect(m.canRetry).toBe(false)
      expect(m.canDelete).toBe(false)
    }
  })
})

describe('activityView badges, chips, progress & button state', () => {
  it('maps states to expressive badge kinds and status chips', () => {
    expect(jobBadgeKind('generating')).toBe('working')
    expect(jobBadgeKind('grace')).toBe('grace')
    expect(jobBadgeKind('editing')).toBe('draft')
    expect(jobBadgeKind('failed')).toBe('error')
    expect(jobBadgeKind('added')).toBe('added')
    expect(jobBadgeKind('cancelled')).toBe('cancelled')
    expect(jobBadgeKind('deleted')).toBe('deleted')

    expect(jobStatusChip(JOB({ id: '1', state: 'generating', imageProvider: 'omp' }), null)).toEqual({
      tone: 'primary',
      label: 'готовлю · omp',
    })
    expect(jobStatusChip(JOB({ id: '2', state: 'grace' }), 4)).toEqual({
      tone: 'warning',
      label: 'отмена · 4 с',
    })
    expect(jobStatusChip(JOB({ id: '3', state: 'added' }), null)).toEqual({
      tone: 'success',
      label: 'в Anki',
    })
  })

  it('returns progress only while a card is actively queued/drafting/generating/committing', () => {
    expect(activityProgress(JOB({ id: '1', state: 'generating', phase: 'image', attempt: 2 }))).toEqual({
      value: 0.58,
      text: 'генерирую картинку · попытка 2',
    })
    expect(activityProgress(JOB({ id: '2', state: 'grace' }))).toBeNull()
    expect(activityProgress(JOB({ id: '3', state: 'added' }))).toBeNull()
    expect(activityProgress(JOB({ id: '4', state: 'failed' }))).toBeNull()
  })

  it('summarizes active, draft, and error counts for CardsActivityButton', () => {
    expect(activityButtonState([JOB({ id: '1', state: 'added' })])).toEqual({
      count: 0,
      activeCount: 0,
      draftCount: 0,
      errorCount: 0,
      hasError: false,
      ariaLabel: 'Карточки',
    })
    expect(
      activityButtonState([
        JOB({ id: '1', state: 'queued' }),
        JOB({ id: '2', state: 'editing' }),
        JOB({ id: '3', state: 'failed' }),
        JOB({ id: '4', state: 'added' }),
      ]),
    ).toEqual({
      count: 3,
      activeCount: 1,
      draftCount: 1,
      errorCount: 1,
      hasError: true,
      ariaLabel: 'Карточки: 1 в работе, 1 черновик, 1 ошибка',
    })
  })
})
