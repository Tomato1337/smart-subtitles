import type { ToastAction, ToastOptions } from '@tomato1337/m3e-react'
import type { CardJob, JobPhase } from '@/common/types/ipc'

const PHASE_TEXT: Partial<Record<JobPhase, string>> = {
  queued: 'в очереди',
  draft: 'составляю карточку',
  edit: 'редактор открыт',
  media: 'готовлю клип и медиа',
  preparing: 'проверяю Anki',
  clip: 'вырезаю клип',
  image: 'генерирую картинку',
  audio: 'готовлю озвучку',
  anki: 'готовлю поля',
  committing: 'добавляю в Anki',
  resolving: 'проверяю Anki',
  sync: 'синхронизирую с AnkiWeb',
}

export type TaskHandlers = {
  edit: () => void | Promise<void>
  cancel: () => void | Promise<void>
  remove: () => void | Promise<void>
  retry: () => void | Promise<void>
}

/** The provider and attempt are the only generation details worth showing between phases. */
export function phaseLabel(job: CardJob): string {
  switch (job.state) {
    case 'grace':
      return ''
    case 'drafting':
      return 'составляю карточку'
    case 'generating': {
      const base = PHASE_TEXT[job.phase ?? 'media'] ?? 'готовлю карточку'
      const details = [job.imageProvider, job.attempt && job.attempt > 1 ? `попытка ${job.attempt}` : null].filter(Boolean)
      return details.length ? `${base} · ${details.join(' · ')}` : base
    }
    case 'editing':
      return 'редактор открыт'
    case 'committing':
      return job.hasCommittedNote ? 'сохраняю в Anki' : 'добавляю в Anki'
    case 'resolving':
      return 'проверяю результат в Anki'
    case 'cancel_requested':
      return 'отменяю — жду Anki'
    case 'cancelled':
      return 'добавление отменено'
    case 'added':
      return 'добавлено в Anki'
    case 'deleting':
      return 'удаляю из Anki'
    case 'deleted':
      return 'удалено из Anki'
    case 'failed':
      return 'не добавлено'
    case 'interrupted':
      return 'прервано перезапуском'
    default:
      return PHASE_TEXT[job.phase ?? 'queued'] ?? (job.phase ?? job.state)
  }
}

/** The whole toast line; `graceSeconds` is already computed from the backend clock. */
export function taskMessage(job: CardJob, graceSeconds: number): string {
  const word = `«${job.word}»`
  const text =
    job.state === 'grace'
      ? `${word} — добавление через ${Math.max(0, graceSeconds)} с`
      : `${word} — ${phaseLabel(job)}`
  return job.error && (job.state === 'failed' || job.state === 'interrupted') ? `${text}: ${job.error}` : text
}

/** Changes worth announcing; a countdown tick, progress update or new revision is not one. */
export function taskAnnouncementKey(job: CardJob): string {
  return [job.state, job.phase ?? '', job.imageProvider ?? '', job.attempt ?? '', job.error ?? '', job.hasCommittedNote ? '1' : '0'].join('|')
}

export function taskActions(job: CardJob, handlers: TaskHandlers): ToastOptions['actions'] {
  const edit: ToastAction = { label: 'Редактировать', variant: 'text', dismiss: false, run: handlers.edit }
  const cancel: ToastAction = { label: 'Отменить', variant: 'tonal', dismiss: false, run: handlers.cancel }
  const remove: ToastAction = { label: 'Удалить из Anki', variant: 'text', dismiss: false, run: handlers.remove }
  const retry: ToastAction = { label: job.state === 'interrupted' ? 'Продолжить' : 'Повторить', variant: 'tonal', dismiss: false, run: handlers.retry }
  switch (job.state) {
    case 'added':
      return [edit, remove]
    case 'failed':
    case 'interrupted':
      return [retry, edit]
    case 'editing':
      return [edit]
    case 'committing':
      return job.hasCommittedNote ? [edit] : [cancel, edit]
    case 'resolving':
      return [retry, edit]
    case 'cancel_requested':
    case 'cancelled':
    case 'deleting':
    case 'deleted':
      return undefined
    default:
      return [cancel, edit]
  }
}

/** Only a state transition changes the dismissal window; progress updates must not restart it. */
export function taskDuration(job: CardJob): number | null {
  switch (job.state) {
    case 'added':
      return 10_000
    case 'cancelled':
    case 'deleted':
      return 4_000
    case 'failed':
    case 'interrupted':
      return 12_000
    default:
      return null
  }
}

export function taskIcon(job: CardJob): string {
  switch (job.state) {
    case 'added':
      return 'task_alt'
    case 'cancelled':
    case 'deleted':
      return 'cancel'
    case 'failed':
    case 'interrupted':
      return 'error'
    default:
      return 'add_card'
  }
}

/** Grace and final states stay open on their own: the cancel window and the outcome must be seen. */
export function taskPinned(job: CardJob): boolean {
  return ['grace', 'added', 'failed', 'interrupted', 'cancelled', 'deleted'].includes(job.state)
}

export function taskTone(job: CardJob): 'ok' | 'error' | undefined {
  if (job.state === 'added') return 'ok'
  return job.state === 'failed' || job.state === 'interrupted' ? 'error' : undefined
}

/** Generation order of a quick card; a disabled clip or image just skips its step. */
export const TASK_STEPS = 5
const STEP_OF: Partial<Record<JobPhase, number>> = { draft: 1, media: 2, preparing: 2, clip: 2, image: 3, audio: 4, anki: 5, committing: 5 }

/** The step in progress, 1-based; null while the job is not producing the card. */
export function taskStep(job: CardJob): number | null {
  if (job.state === 'drafting') return 1
  if (job.state === 'committing') return TASK_STEPS
  if (job.state !== 'generating') return null
  return STEP_OF[job.phase ?? 'media'] ?? 2
}

const MINI_PHASE: Partial<Record<JobPhase, string>> = {
  queued: 'в очереди',
  draft: 'текст',
  media: 'медиа',
  preparing: 'медиа',
  clip: 'клип',
  image: 'картинка',
  audio: 'озвучка',
  anki: 'поля',
  committing: 'Anki',
}

/** The collapsed island's phase word; the word itself is shown separately. */
export function taskMini(job: CardJob): string {
  switch (job.state) {
    case 'drafting':
      return 'текст'
    case 'committing':
      return 'Anki'
    case 'resolving':
      return 'проверяю Anki'
    case 'cancel_requested':
      return 'отменяю'
    case 'deleting':
      return 'удаляю'
    case 'editing':
      return 'редактор'
    default:
      return MINI_PHASE[job.phase ?? 'queued'] ?? phaseLabel(job)
  }
}
