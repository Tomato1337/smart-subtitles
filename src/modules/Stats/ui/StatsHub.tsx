import { useState, type ReactNode } from 'react'
import { Button, Icon, IconButton, Segmented, ShapeBadge, Spinner, StatusChip, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { StatsPeriod } from '@/common/types/ipc'
import { formatUsd } from '@/common/utilities/tokens'
import { NotificationHeaderButton } from '@/modules/Notifications'
import { cefrGoalLabel, type StatsTab } from '../lib/format'
import { useStatsOverview } from '../useStats'
import { AiUsageTab } from './AiUsageTab'
import { GrammarTab } from './GrammarTab'
import { ImmersionTab } from './ImmersionTab'
import { VocabularyTab } from './VocabularyTab'

const PERIODS = [
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: '90d', label: '90 дней' },
  { value: 'all', label: 'Всё время' },
] as const

export function StatsHub({
  tab,
  period,
  onChangeTab,
  onChangePeriod,
  onBack,
  onGoHome,
  onOpenLevelSettings,
}: {
  tab: StatsTab
  period: StatsPeriod
  onChangeTab: (tab: StatsTab) => void
  onChangePeriod: (period: StatsPeriod) => void
  onBack: () => void
  onGoHome: () => void
  onOpenLevelSettings?: () => void
}) {
  const query = useStatsOverview(period)
  const [refreshingAnki, setRefreshingAnki] = useState(false)

  const data = query.data

  const refreshAnki = async () => {
    setRefreshingAnki(true)
    try {
      await api.ankiRefresh()
      await query.refetch()
      toast('Снимок Anki обновлён')
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setRefreshingAnki(false)
    }
  }

  const tabs: { key: StatsTab; icon: string; label: string; badge?: string }[] = [
    { key: 'immersion', icon: 'monitoring', label: 'Погружение' },
    {
      key: 'vocab',
      icon: 'menu_book',
      label: 'Словарь',
      badge: data && data.vocabulary.unadded.length > 0 ? String(data.vocabulary.unadded.length) : undefined,
    },
    {
      key: 'grammar',
      icon: 'hub',
      label: 'Грамматика',
      badge: data ? `${data.grammar.encountered}/${data.grammar.total}` : undefined,
    },
    {
      key: 'ai',
      icon: 'receipt_long',
      label: 'Расход ИИ',
      badge: data ? formatUsd(data.ai.totalUsd) : undefined,
    },
  ]

  let body: ReactNode
  if (query.isPending && !data) {
    body = (
      <div className="flex justify-center py-24">
        <Spinner label="Собираю статистику" />
      </div>
    )
  } else if (query.isError) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-[28px] bg-[var(--md-sys-color-error-container)] p-6 text-[var(--md-sys-color-on-error-container)]">
        <div>
          <h2 className="type-title-large type-emph">Не удалось загрузить статистику</h2>
          <p className="type-body-medium mt-1">{errorText(query.error)}</p>
        </div>
        <Button variant="tonal" size="sm" icon="refresh" onClick={() => void query.refetch()}>
          Повторить
        </Button>
      </div>
    )
  } else if (!data || !data.hasActivity) {
    body = (
      <div className="flex flex-col items-center gap-4 rounded-[32px] bg-[var(--md-sys-color-surface-container)] px-8 py-14 text-center">
        <ShapeBadge shape="cookie9" size={72} tone="primary" icon="monitoring" iconFill iconSize={34} />
        <h2 className="type-headline-small type-emph">Статистика появится после первого просмотра</h2>
        <p className="type-body-medium max-w-[500px] text-[var(--md-sys-color-on-surface-variant)]">
          Во время фильма приложение тихо считает минуты просмотра, клики по словам, повторы реплик и встреченные грамматические конструкции.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <StatusChip size="md" tone="neutral" icon="schedule">Время в языке</StatusChip>
          <StatusChip size="md" tone="neutral" icon="menu_book">Покрытие базы</StatusChip>
          <StatusChip size="md" tone="neutral" icon="hub">48 конструкций</StatusChip>
        </div>
        <div className="pt-2">
          <Button variant="tonal" size="md" icon="folder_open" onClick={onGoHome}>
            Открыть фильм
          </Button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav
            aria-label="Разделы статистики"
            className="inline-flex flex-wrap items-center gap-1 rounded-full bg-[var(--md-sys-color-surface-container-low)] p-1.5"
          >
            {tabs.map((t) => {
              const active = t.key === tab
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onChangeTab(t.key)}
                  className={`state-layer state-on-surface relative inline-flex min-h-10 items-center gap-2 rounded-full px-4 py-1.5 transition-colors ${
                    active
                      ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
                      : 'text-[var(--md-sys-color-on-surface-variant)]'
                  }`}
                >
                  <Icon name={t.icon} size={20} fill={active} />
                  <span className={`type-label-large ${active ? 'font-semibold' : ''}`}>{t.label}</span>
                  {t.badge && (
                    <span
                      className={`type-label-small rounded-full px-2 py-0.5 tabular-nums ${
                        active
                          ? 'bg-[var(--md-sys-color-primary)] font-semibold text-[var(--md-sys-color-on-primary)]'
                          : 'bg-[var(--md-sys-color-surface-container-highest)] text-[var(--md-sys-color-on-surface-variant)]'
                      }`}
                    >
                      {t.badge}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>

          <button
            type="button"
            disabled={refreshingAnki}
            onClick={() => void refreshAnki()}
            className="type-label-large inline-flex min-h-9 items-center gap-2 rounded-full border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)] px-3.5 py-1.5 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container)]"
            title="Обновить снимок карточек Anki"
          >
            <span
              className="size-2 rounded-full"
              style={{ background: data.vocabulary.ankiConnected ? 'var(--app-success)' : 'var(--app-warning)' }}
            />
            <span>
              {data.vocabulary.ankiConnected
                ? `Anki · ${data.vocabulary.ankiMaturity.total} карточек`
                : 'Anki не в сети · обновить'}
            </span>
          </button>
        </div>

        {tab === 'immersion' && <ImmersionTab data={data.immersion} learnerCefr={data.learnerCefr} />}
        {tab === 'vocab' && (
          <VocabularyTab
            data={data.vocabulary}
            learnerCefr={data.learnerCefr}
            onRefreshAnki={() => void refreshAnki()}
          />
        )}
        {tab === 'grammar' && <GrammarTab data={data.grammar} />}
        {tab === 'ai' && <AiUsageTab data={data.ai} />}
      </div>
    )
  }

  return (
    <div className="min-h-full bg-[var(--md-sys-color-surface)] text-[var(--md-sys-color-on-surface)]">
      <header
        data-app-topbar=""
        className="sticky top-0 z-20 border-b border-[var(--md-sys-color-outline-variant)]/50 bg-[color-mix(in_srgb,var(--md-sys-color-surface)_92%,transparent)] backdrop-blur-md"
      >
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-6 py-3.5">
          <IconButton icon="arrow_back" label="Назад" variant="tonal" size="lg" onClick={onBack} />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
            <h1 className="type-headline-medium type-emph">Статистика</h1>
            {data && (
              onOpenLevelSettings ? (
                <button
                  type="button"
                  onClick={onOpenLevelSettings}
                  title="Уровень в настройках"
                  className="state-layer relative inline-flex cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-sys-color-primary)]"
                >
                  <StatusChip size="md" tone="neutral" icon="flag">
                    {cefrGoalLabel(data.learnerCefr)}
                  </StatusChip>
                </button>
              ) : (
                <StatusChip size="md" tone="neutral" icon="flag">
                  {cefrGoalLabel(data.learnerCefr)}
                </StatusChip>
              )
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Segmented
              label="Период статистики"
              size="sm"
              value={period}
              options={PERIODS}
              onChange={onChangePeriod}
            />
            <NotificationHeaderButton size="md" />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1160px] px-6 pt-6 pb-16">{body}</main>
    </div>
  )
}
