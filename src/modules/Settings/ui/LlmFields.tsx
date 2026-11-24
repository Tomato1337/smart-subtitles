import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Button, Combobox, IconButton, Segmented, Select, TextField, type ComboboxOption } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, LlmProvider } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { formatTokens } from '@/common/utilities/tokens'
import { SecretField } from './SettingsPrimitives'

type Llm = AppConfig['llm']

/** Option value for «Другая модель…». */
const CUSTOM = '__custom__'

/** Lists with at least this many choices switch from native `<Select>` to searchable `<Combobox>`. */
export const SEARCH_SELECT_THRESHOLD = 8

/** A key of its own, or an imported provider whose config still has one. */
export function llmReady(llm: Llm, providers: LlmProvider[] | undefined): boolean {
  if (!llm.source) return !!llm.apiKey
  return !!providers?.some((p) => p.source === llm.source && p.id === llm.provider && p.hasKey)
}

/** Identity of the connection a model list belongs to; ignores `model`, which does not affect it. */
const connKey = (l: Llm) => JSON.stringify({ source: l.source, provider: l.provider, baseUrl: l.baseUrl, apiKey: l.apiKey, api: l.api })

/** Providers grouped by the agent they were imported from, in discovery order. */
export function groupProviders(providers: LlmProvider[] | undefined): { label: string; items: LlmProvider[] }[] {
  const out: { label: string; items: LlmProvider[] }[] = []
  for (const p of providers ?? []) {
    const g = out.find((g) => g.label === p.sourceLabel)
    if (g) g.items.push(p)
    else out.push({ label: p.sourceLabel, items: [p] })
  }
  return out
}

/** Builds grouped Combobox options for imported LLM providers, keeping a top default option first. */
export function buildProviderOptions(
  providers: LlmProvider[] | undefined,
  topOption: { value: string; label: string; keywords?: string },
  current?: { source: string; provider: string },
): ComboboxOption[] {
  const out: ComboboxOption[] = [topOption]
  if (
    current?.source &&
    !providers?.some((p) => p.source === current.source && p.id === current.provider)
  ) {
    out.push({
      value: `${current.source}\n${current.provider}`,
      label: `${current.source}/${current.provider} (не найден)`,
    })
  }
  for (const g of groupProviders(providers)) {
    for (const p of g.items) {
      out.push({
        value: `${p.source}\n${p.id}`,
        label: p.label,
        group: g.label,
        hint: p.hasKey ? undefined : 'нет ключа',
        keywords: `${p.source} ${p.id} ${p.baseUrl}`,
      })
    }
  }
  return out
}

export type PingSummary = {
  pending: boolean
  ms?: number
  reply?: string
  error?: string
}

/**
 * Model select plus a manual fallback, fed by the provider's live `/models` list. `inherit` adds
 * an empty value that means "the main settings' model", for the per-task pickers.
 */
export function ModelPicker({
  conn,
  providers,
  model,
  onModel,
  inherit,
  compact = false,
  variant = 'outlined',
  onPingState,
}: {
  conn: Llm
  providers: LlmProvider[] | undefined
  model: string
  onModel: (m: string) => void
  inherit?: string
  compact?: boolean
  variant?: 'filled' | 'outlined'
  onPingState?: (state: PingSummary) => void
}) {
  const [custom, setCustom] = useState(false)
  const selected = providers?.find((p) => p.source === conn.source && p.id === conn.provider)
  const key = connKey(conn)
  const draft = useDebounced(conn, 600)
  const connection = connKey(draft)
  const draftProvider = providers?.find((p) => p.source === draft.source && p.id === draft.provider)
  const enabled = draft.source ? !!draftProvider?.hasKey : !!(draft.baseUrl && draft.apiKey)
  const query = useQuery({
    queryKey: ['llm-models', connection],
    queryFn: () => api.llmModels(draft),
    enabled,
    staleTime: 300_000,
    retry: false,
  })
  // Until the debounce catches up, `query.data` still belongs to the previous provider.
  const list = (connection === key ? query.data : undefined) ?? selected?.models ?? []
  const keyless = selected?.hasKey === false

  // An empty model with `inherit` means the main connection's model: that is what a real call would use.
  const pingModel = inherit !== undefined && !model ? inherit : model
  const info = useQuery({
    queryKey: ['llm-model-info', conn.source, conn.provider, conn.source ? '' : conn.baseUrl, pingModel],
    queryFn: () => api.llmModelInfo(conn.source, conn.provider, conn.source ? '' : conn.baseUrl, pingModel),
    enabled: !!pingModel,
    staleTime: 3_600_000,
  })

  // One tiny request with the live draft connection: the answer proves the key, the model id and the host all work.
  const ping = useMutation({ mutationFn: () => api.llmPing({ ...conn, model: pingModel }, pingModel) })
  const resetPing = ping.reset
  // A stale "отвечает" must not survive a model or connection change.
  useEffect(() => { resetPing() }, [resetPing, key, pingModel])
  useEffect(() => {
    onPingState?.({
      pending: ping.isPending,
      ms: ping.data?.ms,
      reply: ping.data?.reply,
      error: ping.error ? errorText(ping.error) : undefined,
    })
  }, [onPingState, ping.isPending, ping.data, ping.error])

  const took = ping.data ? (ping.data.ms < 1000 ? `${ping.data.ms} мс` : `${(ping.data.ms / 1000).toFixed(1)} с`) : ''
  const reply = ping.data?.reply.replace(/\s+/g, ' ')

  const priceHint = info.data?.price
    ? `$${info.data.price.input} / $${info.data.price.output} за 1M токенов`
    : undefined
  const ctxHint = info.data?.contextWindow ? `контекст ${formatTokens(info.data.contextWindow)}` : undefined
  const modelMetaHint = [priceHint, ctxHint].filter(Boolean).join(' · ')

  const statusHint = keyless
    ? 'Нет ключа: список моделей — из конфига агента, проверка недоступна'
    : query.isFetching
      ? 'Загружаю список моделей…'
      : query.error
        ? `${errorText(query.error)}. Модель можно вписать вручную`
        : modelMetaHint || `Моделей: ${list.length}`

  const modelOptions = useMemo<ComboboxOption[]>(
    () => [
      ...(inherit !== undefined
        ? [{ value: '', label: inherit ? `Как основная (${inherit})` : 'Как основная', keywords: 'default основная' }]
        : []),
      ...list.map((m) => ({ value: m, label: m })),
    ],
    [inherit, list],
  )

  const picker =
    list.length > 0 && !custom ? (
      list.length >= SEARCH_SELECT_THRESHOLD ? (
        <Combobox
          label={compact ? undefined : 'Модель'}
          aria-label={compact ? 'Модель' : undefined}
          hint={compact ? undefined : statusHint}
          variant={variant}
          value={model}
          options={modelOptions}
          searchable
          allowCustom
          searchPlaceholder="Поиск модели…"
          customLabel={(q) => `Использовать «${q}»`}
          formatMissing={(v) => `${v} (нет в списке)`}
          action={{ label: 'Ввести вручную…', icon: 'edit', onSelect: () => setCustom(true) }}
          onChange={onModel}
        />
      ) : (
        <Select
          label={compact ? undefined : 'Модель'}
          aria-label={compact ? 'Модель' : undefined}
          hint={compact ? undefined : statusHint}
          variant={variant}
          value={model}
          onChange={(e) => {
            if (e.target.value === CUSTOM) setCustom(true)
            else onModel(e.target.value)
          }}
        >
          {inherit !== undefined && <option value="">{inherit ? `Как основная (${inherit})` : 'Как основная'}</option>}
          {!!model && !list.includes(model) && <option value={model}>{`${model} (нет в списке)`}</option>}
          {list.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM}>Другая модель…</option>
        </Select>
      )
    ) : (
      <TextField
        label={compact ? undefined : 'Модель'}
        aria-label={compact ? 'Модель' : undefined}
        hint={compact ? undefined : statusHint}
        variant={variant}
        value={model}
        placeholder={inherit !== undefined ? `Как основная (${inherit || 'не задана'})` : 'deepseek-flash'}
        spellCheck={false}
        onChange={(e) => onModel(e.target.value)}
      />
    )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{picker}</div>
        <div className={`flex shrink-0 items-center gap-1 ${compact ? '' : 'pt-5'}`}>
          <IconButton
            icon="refresh"
            label="Обновить список моделей"
            tipPos="left"
            disabled={!enabled}
            onClick={() => void query.refetch()}
          />
          {compact ? (
            <IconButton
              icon="network_check"
              label="Проверить, отвечает ли модель"
              tipPos="left"
              disabled={!enabled || !pingModel.trim() || ping.isPending}
              onClick={() => ping.mutate()}
            />
          ) : (
            <Button
              variant="text"
              icon="network_check"
              disabled={!enabled || !pingModel.trim() || ping.isPending}
              onClick={() => ping.mutate()}
            >
              Проверить
            </Button>
          )}
        </div>
      </div>

      {custom && list.length > 0 && (
        <Button variant="text" size="xs" className="self-start" onClick={() => setCustom(false)}>
          Выбрать из списка
        </Button>
      )}

      {keyless && (
        <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
          {`В ${selected.file} ключ не найден. `}
          {selected.source === 'omp'
            ? 'Проверьте apiKey в models.yml и переменную окружения или ключ в «Связке ключей» (macOS).'
            : 'Добавьте ключ в настройки агента.'}
          {' Затем сохраните настройки или выберите другое подключение.'}
        </p>
      )}
      {ping.isPending && <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Проверяю модель…</p>}
      {ping.data && (
        <p className="type-body-small text-[var(--app-success)]">
          {`Отвечает за ${took}${reply ? `: «${reply}»` : ''}`}
        </p>
      )}
      {ping.error && (
        <p className="type-body-small break-words text-[var(--md-sys-color-error)]" title={errorText(ping.error)}>
          Не отвечает: {errorText(ping.error)}
        </p>
      )}
    </div>
  )
}

const SOURCE_OPTIONS = [
  { value: 'agent', label: 'Из агента' },
  { value: 'manual', label: 'Вручную' },
] as const

/**
 * Provider picker: «Вручную» keeps the baseUrl/apiKey/api fields, imported providers are read from
 * the other coding agents' own configs, so a rotated key needs no re-entry here. Used by SetupWizard.
 */
export function LlmFields({
  llm,
  providers,
  onChange,
}: {
  llm: Llm
  providers: LlmProvider[] | undefined
  onChange: (patch: Partial<Llm>) => void
}) {
  const selected = providers?.find((p) => p.source === llm.source && p.id === llm.provider)
  const providerOptions = useMemo(
    () =>
      buildProviderOptions(
        providers,
        { value: '', label: 'Вручную', keywords: 'manual' },
        { source: llm.source, provider: llm.provider },
      ),
    [providers, llm.source, llm.provider],
  )
  const value = llm.source ? `${llm.source}\n${llm.provider}` : ''

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">Откуда взять модель</span>
        <Segmented
          label="Откуда взять модель"
          value={llm.source ? 'agent' : 'manual'}
          options={SOURCE_OPTIONS}
          onChange={(mode) => {
            if (mode === 'manual') {
              onChange({ source: '', provider: '' })
              return
            }
            const first = providers?.find((p) => p.hasKey) ?? providers?.[0]
            if (first) {
              const patch: Partial<Llm> = { source: first.source, provider: first.id }
              if (first.models.length > 0 && !first.models.includes(llm.model)) patch.model = first.models[0]
              onChange(patch)
            }
          }}
        />
      </div>

      {llm.source ? (
        <Combobox
          label="Провайдер"
          variant="outlined"
          value={value}
          options={providerOptions}
          searchable={6}
          searchPlaceholder="Поиск провайдера…"
          hint={
            selected?.hasKey
              ? `${selected.baseUrl} · ${selected.api === 'anthropic' ? 'Anthropic' : 'OpenAI-совместимый'} · ключ из ${selected.file}`
              : undefined
          }
          onChange={(v) => {
            if (!v) {
              onChange({ source: '', provider: '' })
              return
            }
            const [source, provider] = v.split('\n')
            const p = providers?.find((x) => x.source === source && x.id === provider)
            const patch: Partial<Llm> = { source, provider }
            if (p && p.models.length > 0 && !p.models.includes(llm.model)) patch.model = p.models[0]
            onChange(patch)
          }}
        />
      ) : (
        <>
          <SecretField
            label="API-ключ"
            variant="outlined"
            value={llm.apiKey}
            placeholder="sk-…"
            hint="Пусто — используется DEEPSEEK_API_KEY"
            onValueChange={(apiKey) => onChange({ apiKey })}
          />
          <TextField
            label="Адрес API"
            variant="outlined"
            value={llm.baseUrl}
            spellCheck={false}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
          />
          <Select
            label="Протокол"
            variant="outlined"
            value={llm.api}
            onChange={(e) => onChange({ api: e.target.value as Llm['api'] })}
          >
            <option value="openai">OpenAI-совместимый</option>
            <option value="anthropic">Anthropic</option>
          </Select>
        </>
      )}

      <ModelPicker conn={llm} providers={providers} model={llm.model} onModel={(model) => onChange({ model })} />
    </div>
  )
}
