import type { CardJob, CardJobState } from '@/common/types/ipc'
import { ACTIVE_STATES } from '../store/cardsStore'
import { phaseLabel, taskStep } from './task'

export type ActivityTab = 'all' | 'working' | 'anki'

export type ActivityBadgeKind = 'working' | 'grace' | 'draft' | 'error' | 'added' | 'cancelled' | 'deleted'

export type ActivityStatusTone = 'primary' | 'tertiary' | 'error' | 'neutral' | 'warning' | 'success'

export type ActivityCounts = {
  allVisible: number
  allTotal: number
  working: number
  active: number
  drafts: number
  errors: number
  anki: number
  archived: number
}

export type JobActionsModel = {
  canEdit: boolean
  canCancel: boolean
  canRetry: boolean
  canDelete: boolean
  editLabel: string
  retryLabel: string
}

export type ActivityButtonState = {
  count: number
  activeCount: number
  draftCount: number
  errorCount: number
  hasError: boolean
  ariaLabel: string
}

/** Non-active states whose editor can still be opened (an active job is editable too). */
const EDITABLE: Record<string, true> = { editing: true, added: true, failed: true, interrupted: true, resolving: true }

const STEP_PROGRESS: Record<number, number> = { 1: 0.24, 2: 0.4, 3: 0.58, 4: 0.78, 5: 0.92 }

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

export function isArchivedState(state: CardJobState): boolean {
  return state === 'cancelled' || state === 'deleted'
}

export function isInWorkState(state: CardJobState): boolean {
  return state !== 'added' && !isArchivedState(state)
}

export function jobBadgeKind(state: CardJobState): ActivityBadgeKind {
  switch (state) {
    case 'grace':
      return 'grace'
    case 'editing':
      return 'draft'
    case 'failed':
    case 'interrupted':
      return 'error'
    case 'added':
      return 'added'
    case 'cancelled':
      return 'cancelled'
    case 'deleted':
      return 'deleted'
    default:
      return 'working'
  }
}

/** Safety & action invariants for a durable card job row. */
export function jobActionsModel(job: CardJob): JobActionsModel {
  const active = ACTIVE_STATES.has(job.state)
  const canEdit = !!EDITABLE[job.state] || (active && job.state !== 'cancel_requested' && job.state !== 'deleting')
  // An established note is deleted explicitly; "Cancel" must never look like it removes the note.
  const canCancel =
    !job.hasCommittedNote &&
    ((active && !['resolving', 'cancel_requested', 'deleting'].includes(job.state)) ||
      job.state === 'failed' ||
      job.state === 'interrupted' ||
      job.state === 'editing')
  const canRetry = job.state === 'failed' || job.state === 'interrupted' || job.state === 'resolving'
  // An explicit delete of an established note waits for/reconciles any sent edit itself.
  const canDelete =
    job.hasCommittedNote &&
    (job.state === 'added' ||
      job.state === 'editing' ||
      job.state === 'committing' ||
      job.state === 'resolving' ||
      job.state === 'failed' ||
      job.state === 'interrupted')

  return {
    canEdit,
    canCancel,
    canRetry,
    canDelete,
    editLabel: job.state === 'added' ? 'Редактировать' : 'Открыть',
    retryLabel: job.state === 'interrupted' ? 'Продолжить' : 'Повторить',
  }
}

export function countActivityJobs(jobs: readonly CardJob[]): ActivityCounts {
  let working = 0
  let active = 0
  let drafts = 0
  let errors = 0
  let anki = 0
  let archived = 0

  for (const job of jobs) {
    if (isArchivedState(job.state)) {
      archived += 1
    } else if (job.state === 'added') {
      anki += 1
    } else {
      working += 1
      if (job.state === 'editing') drafts += 1
      else if (job.state === 'failed' || job.state === 'interrupted') errors += 1
      else active += 1
    }
  }

  return {
    allVisible: working + anki,
    allTotal: jobs.length,
    working,
    active,
    drafts,
    errors,
    anki,
    archived,
  }
}

export function filterActivityJobs(
  jobs: readonly CardJob[],
  opts: { tab: ActivityTab; hideCancelled: boolean; query: string },
): CardJob[] {
  const q = opts.query.trim().toLowerCase()
  return jobs.filter((job) => {
    if (opts.hideCancelled && isArchivedState(job.state)) return false
    if (opts.tab === 'working' && !isInWorkState(job.state)) return false
    if (opts.tab === 'anki' && job.state !== 'added') return false
    if (!q) return true
    const haystack = [job.word, job.span ?? '', job.draft?.translation ?? '', job.cueText, job.title]
    return haystack.some((part) => part.toLowerCase().includes(q))
  })
}

export function activitySubtitle(counts: ActivityCounts, hideCancelled: boolean): string {
  if (counts.allTotal === 0) return 'Очередь и история добавлений в Anki'
  if (!hideCancelled && counts.archived > 0) return 'Показаны все, включая отменённые и удалённые'

  const parts: string[] = []
  if (counts.active > 0) parts.push(`${counts.active} в работе`)
  if (counts.drafts > 0) parts.push(`${counts.drafts} ${pluralRu(counts.drafts, 'черновик', 'черновика', 'черновиков')}`)
  if (counts.errors > 0) parts.push(`${counts.errors} ${pluralRu(counts.errors, 'ошибка', 'ошибки', 'ошибок')}`)
  if (counts.anki > 0) parts.push(`${counts.anki} в Anki`)

  if (parts.length > 0) return parts.join(' · ')
  return 'Все карточки в архиве'
}

export function archivedHiddenLabel(archivedCount: number): string {
  const mod10 = archivedCount % 10
  const mod100 = archivedCount % 100
  if (mod10 === 1 && mod100 !== 11) return `Скрыта ${archivedCount} отменённая или удалённая`
  return `Скрыто ${archivedCount} отменённых и удалённых`
}

export function activityProgress(job: CardJob): { value: number; text: string } | null {
  if (job.state === 'queued') return { value: 0.12, text: 'в очереди' }
  if (job.state === 'drafting') return { value: 0.24, text: phaseLabel(job) }
  if (job.state === 'generating') {
    const step = taskStep(job) ?? 2
    return { value: STEP_PROGRESS[step] ?? 0.4, text: phaseLabel(job) }
  }
  if (job.state === 'committing') return { value: 0.92, text: phaseLabel(job) }
  return null
}

export function jobStatusChip(job: CardJob, graceSeconds: number | null): { label: string; tone: ActivityStatusTone } {
  switch (job.state) {
    case 'grace':
      return { tone: 'warning', label: graceSeconds !== null ? `отмена · ${graceSeconds} с` : 'окно отмены' }
    case 'queued':
      return { tone: 'primary', label: 'в очереди' }
    case 'drafting':
      return { tone: 'primary', label: 'составляю' }
    case 'generating':
      return { tone: 'primary', label: job.imageProvider ? `готовлю · ${job.imageProvider}` : 'готовлю' }
    case 'editing':
      return { tone: 'tertiary', label: 'черновик' }
    case 'committing':
      return { tone: 'primary', label: job.hasCommittedNote ? 'сохраняю' : 'добавляю' }
    case 'resolving':
      return { tone: 'primary', label: 'проверяю Anki' }
    case 'cancel_requested':
      return { tone: 'primary', label: 'отменяю' }
    case 'deleting':
      return { tone: 'primary', label: 'удаляю' }
    case 'failed':
      return { tone: 'error', label: 'ошибка' }
    case 'interrupted':
      return { tone: 'error', label: 'прервано' }
    case 'added':
      return { tone: 'success', label: 'в Anki' }
    case 'cancelled':
      return { tone: 'neutral', label: 'отменено' }
    case 'deleted':
      return { tone: 'neutral', label: 'удалено' }
  }
}

export function activityButtonState(jobs: readonly CardJob[]): ActivityButtonState {
  const counts = countActivityJobs(jobs)
  const count = counts.working
  if (count === 0) {
    return { count: 0, activeCount: 0, draftCount: 0, errorCount: 0, hasError: false, ariaLabel: 'Карточки' }
  }
  const parts: string[] = []
  if (counts.active > 0) parts.push(`${counts.active} в работе`)
  if (counts.drafts > 0) parts.push(`${counts.drafts} ${pluralRu(counts.drafts, 'черновик', 'черновика', 'черновиков')}`)
  if (counts.errors > 0) parts.push(`${counts.errors} ${pluralRu(counts.errors, 'ошибка', 'ошибки', 'ошибок')}`)
  return {
    count,
    activeCount: counts.active,
    draftCount: counts.drafts,
    errorCount: counts.errors,
    hasError: counts.errors > 0,
    ariaLabel: `Карточки: ${parts.join(', ')}`,
  }
}
