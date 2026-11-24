import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Button, Combobox, Presence, Segmented, Select, TextField } from '@tomato1337/m3e-react'
import { api } from '@/common/api/tauri'
import type { AppConfig, LlmProvider, TaskLlm } from '@/common/types/ipc'
import { estimateUsd, formatTokens, formatUsd } from '@/common/utilities/tokens'
import { SECTION_META } from '../lib/sections'
import { TASKS, WEIGHT_LABEL, type TaskProfile } from '../taskProfiles'
import { buildProviderOptions, ModelPicker, type PingSummary } from './LlmFields'
import { MonthlyUsageDialog } from './MonthlyUsageDialog'
import { AppShapeBadge, AppStatusChip, SecretField, SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'

const SOURCE_MODES = [
  { value: 'agent', label: 'Из агента' },
  { value: 'manual', label: 'Вручную' },
] as const

const EFFORT_OPTIONS = [
  { value: 'off', label: 'выкл' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'med' },
  { value: 'high', label: 'high' },
] as const

export function ModelsSection({
  cfg,
  providers,
  set,
  changedKeys,
  focusId,
}: {
  cfg: AppConfig
  providers: LlmProvider[] | undefined
  set: ApplyConfig
  changedKeys: Set<string>
  focusId?: string
}) {
  const [usageOpen, setUsageOpen] = useState(false)
  const [pingState, setPingState] = useState<PingSummary>({ pending: false })
  const meta = SECTION_META.models

  const providerOptions = useMemo(
    () =>
      buildProviderOptions(
        providers,
        { value: '', label: 'Вручную', keywords: 'manual' },
        { source: cfg.llm.source, provider: cfg.llm.provider },
      ),
    [providers, cfg.llm.source, cfg.llm.provider],
  )
  const selectedProvider = providers?.find((p) => p.source === cfg.llm.source && p.id === cfg.llm.provider)
  const providerValue = cfg.llm.source ? `${cfg.llm.source}\n${cfg.llm.provider}` : ''

  // Compute film cost estimate across the 4 tasks used in a 1.5h film watch session.
  const taskConns = TASKS.map((task) => {
    const t = cfg.llmTasks[task.key]
    const foreign = !!t.source
    return {
      task,
      source: foreign ? t.source : cfg.llm.source,
      provider: foreign ? t.provider : cfg.llm.provider,
      baseUrl: foreign ? '' : cfg.llm.baseUrl,
      model: foreign ? t.model : t.model || cfg.llm.model,
    }
  })

  const modelInfos = useQueries({
    queries: taskConns.map((c) => ({
      queryKey: ['llm-model-info', c.source, c.provider, c.baseUrl, c.model],
      queryFn: () => api.llmModelInfo(c.source, c.provider, c.baseUrl, c.model),
      enabled: !!c.model,
      staleTime: 3_600_000,
    })),
  })

  const costAt = (idx: number, mult = 1): number | null => {
    const info = modelInfos[idx]?.data
    const p = taskConns[idx].task
    if (!info?.price) return null
    return estimateUsd(info.price, p.input * mult, p.cached * mult, p.output * mult)
  }

  const annotCost = costAt(0)
  const explain10 = costAt(1, 10)
  const draft5 = costAt(2, 5)
  const chat1 = costAt(3, 1)
  const filmTotal =
    annotCost !== null && explain10 !== null && draft5 !== null && chat1 !== null
      ? annotCost + explain10 + draft5 + chat1
      : null

  const statusChip = pingState.ms !== undefined
    ? <AppStatusChip tone="success" size="md" icon="check_circle">отвечает · {pingState.ms < 1000 ? `${pingState.ms} мс` : `${(pingState.ms / 1000).toFixed(1)} с`}</AppStatusChip>
    : pingState.error
      ? <AppStatusChip tone="error" size="md" icon="error">не отвечает</AppStatusChip>
      : undefined

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader title={meta.label} subtitle={meta.subtitle} icon={meta.icon} shape={meta.shape} tone={meta.tone} />

      <SettingGroup title="Основное подключение" action={statusChip}>
        <SettingRow
          focusId="llm.source"
          highlighted={focusId === 'llm.source'}
          changed={changedKeys.has('llm.source')}
          configKey="llm.source"
          label="Откуда взять модель"
          sub="Из агента — провайдер и ключ уже настроены в omp, Claude Code, Codex…"
          control={
            <Segmented
              label="Откуда взять модель"
              value={cfg.llm.source ? 'agent' : 'manual'}
              options={SOURCE_MODES}
              onChange={(mode) => {
                if (mode === 'manual') {
                  set('llm', { source: '', provider: '' })
                  return
                }
                const first = providers?.find((p) => p.hasKey) ?? providers?.[0]
                if (first) {
                  const patch: Partial<AppConfig['llm']> = { source: first.source, provider: first.id }
                  if (first.models.length > 0 && !first.models.includes(cfg.llm.model)) patch.model = first.models[0]
                  set('llm', patch)
                }
              }}
            />
          }
          below={
            !cfg.llm.source && (providers?.length ?? 0) === 0 ? (
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                Агентские провайдеры на этом компьютере не обнаружены — используйте ручное подключение.
              </p>
            ) : undefined
          }
        />

        {cfg.llm.source ? (
          <SettingRow
            focusId="llm.provider"
            highlighted={focusId === 'llm.provider'}
            changed={changedKeys.has('llm.provider')}
            configKey="llm.provider"
            label="Провайдер"
            sub={
              selectedProvider?.hasKey
                ? `${selectedProvider.baseUrl} · ${selectedProvider.api === 'anthropic' ? 'Anthropic' : 'OpenAI-совместимый'} · ключ из ${selectedProvider.file}`
                : `${providers?.length ?? 0} провайдеров найдено на этом компьютере`
            }
            control={
              <div className="w-full sm:w-[300px]">
                <Combobox
                  aria-label="Провайдер"
                  variant="outlined"
                  value={providerValue}
                  options={providerOptions}
                  searchable={6}
                  searchPlaceholder="Поиск провайдера…"
                  align="end"
                  onChange={(v) => {
                    if (!v) {
                      set('llm', { source: '', provider: '' })
                      return
                    }
                    const [source, provider] = v.split('\n')
                    const p = providers?.find((x) => x.source === source && x.id === provider)
                    const patch: Partial<AppConfig['llm']> = { source, provider }
                    if (p && p.models.length > 0 && !p.models.includes(cfg.llm.model)) patch.model = p.models[0]
                    set('llm', patch)
                  }}
                />
              </div>
            }
          />
        ) : (
          <>
            <SettingRow
              focusId="llm.apiKey"
              highlighted={focusId === 'llm.apiKey'}
              changed={changedKeys.has('llm.apiKey')}
              configKey="llm.apiKey"
              label="API-ключ"
              sub="Для ручного подключения; пусто — переменная окружения DEEPSEEK_API_KEY."
              below={
                <SecretField
                  aria-label="API-ключ LLM"
                  variant="outlined"
                  value={cfg.llm.apiKey}
                  placeholder="sk-…"
                  onValueChange={(apiKey) => set('llm', { apiKey })}
                />
              }
            />
            <SettingRow
              focusId="llm.baseUrl"
              highlighted={focusId === 'llm.baseUrl'}
              changed={changedKeys.has('llm.baseUrl')}
              configKey="llm.baseUrl"
              label="Адрес API"
              sub="Корневой URL OpenAI-совместимого или Anthropic endpoint."
              control={
                <div className="w-full sm:w-[300px]">
                  <TextField
                    aria-label="Адрес API"
                    variant="outlined"
                    value={cfg.llm.baseUrl}
                    spellCheck={false}
                    onChange={(e) => set('llm', { baseUrl: e.target.value })}
                  />
                </div>
              }
            />
            <SettingRow
              focusId="llm.api"
              highlighted={focusId === 'llm.api'}
              changed={changedKeys.has('llm.api')}
              configKey="llm.api"
              label="Протокол"
              control={
                <div className="w-full sm:w-[240px]">
                  <Select
                    aria-label="Протокол"
                    variant="outlined"
                    value={cfg.llm.api}
                    onChange={(e) => set('llm', { api: e.target.value as AppConfig['llm']['api'] })}
                  >
                    <option value="openai">OpenAI-совместимый</option>
                    <option value="anthropic">Anthropic</option>
                  </Select>
                </div>
              }
            />
          </>
        )}

        <SettingRow
          focusId="llm.model"
          highlighted={focusId === 'llm.model'}
          changed={changedKeys.has('llm.model')}
          configKey="llm.model"
          label="Модель"
          sub="Модель по умолчанию для перевода, объяснений, карточек и чата."
          below={
            <ModelPicker
              conn={cfg.llm}
              providers={providers}
              model={cfg.llm.model}
              onModel={(model) => set('llm', { model })}
              onPingState={setPingState}
            />
          }
        />
      </SettingGroup>

      <SettingGroup
        title="Модели по задачам"
        subtitle="«Как основная» — та же модель. Цена — оценка по каталогу models.dev."
      >
        {TASKS.map((task) => (
          <TaskRow
            key={task.key}
            task={task}
            cfg={cfg}
            providers={providers}
            set={set}
            changed={changedKeys.has(`llmTasks.${task.key}`)}
            highlighted={focusId === `llmTasks.${task.key}`}
          />
        ))}
      </SettingGroup>

      <div
        id="setting-models.usage"
        data-focus-id="models.usage"
        className={`flex flex-wrap items-center gap-4 rounded-[24px] bg-[var(--md-sys-color-surface-container-low)] px-5 py-4 ${
          focusId === 'models.usage' ? 'ring-2 ring-[var(--md-sys-color-primary)]' : ''
        }`}
      >
        <AppShapeBadge shape="sunny" size={48} tone="secondary" icon="payments" iconFill iconSize={24} />
        <div className="min-w-0 flex-1">
          <div className="type-title-medium type-emph">
            {filmTotal !== null ? `Фильм на 1,5 часа ≈ ${formatUsd(filmTotal)}` : 'Оценка стоимости за фильм'}
          </div>
          <div className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
            {filmTotal !== null
              ? `разбор ${formatUsd(annotCost!)} · 10 объяснений ${formatUsd(explain10!)} · 5 карточек ${formatUsd(draft5!)} · 1 вопрос ${formatUsd(chat1!)}`
              : 'Выберите модели с известной ценой в каталоге, чтобы увидеть расчёт.'}
          </div>
        </div>
        <Button variant="text" trailingIcon="arrow_forward" onClick={() => setUsageOpen(true)}>
          Расход за месяц
        </Button>
      </div>

      <Presence>{usageOpen && <MonthlyUsageDialog onClose={() => setUsageOpen(false)} />}</Presence>
    </div>
  )
}

function TaskRow({
  task,
  cfg,
  providers,
  set,
  changed,
  highlighted,
}: {
  task: TaskProfile
  cfg: AppConfig
  providers: LlmProvider[] | undefined
  set: ApplyConfig
  changed: boolean
  highlighted: boolean
}) {
  const t = cfg.llmTasks[task.key]
  const foreign = !!t.source
  const source = foreign ? t.source : cfg.llm.source
  const provider = foreign ? t.provider : cfg.llm.provider
  const baseUrl = foreign ? '' : cfg.llm.baseUrl
  const model = foreign ? t.model : t.model || cfg.llm.model
  const info = useQuery({
    queryKey: ['llm-model-info', source, provider, baseUrl, model],
    queryFn: () => api.llmModelInfo(source, provider, baseUrl, model),
    enabled: !!model,
    staleTime: 3_600_000,
  })
  const providerOptions = useMemo(
    () =>
      buildProviderOptions(
        providers,
        { value: '', label: 'Провайдер: как основной', keywords: 'default основной' },
        { source: t.source, provider: t.provider },
      ),
    [providers, t.source, t.provider],
  )
  const patch = (p: Partial<TaskLlm>) => set('llmTasks', { [task.key]: { ...t, ...p } })

  const est = info.data?.price ? estimateUsd(info.data.price, task.input, task.cached, task.output) : null
  const unitShort = task.key === 'annotate' ? 'фильм' : task.unit
  const subText = `${task.about}${est !== null ? ` · ≈ ${formatUsd(est)} за ${unitShort}` : ''}`

  return (
    <SettingRow
      focusId={`llmTasks.${task.key}`}
      highlighted={highlighted}
      changed={changed}
      configKey={`llmTasks.${task.key}`}
      label={
        <span className="inline-flex items-center gap-2">
          <span>{task.title}</span>
          <AppStatusChip
            tone={task.weight === 'heavy' ? 'error' : task.weight === 'medium' ? 'secondary' : 'success'}
            size="sm"
          >
            {WEIGHT_LABEL[task.weight]}
          </AppStatusChip>
        </span>
      }
      sub={subText}
      control={
        <Segmented
          label={`Рассуждение для «${task.title}»`}
          size="sm"
          value={t.effort}
          options={EFFORT_OPTIONS}
          onChange={(effort) => patch({ effort })}
        />
      }
      below={
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[240px_minmax(0,1fr)]">
            <Combobox
              aria-label={`Провайдер для «${task.title}»`}
              variant="outlined"
              value={t.source ? `${t.source}\n${t.provider}` : ''}
              options={providerOptions}
              searchable={6}
              searchPlaceholder="Поиск провайдера…"
              onChange={(v) => {
                if (!v) {
                  patch({ source: '', provider: '', model: '' })
                  return
                }
                const [nextSource, nextProvider] = v.split('\n')
                const p = providers?.find((x) => x.source === nextSource && x.id === nextProvider)
                patch({ source: nextSource, provider: nextProvider, model: p?.models[0] ?? '' })
              }}
            />

            {foreign ? (
              <ModelPicker
                compact
                conn={{ ...cfg.llm, source: t.source, provider: t.provider, model: t.model, baseUrl: '', apiKey: '' }}
                providers={providers}
                model={t.model}
                onModel={(m) => patch({ model: m })}
              />
            ) : (
              <ModelPicker
                compact
                conn={cfg.llm}
                providers={providers}
                model={t.model}
                onModel={(m) => patch({ model: m })}
                inherit={cfg.llm.model}
              />
            )}
          </div>
          <div className="type-body-small flex flex-wrap gap-x-3 text-[var(--md-sys-color-on-surface-variant)]">
            <span>
              ≈ {formatTokens(task.input)} вход (≈ {formatTokens(task.cached)} кэш) · ≈ {formatTokens(task.output)} выход за {task.unit}
            </span>
            {info.data?.contextWindow && <span>· окно {formatTokens(info.data.contextWindow)}</span>}
            {t.effort !== 'off' && <span>· с рассуждением выходных токенов больше</span>}
          </div>
        </div>
      }
    />
  )
}
