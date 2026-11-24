import { useEffect, useState, type CSSProperties } from 'react'
import { Button, Icon, IconButton, ListGroup, ShapeBadge, shapeClip, StatusChip, WavyProgress, WavySpinner } from '@tomato1337/m3e-react'
import type { RecentMedia } from '@/common/api/tauri'
import type { SetupStatus } from '@/common/types/ipc'
import { Cover } from '@/common/ui/Cover'
import {
  formatContinueProgress,
  formatSeasonEpisode,
  formatSubSource,
  pickWelcomeSteps,
  pluralCards,
  type SettingsSection,
} from '../lib/homeHelpers'
import type { LoadingSession } from '../store/sessionStore'

function AnnotStatusChip({ item }: { item: RecentMedia }) {
  switch (item.annot) {
    case 'done':
      return (
        <StatusChip tone="primary" size="md" className="gap-2 py-1 pr-3 pl-1 type-label-large">
          <ShapeBadge shape="sunny" size={24} tone="primary" icon="check" iconFill iconSize={14} />
          <span>Диалоги разобраны</span>
        </StatusChip>
      )
    case 'new':
      return (
        <StatusChip tone="tertiary" size="md" className="gap-2 py-1 pr-3 pl-1 type-label-large">
          <ShapeBadge shape="clover4" size={24} tone="tertiary" icon="pending" iconSize={14} />
          <span>Разбор не запускался</span>
        </StatusChip>
      )
    case 'partial':
      return (
        <StatusChip tone="secondary" size="md" className="gap-2 py-1 pr-3 pl-1 type-label-large">
          <ShapeBadge shape="clover4" size={24} tone="secondary" icon="hourglass_top" iconSize={14} />
          <span>Разобрано {item.annotDone} из {item.annotTotal}</span>
        </StatusChip>
      )
    case 'failed':
      return (
        <StatusChip tone="error" size="md" className="gap-2 py-1 pr-3 pl-1 type-label-large">
          <ShapeBadge shape="circle" size={24} tone="error" icon="error" iconFill iconSize={14} />
          <span>Часть диалогов не разобрана</span>
        </StatusChip>
      )
    case 'off':
      return (
        <StatusChip tone="neutral" size="md" className="gap-2 py-1 pr-3 pl-1 type-label-large">
          <ShapeBadge shape="circle" size={24} tone="neutral" icon="block" iconSize={14} />
          <span>Разбор выключен</span>
        </StatusChip>
      )
    case 'noSubs':
      return (
        <StatusChip tone="neutral" size="md" className="gap-2 py-1 pr-3 pl-1 type-label-large">
          <ShapeBadge shape="circle" size={24} tone="neutral" icon="subtitles_off" iconSize={14} />
          <span>Нет субтитров</span>
        </StatusChip>
      )
    default:
      return null
  }
}

export function ContinueCard({
  item,
  busy,
  onContinue,
  onStartOver,
}: {
  item: RecentMedia
  busy: boolean
  onContinue: () => void
  onStartOver: () => void
}) {
  const [failedPoster, setFailedPoster] = useState<string | null>(null)
  const se = formatSeasonEpisode(item.season, item.episode)
  const sub = formatSubSource(item.subSource)
  const { label: progressLabel, progress } = formatContinueProgress(item.lastPosition, item.duration)
  const metaParts = [
    se,
    item.originalTitle && item.originalTitle !== item.title ? item.originalTitle : null,
    item.year ? String(item.year) : null,
    sub?.label ?? null,
    item.cardsCount > 0 ? pluralCards(item.cardsCount) : null,
  ].filter(Boolean)

  const hasPoster = !!item.posterUrl && failedPoster !== item.posterUrl

  return (
    <section
      aria-label="Продолжить просмотр"
      className="relative overflow-hidden rounded-[32px] bg-[var(--md-sys-color-surface-container)]"
    >
      {hasPoster ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-[64%] max-w-[662px] overflow-hidden max-sm:opacity-40"
        >
          <img
            src={item.posterUrl ?? undefined}
            alt=""
            onError={() => setFailedPoster(item.posterUrl)}
            className="size-full object-cover object-[50%_20%]"
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(90deg, var(--md-sys-color-surface-container) 0%, color-mix(in srgb, var(--md-sys-color-surface-container) 82%, transparent) 24%, color-mix(in srgb, var(--md-sys-color-surface-container) 30%, transparent) 56%, transparent 82%)',
            }}
          />
        </div>
      ) : (
        <Cover
          src={null}
          title={item.title}
          className="pointer-events-none absolute top-1/2 right-8 hidden h-[220px] w-[147px] -translate-y-1/2 rounded-[20px] opacity-65 sm:grid"
        />
      )}

      <div className="relative z-[1] flex max-w-[600px] flex-col p-7 sm:p-8">
        <div className="flex items-center gap-2 text-[var(--md-sys-color-primary)]">
          <Icon name="history" size={20} />
          <span className="type-label-large type-emph">Продолжить просмотр</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="type-display-small type-emph text-[var(--md-sys-color-on-surface)]">{item.title}</h2>
          <AnnotStatusChip item={item} />
        </div>

        {metaParts.length > 0 && (
          <p className="type-body-medium mt-1 text-[var(--md-sys-color-on-surface-variant)]">
            {metaParts.join(' · ')}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {item.duration && item.duration > 0 ? (
            <WavyProgress className="h-3 w-[220px] max-w-full shrink-0" value={progress} amp={3} len={16} stroke={4} animated={false} />
          ) : null}
          <span className="type-label-large type-emph tabular-nums text-[var(--md-sys-color-primary)]">
            {progressLabel}
          </span>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onContinue}
            className="m3e-morph state-layer state-on-surface type-title-large type-emph relative flex min-h-20 items-center gap-3 rounded-[20px] bg-[var(--md-sys-color-primary-container)] py-4 pr-9 pl-6 text-[var(--md-sys-color-on-primary-container)] active:rounded-[28px] disabled:opacity-60"
          >
            <Icon name="play_arrow" size={32} fill />
            <span>Смотреть дальше</span>
          </button>
          <IconButton
            icon="replay"
            label="Сначала"
            variant="tonal"
            size="lg"
            disabled={busy}
            pressRadius="18px"
            onClick={onStartOver}
            style={{
              '--m3e-icon-button-size': '56px',
              '--m3e-icon-button-radius': '28px',
              '--m3e-icon-button-tonal-container': 'var(--md-sys-color-surface-container-high)',
            } as CSSProperties}
          />
        </div>
      </div>
    </section>
  )
}

export function OpeningCard({
  loading,
  onCancel,
}: {
  loading: LoadingSession
  onCancel: () => void
}) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const elapsedSec = Math.max(0, Math.floor((nowMs - loading.startedAt) / 1000))
  const se = formatSeasonEpisode(loading.season, loading.episode)
  const sourceLabel = loading.kind === 'lampa' ? 'TorrServer' : 'Локальный файл'
  const subline = [loading.originalTitle && loading.originalTitle !== loading.title ? loading.originalTitle : null, sourceLabel]
    .filter(Boolean)
    .join(' · ')
  const probeStepText = loading.kind === 'lampa'
    ? 'Открываю поток и определяю дорожки (ffprobe)'
    : 'Читаю параметры файла и дорожки (ffprobe)'

  return (
    <section
      role="status"
      aria-label="Открытие фильма"
      className="flex flex-col gap-6 rounded-[32px] bg-[var(--md-sys-color-surface-container)] p-6 sm:flex-row sm:items-center"
    >
      <Cover
        src={loading.posterUrl}
        title={loading.title}
        className="h-[180px] w-[120px] shrink-0 rounded-2xl"
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <ShapeBadge
            shape="cookie12"
            size={20}
            style={{ '--m3e-badge-container': 'var(--md-sys-color-primary)' } as CSSProperties}
          />
          <span className="type-label-large type-emph text-[var(--md-sys-color-primary)]">Открываю</span>
        </div>

        <h2 className="type-headline-medium type-emph truncate text-[var(--md-sys-color-on-surface)]">
          {loading.title}{se ? ` · ${se}` : ''}
        </h2>

        {subline && (
          <p className="type-body-medium truncate text-[var(--md-sys-color-on-surface-variant)]">{subline}</p>
        )}

        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2.5 text-[var(--md-sys-color-on-surface)]">
            <WavySpinner label="Анализ видеопотока" size={20} />
            <span className="type-body-medium type-emph">{probeStepText}</span>
          </div>
          <div className="flex items-center gap-2.5 text-[var(--md-sys-color-on-surface-variant)]">
            <Icon name="radio_button_unchecked" size={20} />
            <span className="type-body-medium">Поиск субтитров: раздача → рядом с файлом → в контейнере</span>
          </div>
          <div className="flex items-center gap-2.5 text-[var(--md-sys-color-on-surface-variant)]">
            <Icon name="radio_button_unchecked" size={20} />
            <span className="type-body-medium">Разбор диалогов начнётся в плеере</span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
        <WavyProgress className="h-3 w-[180px]" value={0.45} amp={3} len={16} stroke={4} animated />
        <span className="type-body-small tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
          ffprobe · {elapsedSec} с
        </span>
        <Button variant="outlined" size="sm" icon="close" onClick={onCancel}>
          Отменить
        </Button>
      </div>
    </section>
  )
}

export function WelcomeCard({
  setup,
  dragging,
  onOpenWizard,
  onPickFile,
  onNavigateSettings,
}: {
  setup: SetupStatus | undefined
  dragging: boolean
  onOpenWizard: () => void
  onPickFile: () => void
  onNavigateSettings: (section: SettingsSection) => void
}) {
  const steps = pickWelcomeSteps(setup)

  return (
    <section
      aria-label="Начало работы"
      className={`relative overflow-hidden rounded-[32px] bg-[var(--md-sys-color-surface-container)] p-7 transition-colors sm:p-8 ${
        dragging ? 'ring-2 ring-[var(--md-sys-color-primary)] ring-dashed' : ''
      }`}
    >
      {/* Expressive decorative backdrop shapes matching design/gen/home.py */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 hidden w-[360px] md:block">
        <div
          className="absolute -top-24 -right-14 size-[360px] bg-[var(--md-sys-color-primary-container)] opacity-90"
          style={{ clipPath: shapeClip.cookie12, WebkitClipPath: shapeClip.cookie12 }}
        />
        <div
          className="absolute -right-8 -bottom-10 size-[200px] rotate-12 bg-[var(--md-sys-color-tertiary-container)] opacity-90"
          style={{ clipPath: shapeClip.clover4, WebkitClipPath: shapeClip.clover4 }}
        />
        <div
          className="absolute right-[216px] bottom-[34px] size-[120px] bg-[var(--md-sys-color-secondary-container)] opacity-90"
          style={{ clipPath: shapeClip.sunny, WebkitClipPath: shapeClip.sunny }}
        />
        <div className="absolute top-[98px] right-[88px]">
          <ShapeBadge
            shape="burst12"
            size={72}
            icon="subtitles"
            iconFill
            iconSize={36}
            style={{
              '--m3e-badge-container': 'var(--app-anki-label-container)',
              '--m3e-badge-content': 'var(--app-anki-on-label-container)',
            } as CSSProperties}
          />
        </div>
      </div>

      <div className="relative z-[1] max-w-[640px]">
        <h2 className="type-headline-medium type-emph text-[var(--md-sys-color-on-surface)]">
          Три шага до первого фильма
        </h2>
        <p className="type-body-medium mt-1 text-[var(--md-sys-color-on-surface-variant)]">
          Мастер проверит, что уже есть на компьютере, и спросит только недостающее.
        </p>

        {steps.length > 0 && (
          <ListGroup className="mt-5">
            {steps.map(({ step, section, actionLabel, priority }, idx) => (
              <div
                key={step.id}
                className="flex items-center gap-3 bg-[var(--md-sys-color-surface-container-high)] py-3 pr-3 pl-4"
              >
                {step.done ? (
                  <ShapeBadge
                    shape="sunny"
                    size={36}
                    icon="check"
                    iconFill
                    iconSize={20}
                    style={{
                      '--m3e-badge-container': 'var(--app-success-container)',
                      '--m3e-badge-content': 'var(--app-on-success-container)',
                    } as CSSProperties}
                  />
                ) : (
                  <span className="type-label-large type-emph flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-[var(--md-sys-color-outline)] text-[var(--md-sys-color-on-surface-variant)]">
                    {idx + 1}
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <div className="type-title-small type-emph truncate text-[var(--md-sys-color-on-surface)]">
                    {step.title}
                  </div>
                  <div className="type-body-small truncate text-[var(--md-sys-color-on-surface-variant)]">
                    {step.hint}
                  </div>
                </div>

                {!step.done && (
                  <Button variant={priority} size="xs" onClick={() => onNavigateSettings(section)}>
                    {actionLabel}
                  </Button>
                )}
              </div>
            ))}
          </ListGroup>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onOpenWizard}
            className="m3e-morph state-layer state-on-surface type-title-large type-emph relative flex min-h-20 items-center gap-3 rounded-[20px] bg-[var(--md-sys-color-primary-container)] py-4 pr-9 pl-6 text-[var(--md-sys-color-on-primary-container)] active:rounded-[28px]"
          >
            <Icon name="auto_fix_high" size={32} fill />
            <span>Мастер настройки</span>
          </button>
          <Button variant="outlined" size="md" icon="folder_open" onClick={onPickFile}>
            Открыть файл
          </Button>
        </div>
      </div>
    </section>
  )
}
