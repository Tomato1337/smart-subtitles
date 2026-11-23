import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Button,
  Chip,
  Dialog,
  Icon,
  IconButton,
  ListGroup,
  Presence,
  Segmented,
  ShapeBadge,
  Spinner,
  StatusChip,
  TextField,
  WavyProgress,
} from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { CardJob } from '@/common/types/ipc'
import { formatTime } from '@/common/utilities/time'
import {
  activityButtonState,
  activityProgress,
  activitySubtitle,
  archivedHiddenLabel,
  countActivityJobs,
  filterActivityJobs,
  isArchivedState,
  jobActionsModel,
  jobBadgeKind,
  jobStatusChip,
  type ActivityBadgeKind,
  type ActivityStatusTone,
  type ActivityTab,
} from '../lib/activityView'
import { graceRemaining, useCardsStore } from '../store/cardsStore'

export type CardsActivityButtonProps = {
  variant?: 'home' | 'player'
  className?: string
}

const ANKI_BADGE_STYLE = {
  '--m3e-badge-container': 'var(--app-anki-label-container)',
  '--m3e-badge-content': 'var(--app-anki-on-label-container)',
} as CSSProperties

const WARNING_BADGE_STYLE = {
  '--m3e-badge-container': 'var(--app-warning-container)',
  '--m3e-badge-content': 'var(--app-on-warning-container)',
} as CSSProperties

const SUCCESS_BADGE_STYLE = {
  '--m3e-badge-container': 'var(--app-success-container)',
  '--m3e-badge-content': 'var(--app-on-success-container)',
} as CSSProperties

const WARNING_CHIP_STYLE = {
  '--m3e-status-chip-container': 'var(--app-warning-container)',
  '--m3e-status-chip-content': 'var(--app-on-warning-container)',
} as CSSProperties

const SUCCESS_CHIP_STYLE = {
  '--m3e-status-chip-container': 'var(--app-success-container)',
  '--m3e-status-chip-content': 'var(--app-on-success-container)',
} as CSSProperties

const CANCEL_BUTTON_STYLE = {
  '--m3e-button-container': 'var(--md-sys-color-error-container)',
  '--m3e-button-content': 'var(--md-sys-color-on-error-container)',
} as CSSProperties

const ERROR_ICON_STYLE = {
  '--m3e-icon-button-size': '32px',
  '--m3e-icon-button-content': 'var(--md-sys-color-error)',
} as CSSProperties

const ROW_ICON_STYLE = {
  '--m3e-icon-button-size': '32px',
} as CSSProperties

function JobBadge({ kind }: { kind: ActivityBadgeKind }) {
  switch (kind) {
    case 'working':
      return <ShapeBadge shape="cookie12" size={40} tone="primary" icon="auto_awesome" iconFill iconSize={20} />
    case 'grace':
      return <ShapeBadge shape="cookie9" size={40} icon="timer" iconSize={20} style={WARNING_BADGE_STYLE} />
    case 'draft':
      return <ShapeBadge shape="clover4" size={40} tone="tertiary" icon="edit_note" iconSize={20} />
    case 'error':
      return <ShapeBadge shape="circle" size={40} tone="error" icon="error" iconFill iconSize={20} />
    case 'added':
      return <ShapeBadge shape="sunny" size={40} icon="check" iconFill iconSize={20} style={SUCCESS_BADGE_STYLE} />
    case 'cancelled':
      return <ShapeBadge shape="circle" size={40} tone="neutral" icon="close" iconSize={20} />
    case 'deleted':
      return <ShapeBadge shape="circle" size={40} tone="neutral" icon="delete_outline" iconSize={20} />
  }
}

function chipToneProps(tone: ActivityStatusTone) {
  if (tone === 'warning') return { tone: 'neutral' as const, style: WARNING_CHIP_STYLE }
  if (tone === 'success') return { tone: 'neutral' as const, style: SUCCESS_CHIP_STYLE }
  return { tone, style: undefined }
}

/** Count of cards in flight, waiting drafts, or errors; used in both Home header and Player top bar. */
export function CardsActivityButton({ variant = 'player', className = '' }: CardsActivityButtonProps) {
  const btn = useCardsStore(
    useShallow((s) => activityButtonState(s.order.map((id) => s.jobs[id]).filter((j): j is CardJob => !!j))),
  )
  const open = useCardsStore((s) => s.activityOpen)
  const setOpen = useCardsStore((s) => s.setActivityOpen)

  const badgeStyle: CSSProperties = btn.hasError
    ? { background: 'var(--md-sys-color-error)', color: 'var(--md-sys-color-on-error)' }
    : btn.activeCount > 0
      ? { background: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)' }
      : { background: 'var(--md-sys-color-tertiary)', color: 'var(--md-sys-color-on-tertiary)' }
  const countText = btn.count > 99 ? '99+' : String(btn.count)

  if (variant === 'home') {
    return (
      <span className={`relative inline-flex shrink-0 ${className}`}>
        <IconButton
          icon="style"
          label={btn.ariaLabel}
          variant="secondary"
          size="lg"
          tipPos="bottom"
          noTip={open}
          pressRadius="18px"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          style={{
            '--m3e-icon-button-size': '56px',
            '--m3e-icon-button-radius': '28px',
          } as CSSProperties}
        />
        {btn.count > 0 && (
          <span
            aria-hidden="true"
            className="type-label-small pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 leading-none font-semibold tabular-nums ring-2 ring-[var(--md-sys-color-surface)]"
            style={badgeStyle}
          >
            {countText}
          </span>
        )}
      </span>
    )
  }

  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <IconButton
        icon="style"
        label={btn.ariaLabel}
        variant="tonal"
        size="lg"
        tipPos="bottom"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {btn.count > 0 && (
        <span
          aria-hidden="true"
          className="type-label-small pointer-events-none absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-semibold tabular-nums"
          style={badgeStyle}
        >
          {countText}
        </span>
      )}
    </span>
  )
}

function JobRow({ job }: { job: CardJob }) {
  const openEditor = useCardsStore((s) => s.openEditor)
  const upsert = useCardsStore((s) => s.upsert)
  const grace = useCardsStore((s) => (job.state === 'grace' ? s.grace[job.id] : undefined))
  const isHeld = grace?.held ?? job.held
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)

  // Live countdown tick so the grace chip stays current even between 250ms backend events.
  useEffect(() => {
    if (job.state !== 'grace' || isHeld) return
    const timer = window.setInterval(() => setTick((t) => t + 1), 500)
    return () => window.clearInterval(timer)
  }, [job.state, isHeld])

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

  const cancel = () => {
    const latest = useCardsStore.getState().jobs[job.id] ?? job
    void run(() => api.cardsJobCancel(job.id, latest.revision))
  }

  const muted = isArchivedState(job.state)
  const actions = jobActionsModel(job)
  const remaining =
    job.state === 'grace'
      ? Math.max(0, Math.ceil((grace ? graceRemaining(grace) : job.remainingMs) / 1000))
      : null
  const chip = jobStatusChip(job, remaining)
  const chipStyle = chipToneProps(chip.tone)
  const progress = activityProgress(job)
  const translation = job.draft?.translation?.trim() ?? ''
  const quote = job.cueText.replace(/\s+/g, ' ').trim()
  const timeLabel = Number.isFinite(job.cueStart) && job.cueStart >= 0 ? formatTime(job.cueStart) : ''
  const meta = [job.title, timeLabel].filter(Boolean).join(' · ')
  const hasActions = !muted && (actions.canEdit || actions.canCancel || actions.canRetry || actions.canDelete)

  return (
    <li
      className={`flex items-start gap-3.5 px-4 py-3.5 ${
        muted ? 'bg-[var(--md-sys-color-surface-container-lowest)]' : 'bg-[var(--md-sys-color-surface-container)]'
      }`}
    >
      <div className="shrink-0 pt-0.5">
        <JobBadge kind={jobBadgeKind(job.state)} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            className={
              muted
                ? 'type-title-medium text-[var(--md-sys-color-on-surface-variant)]'
                : 'type-title-medium type-emph text-[var(--md-sys-color-on-surface)]'
            }
          >
            {job.word || job.span || '—'}
          </span>
          {translation && (
            <span className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">· {translation}</span>
          )}
        </div>

        {quote && (
          <p
            title={quote}
            className={`type-body-medium truncate text-[var(--md-sys-color-on-surface-variant)] ${
              muted ? 'opacity-75' : ''
            }`}
          >
            {quote}
          </p>
        )}

        {meta && (
          <div className="flex items-center gap-1.5 text-[var(--md-sys-color-on-surface-variant)]">
            <Icon name="movie" size={14} />
            <span className="type-body-small truncate">{meta}</span>
          </div>
        )}

        {progress && (
          <div className="flex items-center gap-2.5 pt-1">
            <WavyProgress className="h-2.5 w-32 shrink-0" value={progress.value} amp={2} len={14} stroke={3} animated />
            <span className="type-body-small type-emph truncate text-[var(--md-sys-color-primary)]">
              {progress.text}
            </span>
          </div>
        )}

        {(job.error || error) && (
          <div className="flex items-start gap-1.5 pt-1 text-[var(--md-sys-color-error)]">
            <Icon name="warning" size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-0.5">
              {job.error && <p className="type-body-small whitespace-pre-wrap break-words">{job.error}</p>}
              {error && <p className="type-body-small whitespace-pre-wrap break-words">{error}</p>}
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <StatusChip size="md" tone={chipStyle.tone} style={chipStyle.style}>
          {chip.label}
        </StatusChip>

        {hasActions && (
          <div className="flex items-center gap-1.5">
            {actions.canRetry ? (
              <>
                <Button
                  variant="filled"
                  size="xs"
                  icon="refresh"
                  disabled={busy}
                  onClick={() => void run(() => api.cardsJobRetry(job.id))}
                >
                  {actions.retryLabel}
                </Button>
                {actions.canEdit && (
                  <IconButton
                    icon="edit"
                    label={actions.editLabel}
                    size="sm"
                    style={ROW_ICON_STYLE}
                    disabled={busy}
                    onClick={() => void edit()}
                  />
                )}
              </>
            ) : actions.canEdit ? (
              <Button
                variant={job.state === 'added' ? 'outlined' : 'tonal'}
                size="xs"
                icon={job.state === 'added' ? 'edit' : job.state === 'editing' ? 'edit_note' : undefined}
                disabled={busy}
                onClick={() => void edit()}
              >
                {actions.editLabel}
              </Button>
            ) : null}

            {actions.canCancel && (
              job.state === 'grace' ? (
                <Button
                  variant="tonal"
                  size="xs"
                  icon="close"
                  disabled={busy}
                  style={CANCEL_BUTTON_STYLE}
                  onClick={cancel}
                >
                  Отменить
                </Button>
              ) : (
                <IconButton
                  icon="close"
                  label="Отменить"
                  size="sm"
                  style={ERROR_ICON_STYLE}
                  disabled={busy}
                  onClick={cancel}
                />
              )
            )}

            {actions.canDelete && (
              <IconButton
                icon="delete_outline"
                label="Удалить из Anki"
                size="sm"
                style={ERROR_ICON_STYLE}
                disabled={busy}
                onClick={() => void run(() => api.cardsJobDelete(job.id))}
              />
            )}
          </div>
        )}
      </div>
    </li>
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

  const [tab, setTab] = useState<ActivityTab>('all')
  const [hideCancelled, setHideCancelled] = useState(true)
  const [query, setQuery] = useState('')

  const allRows = useMemo(
    () => order.map((id) => jobs[id]).filter((j): j is CardJob => !!j),
    [order, jobs],
  )
  const counts = useMemo(() => countActivityJobs(allRows), [allRows])
  const visibleRows = useMemo(
    () => filterActivityJobs(allRows, { tab, hideCancelled, query }),
    [allRows, tab, hideCancelled, query],
  )

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

  const resetFilters = () => {
    setTab('all')
    setQuery('')
    if (counts.allVisible === 0 && counts.archived > 0) setHideCancelled(false)
  }

  const toggleHideCancelled = () => {
    setHideCancelled((prev) => {
      const next = !prev
      if (!next && tab !== 'all') setTab('all')
      return next
    })
  }

  const emptyError = allRows.length === 0 && !!pageError
  const subtitle = emptyError ? null : activitySubtitle(counts, hideCancelled)
  const hasSearch = query.trim().length > 0
  const footerText = hasSearch
    ? `Найдено ${visibleRows.length} из ${hideCancelled ? counts.allVisible : counts.allTotal}`
    : hideCancelled && counts.archived > 0
      ? archivedHiddenLabel(counts.archived)
      : null

  return (
    <Dialog
      onClose={() => setOpen(false)}
      dismissible
      aria-labelledby="cards-activity-title"
      className="max-h-[90vh] w-[780px] max-w-[95vw] overflow-hidden rounded-[32px] border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)] p-0"
      style={{ maxInlineSize: 'min(780px, calc(100vw - 32px))' }}
    >
      <div className="flex shrink-0 items-center gap-3.5 px-6 pt-5 pb-4">
        <ShapeBadge shape="clover4" size={44} icon="style" iconFill iconSize={22} style={ANKI_BADGE_STYLE} />
        <div className="min-w-0 flex-1">
          <h2 id="cards-activity-title" className="type-headline-small type-emph">Карточки</h2>
          {subtitle && (
            <p className="type-body-medium truncate text-[var(--md-sys-color-on-surface-variant)]">{subtitle}</p>
          )}
        </div>
        <IconButton icon="close" label="Закрыть" onClick={() => setOpen(false)} />
      </div>

      {allRows.length > 0 && (
        <div className="flex shrink-0 flex-col gap-3 px-6 pb-4">
          <TextField
            variant="pill"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по слову, реплике или фильму"
            aria-label="Поиск по слову, реплике или фильму"
            leading={<Icon name="search" size={20} />}
            trailing={
              query ? (
                <IconButton
                  icon="close"
                  label="Очистить поиск"
                  size="sm"
                  noTip
                  className="mr-1"
                  onClick={() => setQuery('')}
                />
              ) : undefined
            }
            style={{ '--m3e-input-container': 'var(--md-sys-color-surface-container-high)' } as CSSProperties}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              size="xs"
              label="Фильтр карточек"
              value={tab}
              onChange={setTab}
              options={[
                {
                  value: 'all',
                  label: `Все · ${hideCancelled ? counts.allVisible : counts.allTotal}`,
                  icon: tab === 'all' ? 'check' : undefined,
                },
                {
                  value: 'working',
                  label: `В работе · ${counts.working}`,
                  icon: tab === 'working' ? 'check' : undefined,
                },
                {
                  value: 'anki',
                  label: `В Anki · ${counts.anki}`,
                  icon: tab === 'anki' ? 'check' : undefined,
                },
              ]}
            />
            {(counts.archived > 0 || !hideCancelled) && (
              <Chip
                selected={hideCancelled}
                label={`Скрыть отменённые · ${counts.archived}`}
                onClick={toggleHideCancelled}
              />
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {allRows.length === 0 ? (
          loading && !pageError ? (
            <div className="flex justify-center py-12">
              <Spinner label="Загружаю карточки" />
            </div>
          ) : pageError ? (
            <div className="flex items-center gap-4 px-6 pt-2 pb-6">
              <ShapeBadge shape="circle" size={48} tone="error" icon="cloud_off" iconFill iconSize={24} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="type-title-medium type-emph">Не удалось загрузить карточки</div>
                <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">{pageError}</p>
              </div>
              <Button variant="filled" size="sm" icon="refresh" onClick={() => void retry()}>
                Повторить
              </Button>
            </div>
          ) : hydrated ? (
            <div className="flex flex-col items-center gap-3.5 px-8 py-12 text-center">
              <ShapeBadge shape="clover4" size={72} icon="style" iconFill iconSize={36} style={ANKI_BADGE_STYLE} />
              <h3 className="type-headline-small type-emph">Пока нет карточек</h3>
              <p className="type-body-medium max-w-[440px] text-[var(--md-sys-color-on-surface-variant)]">
                Во время просмотра кликните на подсвеченное выражение в субтитрах и нажмите «В Anki» — задача появится здесь.
              </p>
            </div>
          ) : (
            <div className="flex justify-center py-12">
              <Spinner label="Загружаю карточки" />
            </div>
          )
        ) : visibleRows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-8 py-10 text-center">
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              {hasSearch
                ? 'По этому запросу ничего не нашлось.'
                : hideCancelled && counts.allVisible === 0
                  ? 'Активных и добавленных карточек нет — всё в архиве.'
                  : 'В этом разделе пока нет карточек.'}
            </p>
            <Button variant="tonal" size="xs" onClick={resetFilters}>
              {hasSearch
                ? 'Сбросить поиск'
                : hideCancelled && counts.allVisible === 0 && counts.archived > 0
                  ? `Показать отменённые · ${counts.archived}`
                  : 'Показать все'}
            </Button>
          </div>
        ) : (
          <ListGroup
            as="ul"
            className="px-6 pb-4"
            style={{ '--m3e-list-outer-radius': '22px' } as CSSProperties}
          >
            {visibleRows.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ListGroup>
        )}

        {allRows.length > 0 && pageError && (
          <div className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-error-container)] px-4 py-2.5 text-[var(--md-sys-color-on-error-container)]">
            <p className="type-body-small min-w-0 flex-1">{pageError}</p>
            <Button variant="tonal" size="xs" icon="refresh" disabled={loading} onClick={() => void retry()}>
              Повторить
            </Button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-[var(--md-sys-color-outline-variant)] px-6 py-3.5">
        {cursor && !pageError && (
          <Button variant="outlined" size="sm" icon="expand_more" disabled={loading} onClick={() => void more()}>
            {loading ? 'Загружаю…' : 'Показать ещё'}
          </Button>
        )}
        {footerText && (
          <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{footerText}</span>
        )}
        <Button variant="tonal" size="sm" data-autofocus className="ml-auto" onClick={() => setOpen(false)}>
          Закрыть
        </Button>
      </div>
    </Dialog>
  )
}

/** Root-mounted panel: tasks stay reachable after the film is closed or the toast is replaced. */
export function CardsActivityPanel() {
  const open = useCardsStore((s) => s.activityOpen)
  return <Presence>{open && <Panel />}</Presence>
}
