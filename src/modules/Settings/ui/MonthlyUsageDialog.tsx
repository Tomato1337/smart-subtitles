import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Dialog, IconButton, ListGroup, Segmented, Spinner } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import { formatTokens, formatUsd } from '@/common/utilities/tokens'
import { TASKS } from '../taskProfiles'

const PERIODS = [
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: '90', label: '90 дней' },
  { value: '365', label: 'Год' },
] as const

const TASK_TITLE = Object.fromEntries(TASKS.map((t) => [t.key, t.title])) as Record<string, string>

/** Aggregated token and USD spend modal powered by `api.llmMonthlyUsage(days)`. */
export function MonthlyUsageDialog({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState<'7' | '30' | '90' | '365'>('30')
  const query = useQuery({
    queryKey: ['llm-monthly-usage', Number(days)],
    queryFn: () => api.llmMonthlyUsage(Number(days)),
  })
  const u = query.data

  return (
    <Dialog onClose={onClose} dismissible aria-labelledby="monthly-usage-title" className="max-h-[90vh] w-[720px] max-w-[96vw] p-0">
      <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-3">
        <div>
          <h2 id="monthly-usage-title" className="type-headline-small">Расход за период</h2>
          <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
            Локальный журнал запросов в SQLite; цены из ~/.omp/agent/models.yml и models.dev.
          </p>
        </div>
        <IconButton icon="close" label="Закрыть" onClick={onClose} />
      </div>

      <div className="px-6 pb-3">
        <Segmented
          label="Период статистики"
          size="sm"
          value={days}
          options={PERIODS}
          onChange={setDays}
        />
      </div>

      <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain px-6 pb-5">
        {query.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner label="Считаю расход" />
          </div>
        ) : query.error ? (
          <p className="type-body-medium text-[var(--md-sys-color-error)]">{errorText(query.error)}</p>
        ) : !u || u.requests === 0 ? (
          <div className="rounded-[20px] bg-[var(--md-sys-color-surface-container-low)] p-6 text-center">
            <p className="type-title-medium">За последние {u?.days ?? Number(days)} дней запросов к ИИ не было</p>
            <p className="type-body-small mt-1 text-[var(--md-sys-color-on-surface-variant)]">
              Статистика появится после первого разбора диалогов, объяснения фразы, карточки или чата.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <StatTile
                label="Стоимость"
                value={`${u.partial ? 'от ' : ''}${formatUsd(u.totalUsd)}`}
                accent
              />
              <StatTile label="Запросов" value={String(u.requests)} />
              <StatTile
                label="Вход / кэш"
                value={`${formatTokens(u.inputTokens)} / ${formatTokens(u.cachedTokens)}`}
              />
              <StatTile label="Выход" value={formatTokens(u.outputTokens)} />
            </div>

            {u.partial && (
              <p className="type-body-small text-[var(--app-warning)]">
                Для части запросов цена модели неизвестна — итог показывает только известную долю.
              </p>
            )}

            <div className="flex flex-col gap-2">
              <h3 className="type-title-medium type-emph">По задачам</h3>
              <ListGroup>
                {u.byTask.map((row) => (
                  <div
                    key={row.task}
                    className="flex flex-wrap items-center justify-between gap-2 bg-[var(--md-sys-color-surface-container)] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="type-title-small">{TASK_TITLE[row.task] ?? row.task}</div>
                      <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                        {row.requests} запр. · {formatTokens(row.inputTokens)} вход ({formatTokens(row.cachedTokens)} кэш) · {formatTokens(row.outputTokens)} выход
                      </div>
                    </div>
                    <span className="type-title-small type-emph tabular-nums">
                      {row.partial ? 'от ' : ''}{formatUsd(row.usd)}
                    </span>
                  </div>
                ))}
              </ListGroup>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="type-title-medium type-emph">По моделям</h3>
              <ListGroup>
                {u.byModel.map((row) => (
                  <div
                    key={row.model}
                    className="flex flex-wrap items-center justify-between gap-2 bg-[var(--md-sys-color-surface-container)] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="type-title-small font-mono">{row.model || 'не указана'}</div>
                      <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                        {row.requests} запр. · {formatTokens(row.inputTokens)} вход ({formatTokens(row.cachedTokens)} кэш) · {formatTokens(row.outputTokens)} выход
                      </div>
                    </div>
                    <span className="type-title-small type-emph tabular-nums">
                      {row.partial ? 'от ' : ''}{formatUsd(row.usd)}
                    </span>
                  </div>
                ))}
              </ListGroup>
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end border-t border-[var(--md-sys-color-outline-variant)] px-6 py-3">
        <Button variant="filled" data-autofocus onClick={onClose}>
          Готово
        </Button>
      </div>
    </Dialog>
  )
}

function StatTile({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-[16px] p-3.5 ${
        accent
          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
          : 'bg-[var(--md-sys-color-surface-container)]'
      }`}
    >
      <span className="type-label-small opacity-80">{label}</span>
      <span className="type-title-large type-emph tabular-nums">{value}</span>
    </div>
  )
}
