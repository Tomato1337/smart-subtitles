import { Button, Icon, ListGroup } from '@tomato1337/m3e-react'
import type { AnkiConnectionStatus, AppConfig, DepsStatus, LlmProvider, MonthlyUsage, SystemInfo } from '@/common/types/ipc'
import { pluralRu } from '@/common/utilities/pluralRu'
import { formatUsd } from '@/common/utilities/tokens'
import { HOTKEY_ACTIONS, useHotkeysStore } from '@/modules/Hotkeys'
import { NAV_GROUPS, SECTION_META, type AppTone, type NavSection } from '../lib/sections'
import { imageRouteLabel } from './ImageFields'
import { llmReady } from './LlmFields'
import { AppShapeBadge, AppStatusChip, SectionHeader } from './SettingsPrimitives'
import { formatSubtitleSources } from './SubtitleSourcesFields'

type AttentionItem = {
  id: string
  icon: string
  tone: 'error' | 'warning'
  title: string
  description: string
  sectionLabel: string
  actionLabel: string
  onAction: () => void
  onRowClick?: () => void
}

const SENTENCE_AUDIO_SHORT: Record<AppConfig['anki']['sentenceAudio'], string> = {
  none: 'без звука предложения',
  clip: 'звук клипа',
  tts: 'синтез предложения',
}

function formatClockTime(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatRelativeSeen(lampaLastSeen: Record<string, number> | undefined): string | null {
  if (!lampaLastSeen) return null
  const timestamps = Object.values(lampaLastSeen)
  if (timestamps.length === 0) return null
  const latest = Math.max(...timestamps)
  const diffMin = Math.max(0, Math.round((Date.now() / 1000 - latest) / 60))
  if (diffMin < 1) return 'активна сейчас'
  if (diffMin < 60) return `была ${diffMin} мин назад`
  const diffHours = Math.round(diffMin / 60)
  if (diffHours < 24) return `была ${diffHours} ч назад`
  return `была ${Math.round(diffHours / 24)} дн назад`
}

function pluralOrigins(n: number): string {
  if (n === 0) return 'Нет разрешённых адресов'
  return `${n} ${pluralRu(n, 'адрес', 'адреса', 'адресов')} Lampa`
}

export function OverviewSection({
  cfg,
  providers,
  ankiStatus,
  ankiChecking,
  onCheckAnki,
  systemInfo,
  deps,
  monthlyUsage,
  onJump,
}: {
  cfg: AppConfig
  providers: LlmProvider[] | undefined
  ankiStatus?: AnkiConnectionStatus
  ankiChecking: boolean
  onCheckAnki: () => void
  systemInfo?: SystemInfo
  deps?: DepsStatus
  monthlyUsage?: MonthlyUsage
  onJump: (section: NavSection, focusId?: string) => void
}) {
  const bindings = useHotkeysStore((s) => s.bindings)
  const assignedKeys = HOTKEY_ACTIONS.filter((a) => bindings[a.id] !== null).length
  const llmOk = llmReady(cfg.llm, providers)
  const missingReqDeps = (deps?.deps ?? []).filter((d) => d.importance === 'required' && !d.found)
  const missingUv = deps?.deps.some((d) => d.id === 'uv' && !d.found) ?? false
  const depsOk = missingReqDeps.length === 0

  const issues: AttentionItem[] = []
  if (!depsOk) {
    issues.push({
      id: 'deps',
      icon: 'build',
      tone: 'error',
      title: `Не найдены: ${missingReqDeps.map((d) => d.title).join(', ')}`,
      description: 'Без ffmpeg и ffprobe видео не сможет воспроизводиться.',
      sectionLabel: 'Система',
      actionLabel: 'Подробнее',
      onAction: () => onJump('system', 'system.deps'),
    })
  }
  if (!llmOk) {
    issues.push({
      id: 'llm',
      icon: 'neurology',
      tone: 'error',
      title: 'Не настроена модель ИИ',
      description: 'Без ключа или агентского провайдера не работают перевод, подсветка и чат.',
      sectionLabel: 'Модели ИИ',
      actionLabel: 'Настроить',
      onAction: () => onJump('models', 'llm.source'),
    })
  }
  if (!cfg.opensubtitles.apiKey) {
    issues.push({
      id: 'opensubtitles',
      icon: 'key_off',
      tone: 'warning',
      title: 'Нет ключа OpenSubtitles',
      description: 'Субтитры только из раздачи, файла или контейнера.',
      sectionLabel: 'Субтитры',
      actionLabel: 'Добавить ключ',
      onAction: () => onJump('subs', 'opensubtitles.apiKey'),
    })
  }
  if (cfg.lampa.origins.length === 0) {
    issues.push({
      id: 'lampa',
      icon: 'live_tv',
      tone: 'error',
      title: 'Не указан адрес Lampa',
      description: 'Без разрешённого origin плагин получит отказ (403).',
      sectionLabel: 'Lampa',
      actionLabel: 'Добавить адрес',
      onAction: () => onJump('lampa', 'lampa.origins'),
    })
  }
  if (ankiStatus && !ankiStatus.ok) {
    const parts: string[] = []
    if (ankiStatus.queuedCards > 0) parts.push(`${ankiStatus.queuedCards} в очереди`)
    parts.push(`проверено в ${formatClockTime(ankiStatus.checkedAt)}`)
    issues.push({
      id: 'anki',
      icon: 'sync_problem',
      tone: 'warning',
      title: 'Anki не запущен',
      description: parts.join(' · '),
      sectionLabel: 'Anki',
      actionLabel: ankiChecking ? 'Проверяю…' : 'Проверить',
      onAction: onCheckAnki,
      onRowClick: () => onJump('anki', 'anki.url'),
    })
  }
  if (missingUv && (cfg.anki.tts || cfg.anki.sentenceAudio === 'tts')) {
    issues.push({
      id: 'uv',
      icon: 'record_voice_over',
      tone: 'warning',
      title: 'Не найден uv',
      description: 'Нужен для озвучки карточек (edge-tts) и автосинхронизации субтитров (Whisper).',
      sectionLabel: 'Система',
      actionLabel: 'Открыть',
      onAction: () => onJump('system', 'system.deps'),
    })
  }

  const annotateModel = cfg.llmTasks.annotate.source
    ? `${cfg.llmTasks.annotate.provider} · ${cfg.llmTasks.annotate.model}`
    : cfg.llmTasks.annotate.model || cfg.llm.model || '—'
  const lastSeen = formatRelativeSeen(systemInfo?.lampaLastSeen)
  const monthlyLabel =
    monthlyUsage && monthlyUsage.requests > 0
      ? `за ${monthlyUsage.days} дн: ${monthlyUsage.partial ? 'от ' : ''}${formatUsd(monthlyUsage.totalUsd)}`
      : 'за месяц: $0'

  const tileInfo: Record<NavSection, { lines: [string, string]; chip?: { label: string; tone: AppTone }; toneOverride?: AppTone }> = {
    models: {
      lines: [
        llmOk ? `${cfg.llm.source || 'вручную'} · ${cfg.llm.model || 'модель не выбрана'}` : 'Подключение не настроено',
        `Разбор — ${annotateModel} · ${monthlyLabel}`,
      ],
      chip: llmOk ? undefined : { label: 'нет ключа', tone: 'error' },
      toneOverride: llmOk ? undefined : 'error',
    },
    level: {
      lines: [
        `Уровень ${cfg.learner.cefr}${cfg.tutor.enabled ? ' (или из Tutor)' : ''}`,
        `Разбор без вопроса — ${cfg.annot.auto ? 'включён' : 'выключен'}`,
      ],
    },
    subs: {
      lines: [
        cfg.subtitles.sources.length > 0 ? formatSubtitleSources(cfg.subtitles.sources) : 'Автопоиск выключен',
        `OpenSubtitles: ${cfg.opensubtitles.apiKey ? 'ключ задан' : 'нет ключа'} · фокус ${Math.round(cfg.subtitles.idleOpacity * 100)}%`,
      ],
      chip: cfg.opensubtitles.apiKey ? undefined : { label: 'нет ключа', tone: 'warning' },
      toneOverride: cfg.opensubtitles.apiKey ? 'primary' : 'warning',
    },
    anki: {
      lines: [
        `Колода ${cfg.anki.deck}`,
        ankiStatus?.ok
          ? `Подключён · ${ankiStatus.indexCount} слов в индексе`
          : ankiStatus
            ? `Не запущен${ankiStatus.queuedCards > 0 ? ` · ${ankiStatus.queuedCards} в очереди` : ''}`
            : 'Проверяю подключение…',
      ],
      chip: ankiStatus && !ankiStatus.ok ? { label: 'внимание', tone: 'warning' } : undefined,
      toneOverride: ankiStatus && !ankiStatus.ok ? 'warning' : 'anki',
    },
    media: {
      lines: [
        `${cfg.anki.clip ? 'Клип из фильма' : 'Без клипа'} · ${SENTENCE_AUDIO_SHORT[cfg.anki.sentenceAudio]}`,
        cfg.anki.tts ? `Голос ${cfg.anki.ttsVoice}` : 'Озвучка слова выключена',
      ],
    },
    images: {
      lines: [
        imageRouteLabel(cfg.images, cfg.tutor),
        cfg.images.style ? `Стиль: ${cfg.images.style}` : 'Стиль не задан',
      ],
    },
    lampa: {
      lines: [
        [pluralOrigins(cfg.lampa.origins.length), lastSeen].filter(Boolean).join(' · '),
        `${cfg.torrserver.baseUrl ? 'TorrServer с прокси' : 'TorrServer без пароля'} · порт ${cfg.server.port}`,
      ],
      chip: cfg.lampa.origins.length === 0 ? { label: 'нет адреса', tone: 'error' } : undefined,
      toneOverride: cfg.lampa.origins.length === 0 ? 'error' : undefined,
    },
    keys: {
      lines: [`${assignedKeys} из ${HOTKEY_ACTIONS.length} действий с клавишами`, 'Меняются сразу'],
    },
    system: {
      lines: [
        `${systemInfo?.vaapiOk ? 'VAAPI · самопроверка ок' : 'VAAPI · не используется'} · ${depsOk ? 'ffmpeg ок' : 'нет ffmpeg'}`,
        'Мастер, тур, логи, API для агентов',
      ],
      chip: !depsOk ? { label: 'нет ffmpeg', tone: 'error' } : undefined,
      toneOverride: !depsOk ? 'error' : undefined,
    },
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Все настройки в одном месте"
        subtitle="Девять разделов в трёх группах. Наверху — то, что мешает прямо сейчас."
      />

      {issues.length > 0 ? (
        <section aria-label="Требует внимания">
          <ListGroup>
            <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--md-sys-color-error-container)] px-5 py-4 text-[var(--md-sys-color-on-error-container)]">
              <div className="flex items-center gap-3">
                <Icon name="error" size={24} fill />
                <h3 className="type-title-medium type-emph">Требует внимания · {issues.length}</h3>
              </div>
              <span className="type-body-medium opacity-90">часть возможностей работает не полностью</span>
            </div>
            {issues.map((issue) => (
              <div
                key={issue.id}
                className="flex flex-wrap items-center gap-3 bg-[var(--md-sys-color-surface-container)] py-3 pr-3 pl-5"
              >
                <AppShapeBadge
                  shape={issue.tone === 'error' ? 'clover4' : 'sunny'}
                  size={40}
                  tone={issue.tone}
                  icon={issue.icon}
                  iconFill
                  iconSize={20}
                />
                <button
                  type="button"
                  onClick={issue.onRowClick ?? issue.onAction}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="type-title-small type-emph wrap-anywhere">{issue.title}</div>
                  <div className="type-body-small wrap-anywhere text-[var(--md-sys-color-on-surface-variant)]">{issue.description}</div>
                </button>
                <span className="type-label-medium hidden text-[var(--md-sys-color-on-surface-variant)] sm:inline">
                  {issue.sectionLabel}
                </span>
                <Button variant="tonal" size="sm" onClick={issue.onAction}>
                  {issue.actionLabel}
                </Button>
              </div>
            ))}
          </ListGroup>
        </section>
      ) : (
        <div
          className="flex items-center gap-3 rounded-[24px] px-5 py-4"
          style={{
            backgroundColor: 'var(--app-success-container)',
            color: 'var(--app-on-success-container)',
          }}
        >
          <Icon name="check_circle" size={24} fill />
          <div className="min-w-0 flex-1">
            <div className="type-title-medium type-emph">Всё настроено</div>
            <div className="type-body-small opacity-90">
              ИИ, субтитры, Lampa и системные инструменты готовы к работе.
            </div>
          </div>
        </div>
      )}

      {NAV_GROUPS.map((grp) => (
        <section key={grp.group} className="flex flex-col gap-3">
          <h3 className="type-title-medium type-emph text-[var(--md-sys-color-primary)]">{grp.group}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {grp.items.map((id) => {
              const meta = SECTION_META[id]
              const info = tileInfo[id]
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onJump(id)}
                  className="state-layer state-on-surface relative flex min-w-0 flex-col gap-3 rounded-[24px] bg-[var(--md-sys-color-surface-container-low)] p-5 text-left transition-colors hover:bg-[var(--md-sys-color-surface-container)]"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <AppShapeBadge
                      shape={meta.shape}
                      size={48}
                      tone={info.toneOverride ?? meta.tone}
                      icon={meta.icon}
                      iconFill
                      iconSize={24}
                    />
                    {info.chip ? (
                      <AppStatusChip tone={info.chip.tone} size="sm">
                        {info.chip.label}
                      </AppStatusChip>
                    ) : (
                      <Icon name="chevron_right" size={22} className="text-[var(--md-sys-color-on-surface-variant)]" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="type-title-medium type-emph wrap-anywhere">{meta.label}</span>
                    <span className="type-body-small line-clamp-2 wrap-anywhere text-[var(--md-sys-color-on-surface-variant)]">
                      {info.lines[0]}
                    </span>
                    <span className="type-body-small line-clamp-2 wrap-anywhere text-[var(--md-sys-color-on-surface-variant)]">
                      {info.lines[1]}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
