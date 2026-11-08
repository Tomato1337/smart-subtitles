import { useCallback, useState } from 'react'
import { Dialog, Icon, Presence, Spinner } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { CardJob, CardJobState } from '@/common/types/ipc'
import { ACTIVE_STATES, graceRemaining, useCardsStore } from '../store/cardsStore'

const STATE_LABEL: Record<CardJobState, string> = {
  grace: 'окно отмены',
  queued: 'в очереди',
  drafting: 'составляю карточку',
  generating: 'готовлю медиа',
  editing: 'редактор',
  committing: 'добавляю в Anki',
  resolving: 'проверяю Anki',
  cancel_requested: 'отменяю',
  cancelled: 'отменено',
  added: 'в Anki',
  deleting: 'удаляю',
  deleted: 'удалено',
  failed: 'ошибка',
  interrupted: 'прервано',
}

const PHASE_LABEL: Record<string, string> = {
  grace: 'отменить ещё можно',
  edit: 'черновик',
  draft: 'составляю',
  media: 'клип и медиа',
  clip: 'клип',
  image: 'картинка',
  audio: 'озвучка',
  anki: 'поля',
  committing: 'Anki',
  added: '',
  resolving: 'Anki',
  sync: 'AnkiWeb',
}

/** Non-active states whose editor can still be opened (an active job is editable too). */
const EDITABLE: Record<string, true> = { editing: true, added: true, failed: true, interrupted: true, resolving: true }

/** Count of jobs in flight; the same entry sits in the player's top bar and beside the home title. */
export function CardsActivityButton({ className = '' }: { className?: string }) {
  const count = useCardsStore((s) => s.activeIds.length)
  const open = useCardsStore((s) => s.activityOpen)
  const setOpen = useCardsStore((s) => s.setActivityOpen)
  return (
    <button
      type="button"
      aria-label={count > 0 ? `Карточки: ${count} в работе` : 'Карточки'}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={`state-layer state-on-surface relative flex size-12 shrink-0 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] ${className}`}
    >
      <Icon name="add_card" />
      {count > 0 && (
        <span
          className="type-label-small absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full px-1"
          style={{ background: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)' }}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}

function Row({ job }: { job: CardJob }) {
  const openEditor = useCardsStore((s) => s.openEditor)
  const upsert = useCardsStore((s) => s.upsert)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = ACTIVE_STATES.has(job.state)
  const canEdit = !!EDITABLE[job.state] || (active && job.state !== 'cancel_requested' && job.state !== 'deleting')
  const grace = useCardsStore((s) => (job.state === 'grace' ? s.grace[job.id] : undefined))
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
    (job.state === 'added' || job.state === 'editing' || job.state === 'committing' || job.state === 'resolving' || job.state === 'failed' || job.state === 'interrupted')

  const run = useCallback(async (operation: () => Promise<CardJob>) => {
    setBusy(true)
    setError(null)
    try {
      upsert(await operation())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [upsert])

  const edit = async () => {
    setBusy(true)
    setError(null)
    try {
      openEditor(await api.cardsJobEdit(job.id, true))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const remaining = job.state === 'grace' ? Math.max(0, Math.ceil((grace ? graceRemaining(grace) : job.remainingMs) / 1000)) : null
  const detail = [
    job.phase ? PHASE_LABEL[job.phase] : '',
    job.state === 'generating' ? job.imageProvider ?? '' : '',
    job.state === 'generating' && job.attempt && job.attempt > 1 ? `попытка ${job.attempt}` : '',
    remaining !== null ? `${remaining} с` : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--md-sys-color-outline-variant)] py-2 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="type-title-small">{job.word || '—'}</span>
        <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">
          {job.title}{job.cueText ? ` · ${job.cueText.replace(/\s+/g, ' ').trim()}` : ''}
        </span>
        <span className="type-label-medium ml-auto">{STATE_LABEL[job.state]}{detail ? ` · ${detail}` : ''}</span>
      </div>
      {job.error && <p className="type-body-small text-[var(--md-sys-color-error)]">{job.error}</p>}
      {error && <p className="type-body-small text-[var(--md-sys-color-error)]">{error}</p>}
      <div className="flex flex-wrap gap-1">
        {canEdit && (
          <button type="button" disabled={busy} onClick={() => void edit()} className="state-layer type-label-large relative rounded-full px-3 py-1 text-[var(--md-sys-color-primary)] disabled:opacity-40">
            {job.state === 'added' ? 'Редактировать' : 'Открыть'}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const latest = useCardsStore.getState().jobs[job.id] ?? job
              void run(() => api.cardsJobCancel(job.id, latest.revision))
            }}
            className="state-layer type-label-large relative rounded-full px-3 py-1 text-[var(--md-sys-color-error)] disabled:opacity-40"
          >
            Отменить
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.cardsJobRetry(job.id))}
            className="state-layer type-label-large relative rounded-full px-3 py-1 text-[var(--md-sys-color-primary)] disabled:opacity-40"
          >
            {job.state === 'interrupted' ? 'Продолжить' : 'Повторить'}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.cardsJobDelete(job.id))}
            className="state-layer type-label-large relative rounded-full px-3 py-1 text-[var(--md-sys-color-error)] disabled:opacity-40"
          >
            Удалить из Anki
          </button>
        )}
      </div>
    </div>
  )
}

function Panel() {
  const setOpen = useCardsStore((s) => s.setActivityOpen)
  const order = useCardsStore((s) => s.order)
  const jobs = useCardsStore((s) => s.jobs)
  const cursor = useCardsStore((s) => s.cursor)
  const hydrated = useCardsStore((s) => s.hydrated)
  const loading = useCardsStore((s) => s.pageLoading)
  const pageError = useCardsStore((s) => s.pageError)
  const setPage = useCardsStore((s) => s.setPage)
  const appendPage = useCardsStore((s) => s.appendPage)
  const setPageState = useCardsStore((s) => s.setPageState)
  const rows = order.map((id) => jobs[id]).filter((j): j is CardJob => !!j)
  const errorBlock = !!pageError

  const retry = async () => {
    setPageState(true, null)
    try {
      const page = await api.cardsJobs(cursor)
      // The first page replaces; a failed later page continues from the last good cursor.
      if (cursor && hydrated) appendPage(page)
      else setPage(page)
    } catch (e) {
      setPageState(false, errorText(e))
    }
  }

  const more = async () => {
    setPageState(true, null)
    try {
      appendPage(await api.cardsJobs(cursor))
    } catch (e) {
      setPageState(false, errorText(e))
    }
  }

  return (
    <Dialog
      onClose={() => setOpen(false)}
      dismissible
      aria-labelledby="cards-activity-title"
      className="max-h-[90vh] w-[680px] max-w-[95vw]"
    >
      <h2 id="cards-activity-title" className="type-headline-small mb-3">Карточки</h2>
      {rows.length === 0 ? (
        loading ? (
          <Spinner label="Загружаю карточки" className="m-6" />
        ) : errorBlock ? (
          <div className="flex flex-col items-start gap-2 py-4">
            <p className="type-body-medium text-[var(--md-sys-color-error)]">{pageError}</p>
            <button type="button" onClick={() => void retry()} className="state-layer type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]">Повторить</button>
          </div>
        ) : hydrated ? (
          <p className="type-body-medium py-6 text-[var(--md-sys-color-on-surface-variant)]">Пока нет карточек.</p>
        ) : (
          <Spinner label="Загружаю карточки" className="m-6" />
        )
      ) : (
        <div className="flex max-h-[65vh] flex-col overflow-y-auto">
          {rows.map((job) => <Row key={job.id} job={job} />)}
        </div>
      )}
      {rows.length > 0 && pageError && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="type-body-small text-[var(--md-sys-color-error)]">{pageError}</p>
          <button type="button" disabled={loading} onClick={() => void retry()} className="state-layer type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)] disabled:opacity-40">Повторить</button>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        {cursor && !pageError && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void more()}
            className="state-layer type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)] disabled:opacity-40"
          >
            {loading ? 'Загружаю…' : 'Показать ещё'}
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className="type-label-large rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]">Закрыть</button>
      </div>
    </Dialog>
  )
}

/** Root-mounted panel: tasks stay reachable after the film is closed or the toast is replaced. */
export function CardsActivityPanel() {
  const open = useCardsStore((s) => s.activityOpen)
  return <Presence>{open && <Panel />}</Presence>
}
