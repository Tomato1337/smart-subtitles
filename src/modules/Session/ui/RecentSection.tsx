import type { CSSProperties } from 'react'
import { Icon, IconButton, ListGroup, Segmented, ShapeBadge, StatusChip, WavyProgress } from '@tomato1337/m3e-react'
import type { RecentMedia } from '@/common/api/tauri'
import { Cover } from '@/common/ui/Cover'
import { formatTime } from '@/common/utilities/time'
import {
  formatRecentPosition,
  formatSeasonEpisode,
  formatSubSource,
  formatUpdatedAt,
  pluralCards,
} from '../lib/homeHelpers'

export type RecentViewMode = 'grid' | 'list'

/** Analysis status ShapeBadge on a film poster corner (`off` stays clickable to re-enable analysis). */
function AnnotBadge({
  item,
  size = 36,
  ringColor,
  onResetAnnot,
}: {
  item: RecentMedia
  size?: number
  ringColor: string
  onResetAnnot: (mediaId: string) => void
}) {
  switch (item.annot) {
    case 'done':
      return (
        <ShapeBadge
          shape="sunny"
          size={size}
          tone="primary"
          icon="check"
          iconFill
          iconSize={Math.round(size * 0.54)}
          ringColor={ringColor}
          label="Диалоги разобраны"
          title="Диалоги разобраны"
        />
      )
    case 'new':
      return (
        <ShapeBadge
          shape="clover4"
          size={size}
          tone="tertiary"
          icon="pending"
          iconSize={Math.round(size * 0.54)}
          ringColor={ringColor}
          label="Разбор не запускался"
          title="Разбор не запускался"
        />
      )
    case 'partial':
      return (
        <ShapeBadge
          shape="clover4"
          size={size}
          tone="secondary"
          icon="hourglass_top"
          iconSize={Math.round(size * 0.54)}
          ringColor={ringColor}
          label={`Разобрано ${item.annotDone} из ${item.annotTotal}`}
          title={`Разобрано ${item.annotDone} из ${item.annotTotal}`}
        />
      )
    case 'failed':
      return (
        <ShapeBadge
          shape="circle"
          size={size}
          tone="error"
          icon="error"
          iconFill
          iconSize={Math.round(size * 0.54)}
          ringColor={ringColor}
          label={`Часть диалогов не разобрана: ${item.annotTotal - item.annotDone}`}
          title={`Часть диалогов не разобрана: ${item.annotTotal - item.annotDone}`}
        />
      )
    case 'off':
      return (
        <span
          className="inline-flex rounded-full"
          style={{ boxShadow: `0 0 0 3px ${ringColor}` }}
        >
          <IconButton
            icon="block"
            label="Разбор выключен. Нажмите, чтобы разобрать"
            tipPos="left"
            variant="tonal"
            size="md"
            onClick={() => onResetAnnot(item.mediaId)}
            style={{
              '--m3e-icon-button-size': `${size}px`,
              '--m3e-icon-button-radius': `${Math.round(size / 2)}px`,
            } as CSSProperties}
          />
        </span>
      )
    default:
      return null
  }
}

/** Compact ShapeBadge indicators for subtitle source and Anki card count. */
function MediaBadges({ item }: { item: RecentMedia }) {
  const sub = formatSubSource(item.subSource)
  const updated = formatUpdatedAt(item.updatedAt)
  if (!sub && item.cardsCount === 0 && !updated) return null

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[var(--md-sys-color-on-surface-variant)]">
      {sub && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-[var(--md-sys-color-surface-container-high)] py-0.5 pr-2 pl-0.5 type-label-small"
          title={sub.label}
        >
          <ShapeBadge shape="clover4" size={18} tone="secondary" icon="subtitles" iconSize={11} />
          <span>{sub.shortLabel}</span>
        </span>
      )}
      {item.cardsCount > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-[var(--md-sys-color-surface-container-high)] py-0.5 pr-2 pl-0.5 type-label-small text-[var(--md-sys-color-on-surface)]"
          title={pluralCards(item.cardsCount)}
        >
          <ShapeBadge
            shape="sunny"
            size={18}
            icon="style"
            iconSize={11}
            style={{
              '--m3e-badge-container': 'var(--app-anki-label-container)',
              '--m3e-badge-content': 'var(--app-anki-on-label-container)',
            } as CSSProperties}
          />
          <span className="tabular-nums">{item.cardsCount}</span>
        </span>
      )}
      {updated && <span className="type-label-small">{updated}</span>}
    </span>
  )
}

function GridCard({
  item,
  busy,
  onOpen,
  onForget,
  onResetAnnot,
}: {
  item: RecentMedia
  busy: boolean
  onOpen: (mediaId: string) => void
  onForget: (item: RecentMedia, from: HTMLElement) => void
  onResetAnnot: (mediaId: string) => void
}) {
  const se = formatSeasonEpisode(item.season, item.episode)
  const { label: posLabel, progress, completed } = formatRecentPosition(item.lastPosition, item.duration)
  const metaParts = [se, posLabel].filter(Boolean)

  return (
    <li className="group relative flex flex-col gap-2.5">
      <div className="relative aspect-[2/3] w-full">
        <div className="relative size-full overflow-hidden rounded-[20px]">
          <Cover src={item.posterUrl} title={item.title} className="size-full rounded-[20px]" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <span className="flex size-16 items-center justify-center rounded-[22px] bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] shadow-md">
              <Icon name="play_arrow" size={36} fill />
            </span>
          </div>
        </div>

        <div className="absolute top-2 right-2 z-[2] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
          <IconButton
            icon="close"
            label="Удалить из недавних"
            tipPos="left"
            variant="tonal"
            size="md"
            data-forget
            onClick={(e) => onForget(item, e.currentTarget)}
            style={{
              '--m3e-icon-button-size': '38px',
              '--m3e-icon-button-radius': '19px',
              '--m3e-icon-button-tonal-container': 'var(--md-sys-color-surface-container-high)',
            } as CSSProperties}
          />
        </div>

        <div className="absolute -right-1 -bottom-1 z-[2]">
          <AnnotBadge item={item} size={36} ringColor="var(--md-sys-color-surface)" onResetAnnot={onResetAnnot} />
        </div>
      </div>

      <button
        type="button"
        data-reopen
        aria-keyshortcuts="Delete"
        aria-label={`Открыть «${item.title}»`}
        disabled={busy}
        onClick={() => onOpen(item.mediaId)}
        onKeyDown={(e) => { if (e.key === 'Delete') onForget(item, e.currentTarget) }}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-[14px] text-left after:absolute after:inset-0 after:rounded-[20px] disabled:opacity-60"
      >
        <span className="type-title-small type-emph block w-full truncate text-[var(--md-sys-color-on-surface)]">
          {item.title}
        </span>
        <span className="type-body-small block w-full truncate text-[var(--md-sys-color-on-surface-variant)]">
          {metaParts.join(' · ')}
        </span>
      </button>

      {item.duration && item.duration > 0 ? (
        completed ? (
          <div className="h-[3px] w-full rounded-full bg-[var(--md-sys-color-primary)]" />
        ) : (
          <WavyProgress className="h-2.5 w-full" value={progress} amp={2} len={14} stroke={3} animated={false} />
        )
      ) : (
        <div className="h-[3px] w-full rounded-full bg-[var(--md-sys-color-surface-container-highest)]" />
      )}
    </li>
  )
}

function ListRow({
  item,
  busy,
  onOpen,
  onForget,
  onResetAnnot,
}: {
  item: RecentMedia
  busy: boolean
  onOpen: (mediaId: string) => void
  onForget: (item: RecentMedia, from: HTMLElement) => void
  onResetAnnot: (mediaId: string) => void
}) {
  const se = formatSeasonEpisode(item.season, item.episode)
  const safePos = Number.isFinite(item.lastPosition) && item.lastPosition > 0 ? item.lastPosition : 0
  const safeDur = item.duration !== null && Number.isFinite(item.duration) && item.duration > 0 ? item.duration : null
  const { progress, completed } = formatRecentPosition(safePos, safeDur)
  const titleLine = [item.title, se, item.year ? String(item.year) : null].filter(Boolean).join(' · ')

  return (
    <li className="relative grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-4 bg-[var(--md-sys-color-surface-container)] py-2.5 pr-3 pl-2.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]">
      <span className="relative block h-[84px] w-14">
        <Cover src={item.posterUrl} title={item.title} className="size-full rounded-xl" />
        <span className="absolute -right-1.5 -bottom-1.5 z-[2]">
          <AnnotBadge
            item={item}
            size={28}
            ringColor="var(--md-sys-color-surface-container)"
            onResetAnnot={onResetAnnot}
          />
        </span>
      </span>

      <button
        type="button"
        data-reopen
        aria-keyshortcuts="Delete"
        disabled={busy}
        onClick={() => onOpen(item.mediaId)}
        onKeyDown={(e) => { if (e.key === 'Delete') onForget(item, e.currentTarget) }}
        className="flex min-h-16 min-w-0 items-center justify-between gap-4 py-1 text-left after:absolute after:inset-0 after:rounded-[inherit] disabled:opacity-60"
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="type-title-medium type-emph block truncate text-[var(--md-sys-color-on-surface)]">
            {titleLine}
          </span>
          {item.originalTitle && item.originalTitle !== item.title && (
            <span className="type-body-small block truncate text-[var(--md-sys-color-on-surface-variant)]">
              {item.originalTitle}
            </span>
          )}
          <MediaBadges item={item} />
        </span>

        <span className="type-label-large type-emph flex shrink-0 flex-col items-end gap-1.5 tabular-nums text-[var(--md-sys-color-primary)]">
          <span>
            {completed
              ? 'Досмотрен'
              : `${formatTime(safePos)}${safeDur ? ` / ${formatTime(safeDur)}` : ''}`}
          </span>
          {item.duration && item.duration > 0 ? (
            completed ? (
              <span className="block h-[3px] w-32 rounded-full bg-[var(--md-sys-color-primary)]" />
            ) : (
              <WavyProgress className="h-3 w-32" value={progress} amp={2} len={14} stroke={3} animated={false} />
            )
          ) : null}
        </span>
      </button>

      <IconButton
        icon="close"
        label="Удалить из недавних"
        tipPos="left"
        data-forget
        className="z-[2]"
        onClick={(e) => onForget(item, e.currentTarget)}
      />
    </li>
  )
}

export function RecentSection({
  items,
  isPending,
  busy,
  view,
  onChangeView,
  onOpen,
  onForget,
  onResetAnnot,
}: {
  items: RecentMedia[]
  isPending: boolean
  busy: boolean
  view: RecentViewMode
  onChangeView: (v: RecentViewMode) => void
  onOpen: (mediaId: string) => void
  onForget: (item: RecentMedia, from: HTMLElement) => void
  onResetAnnot: (mediaId: string) => void
}) {
  return (
    <section aria-label="Недавние" className="mt-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="type-title-large type-emph text-[var(--md-sys-color-on-surface)]">Недавние</h2>
        {items.length > 0 && (
          <StatusChip tone="neutral" size="md" className="tabular-nums">
            {items.length}
          </StatusChip>
        )}
        <div className="ml-auto">
          {items.length > 0 && (
            <Segmented
              label="Вид списка недавних"
              size="xs"
              value={view}
              onChange={onChangeView}
              options={[
                { value: 'grid', label: 'Сетка', icon: view === 'grid' ? 'check' : 'grid_view' },
                { value: 'list', label: 'Список', icon: view === 'list' ? 'check' : 'view_list' },
              ]}
            />
          )}
        </div>
      </div>

      {isPending && items.length === 0 ? (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="aspect-[2/3] animate-pulse rounded-[20px] bg-[var(--md-sys-color-surface-container)]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-wrap items-center gap-5 rounded-[28px] bg-[var(--md-sys-color-surface-container-low)] p-6">
          <div aria-hidden="true" className="flex shrink-0 items-center gap-3">
            {[0, 1, 2].map((i) => (
              <Cover key={i} src={null} title="" className="h-24 w-16 rounded-xl" />
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="type-title-medium type-emph text-[var(--md-sys-color-on-surface)]">
              Здесь появятся фильмы, которые вы смотрели
            </div>
            <p className="type-body-medium mt-0.5 text-[var(--md-sys-color-on-surface-variant)]">
              С позицией, прогрессом разбора и карточками из каждого.
            </p>
          </div>
        </div>
      ) : view === 'grid' ? (
        <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item) => (
            <GridCard
              key={item.mediaId}
              item={item}
              busy={busy}
              onOpen={onOpen}
              onForget={onForget}
              onResetAnnot={onResetAnnot}
            />
          ))}
        </ul>
      ) : (
        <ListGroup as="ul">
          {items.map((item) => (
            <ListRow
              key={item.mediaId}
              item={item}
              busy={busy}
              onOpen={onOpen}
              onForget={onForget}
              onResetAnnot={onResetAnnot}
            />
          ))}
        </ListGroup>
      )}
    </section>
  )
}
