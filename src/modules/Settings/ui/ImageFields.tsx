import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Button, Combobox, IconButton, Select, Switch, TextField, type ComboboxOption } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, ImageBackend, ImagesConfig } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { SEARCH_SELECT_THRESHOLD } from './LlmFields'
import { SecretField } from './SettingsPrimitives'

type Backend = ImagesConfig['backend']

export const IMAGE_BACKENDS: [Backend, string][] = [
  ['none', 'Нет'],
  ['openai', 'OpenAI-совместимый'],
  ['runware', 'Runware'],
  ['gemini', 'Google Gemini'],
  ['omp', 'omp'],
]

/** Backends that can actually generate; `none` only disables the whole route. */
export const IMAGE_PROVIDERS: [ImageBackend, string][] = IMAGE_BACKENDS.filter(
  ([id]) => id !== 'none',
) as [ImageBackend, string][]

export const IMAGE_LABEL = Object.fromEntries(IMAGE_BACKENDS) as Record<Backend, string>
const CUSTOM = '__custom__'

/** Tutor's image settings replace the app-owned primary; the app's fallbacks stay its own. */
export function tutorOwnsImages(tutor: AppConfig['tutor']): boolean {
  return tutor.enabled && tutor.useImageSettings
}

/**
 * The effective primary -> fallback order the settings summaries show, without a backend call.
 * A tutor-owned primary has no name until the route is resolved, so it is shown as «из tutor».
 */
export function imageRouteLabel(images: ImagesConfig, tutor: AppConfig['tutor']): string {
  const inherited = tutorOwnsImages(tutor)
  const primary = !inherited && images.backend !== 'none' ? images.backend : null
  if (inherited) {
    const rest = images.fallbacks.map((id) => IMAGE_LABEL[id] ?? id)
    return ['из tutor', ...rest].join(' → ')
  }
  if (!primary) {
    if (images.fallbacks.length === 0) return 'выключены'
    return `выключены · в очереди: ${images.fallbacks.map((id) => IMAGE_LABEL[id] ?? id).join(' → ')}`
  }
  return [primary, ...images.fallbacks].map((id) => IMAGE_LABEL[id] ?? id).join(' → ')
}

/**
 * FNV-1a of the full unsaved image/tutor settings. Query keys and TanStack devtools only ever see
 * this digest: the objects contain provider API keys and must not be rendered there.
 */
export function imageSettingsKey(images: ImagesConfig, tutor: AppConfig['tutor']): string {
  const json = JSON.stringify({ images, tutor })
  let hash = 0x811c9dc5
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export const IMAGE_TEST_PROMPT = 'A smiling man receiving a gift'

/** Credentials and model of one provider; shared by the primary and every enabled fallback. */
export function ProviderFields({
  backend,
  images,
  disabled,
  onChange,
}: {
  backend: ImageBackend
  images: ImagesConfig
  disabled?: boolean
  onChange: (patch: Partial<ImagesConfig>) => void
}) {
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      {backend === 'openai' && (
        <>
          <TextField
            label="Адрес API"
            hint="Любой OpenAI-совместимый прокси"
            variant="outlined"
            value={images.openai.baseUrl}
            spellCheck={false}
            onChange={(e) => onChange({ openai: { ...images.openai, baseUrl: e.target.value } })}
          />
          <div id="setting-images.openai.apiKey" data-focus-id="images.openai.apiKey">
            <SecretField
              label="API-ключ"
              variant="outlined"
              value={images.openai.apiKey}
              placeholder="sk-…"
              onValueChange={(apiKey) => onChange({ openai: { ...images.openai, apiKey } })}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField
              label="Модель"
              variant="outlined"
              value={images.openai.model}
              placeholder="gpt-image-1"
              spellCheck={false}
              onChange={(e) => onChange({ openai: { ...images.openai, model: e.target.value } })}
            />
            <TextField
              label="Размер"
              variant="outlined"
              value={images.openai.size}
              placeholder="1024x1024"
              spellCheck={false}
              onChange={(e) => onChange({ openai: { ...images.openai, size: e.target.value } })}
            />
          </div>
        </>
      )}
      {backend === 'runware' && (
        <>
          <div id="setting-images.runware.apiKey" data-focus-id="images.runware.apiKey">
            <SecretField
              label="API-ключ"
              variant="outlined"
              value={images.runware.apiKey}
              onValueChange={(apiKey) => onChange({ runware: { ...images.runware, apiKey } })}
            />
          </div>
          <TextField
            label="Модель"
            variant="outlined"
            value={images.runware.model}
            placeholder="runware:400@2"
            spellCheck={false}
            onChange={(e) => onChange({ runware: { ...images.runware, model: e.target.value } })}
          />
        </>
      )}
      {backend === 'gemini' && (
        <>
          <div id="setting-images.gemini.apiKey" data-focus-id="images.gemini.apiKey">
            <SecretField
              label="API-ключ"
              hint="Google AI Studio"
              variant="outlined"
              value={images.gemini.apiKey}
              onValueChange={(apiKey) => onChange({ gemini: { ...images.gemini, apiKey } })}
            />
          </div>
          <div id="setting-images.gemini.model" data-focus-id="images.gemini.model">
            <TextField
              label="Модель"
              hint="gemini-*-image или imagen-*"
              variant="outlined"
              value={images.gemini.model}
              placeholder="gemini-2.5-flash-image"
              spellCheck={false}
              onChange={(e) => onChange({ gemini: { ...images.gemini, model: e.target.value } })}
            />
          </div>
        </>
      )}
      {backend === 'omp' && (
        <>
          <OmpImageModel
            value={images.omp.model}
            disabled={disabled}
            onChange={(model) => onChange({ omp: { ...images.omp, model } })}
          />
          <OmpAgentModel
            value={images.omp.agentModel}
            disabled={disabled}
            onChange={(agentModel) => onChange({ omp: { ...images.omp, agentModel } })}
          />
        </>
      )}
    </fieldset>
  )
}

function OmpCatalogPicker({
  label,
  value,
  disabled,
  placeholder,
  searchPlaceholder,
  hint,
  defaultOption,
  groups,
  onChange,
}: {
  label: string
  value: string
  disabled?: boolean
  placeholder: string
  searchPlaceholder: string
  hint?: string
  defaultOption?: { label: string; keywords?: string }
  groups: [string, string[]][]
  onChange: (value: string) => void
}) {
  const [custom, setCustom] = useState(false)
  const options = useMemo<ComboboxOption[]>(() => {
    const out: ComboboxOption[] = []
    if (defaultOption) out.push({ value: '', label: defaultOption.label, keywords: defaultOption.keywords })
    for (const [provider, models] of groups) {
      for (const model of models) {
        out.push({ value: model, label: model, group: provider })
      }
    }
    return out
  }, [defaultOption, groups])
  const listed = options.some((o) => o.value === value)
  const hasCatalog = groups.length > 0

  return (
    <div className="flex flex-col gap-2">
      {hasCatalog && !custom ? (
        options.length >= SEARCH_SELECT_THRESHOLD ? (
          <Combobox
            label={label}
            hint={hint}
            variant="outlined"
            value={value}
            disabled={disabled}
            placeholder={defaultOption ? defaultOption.label : 'Выберите модель'}
            searchPlaceholder={searchPlaceholder}
            options={options}
            searchable
            allowCustom
            customLabel={(q) => `Использовать «${q}»`}
            formatMissing={(v) => `${v} (нет в списке)`}
            action={{ label: 'Ввести вручную…', icon: 'edit', onSelect: () => setCustom(true) }}
            onChange={onChange}
          />
        ) : (
          <Select
            label={label}
            hint={hint}
            variant="outlined"
            value={value}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value === CUSTOM) setCustom(true)
              else onChange(e.target.value)
            }}
          >
            {defaultOption ? (
              <option value="">{defaultOption.label}</option>
            ) : (
              !value && (
                <option value="" disabled>
                  Выберите модель
                </option>
              )
            )}
            {value && !listed && <option value={value}>{`${value} (нет в списке)`}</option>}
            {groups.map(([provider, models]) => (
              <optgroup key={provider} label={provider}>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={CUSTOM}>Другая модель…</option>
          </Select>
        )
      ) : (
        <TextField
          label={label}
          hint={hint}
          variant="outlined"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {!disabled && custom && hasCatalog && (
        <Button variant="text" size="xs" className="self-start" onClick={() => setCustom(false)}>
          Выбрать из списка
        </Button>
      )}
    </div>
  )
}

export function OmpImageModel({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const catalog = useQuery({
    queryKey: ['images-omp-image-models'],
    queryFn: api.imagesOmpImageModels,
    enabled: !disabled,
    staleTime: 300_000,
    retry: false,
  })
  const groups = useMemo(() => Object.entries(catalog.data ?? {}), [catalog.data])
  const hint = disabled
    ? undefined
    : catalog.isFetching
      ? 'Загружаю модели картинок из omp…'
      : catalog.error
        ? 'Пусто — модель роли image в omp; модель можно вписать вручную'
        : 'Пусто — модель роли image в omp; omp не сможет уйти в свою цепочку'

  return (
    <OmpCatalogPicker
      label="Модель картинки"
      value={value}
      disabled={disabled}
      placeholder="роль image"
      searchPlaceholder="Поиск модели картинки…"
      hint={hint}
      defaultOption={{ label: 'Роль image в omp (по умолчанию)', keywords: 'default role роль по умолчанию' }}
      groups={groups}
      onChange={onChange}
    />
  )
}

export function OmpAgentModel({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const catalog = useQuery({
    queryKey: ['images-omp-agent-models'],
    queryFn: api.imagesOmpAgentModels,
    enabled: !disabled,
    staleTime: 300_000,
    retry: false,
  })
  const groups = useMemo(() => Object.entries(catalog.data ?? {}), [catalog.data])
  const hint = disabled
    ? undefined
    : catalog.isFetching
      ? 'Загружаю модели из omp…'
      : catalog.error
        ? `${errorText(catalog.error)}. Модель можно вписать вручную`
        : groups.length === 0
          ? 'В каталоге omp нет моделей агента. Модель можно вписать вручную'
          : 'Агент, через которого omp вызывает generate_image'

  return (
    <OmpCatalogPicker
      label="Модель агента"
      value={value}
      disabled={disabled}
      placeholder="anthropic/claude-haiku-5-5"
      searchPlaceholder="Поиск модели агента…"
      hint={hint}
      groups={groups}
      onChange={onChange}
    />
  )
}

/** Arrow controls of one fallback row. */
function RowControls({
  index,
  count,
  enabled,
  canSwapPrimary,
  onUp,
  onDown,
}: {
  index: number
  count: number
  enabled: boolean
  /** The first enabled row can trade places with an app-owned primary. */
  canSwapPrimary: boolean
  onUp: () => void
  onDown: () => void
}) {
  return (
    <>
      <IconButton
        icon="arrow_upward"
        label="Выше"
        size="sm"
        tipPos="left"
        disabled={!enabled || (index === 0 && !canSwapPrimary)}
        onClick={onUp}
      />
      <IconButton
        icon="arrow_downward"
        label="Ниже"
        size="sm"
        tipPos="left"
        disabled={!enabled || index === count - 1}
        onClick={onDown}
      />
    </>
  )
}

/** Primary image backend, ordered fallbacks, the resolved route and a live whole-route check. */
export function ImageFields({
  images,
  tutor,
  disabled,
  onChange,
}: {
  images: ImagesConfig
  tutor: AppConfig['tutor']
  disabled: boolean
  onChange: (patch: Partial<ImagesConfig>) => void
}) {
  const [test, setTest] = useState<{
    pending: boolean
    image?: { dataUrl: string; provider: string; model: string }
    error?: string
  }>({ pending: false })
  const debounced = useDebounced({ images, tutor }, 400)
  const route = useQuery({
    // The draft contains API keys, so the query key is a digest and devtools never see them.
    queryKey: ['images-route', imageSettingsKey(debounced.images, debounced.tutor)],
    queryFn: () => api.imagesRoute(debounced.images, debounced.tutor),
    retry: false,
  })
  // The whole unsaved route is the unit being checked: one ready fallback still makes it useful.
  const canCheck = !!route.data && !route.data.disabled && route.data.providers.some((p) => p.ready)

  const check = async () => {
    setTest({ pending: true })
    try {
      const image = await api.imagesGenerate(IMAGE_TEST_PROMPT, images, tutor)
      setTest({ pending: false, image })
    } catch (e) {
      setTest({ pending: false, error: errorText(e) })
    }
  }

  // A tutor-owned primary is not an app choice; the app's saved backend is then just another provider.
  const appPrimary: ImageBackend | null = !disabled && images.backend !== 'none' ? images.backend : null
  const candidates = IMAGE_PROVIDERS.filter(([id]) => id !== appPrimary)
  const rows: [ImageBackend, string][] = [
    ...images.fallbacks.flatMap((id) => {
      const row = candidates.find(([candidate]) => candidate === id)
      return row ? [row] : []
    }),
    ...candidates.filter(([id]) => !images.fallbacks.includes(id)),
  ]

  const setFallbacks = (fallbacks: ImageBackend[]) => onChange({ fallbacks })
  const enable = (backend: ImageBackend) => {
    if (images.fallbacks.includes(backend) || backend === appPrimary) return
    setFallbacks([...images.fallbacks, backend])
  }
  const disable = (backend: ImageBackend) => setFallbacks(images.fallbacks.filter((b) => b !== backend))
  const move = (backend: ImageBackend, up: boolean) => {
    const from = images.fallbacks.indexOf(backend)
    if (from < 0) return
    const to = from + (up ? -1 : 1)
    if (up && from === 0) {
      if (!appPrimary) return
      onChange({ backend, fallbacks: [appPrimary, ...images.fallbacks.slice(1).filter((b) => b !== appPrimary)] })
      return
    }
    if (to < 0 || to >= images.fallbacks.length) return
    const next = [...images.fallbacks]
    ;[next[from], next[to]] = [next[to], next[from]]
    setFallbacks(next)
  }

  return (
    <div className="flex flex-col gap-4">
      {disabled && (
        <p className="type-body-small rounded-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-secondary-container)] px-3 py-2 text-[var(--md-sys-color-on-secondary-container)]">
          Основной провайдер берётся из настроек tutor. Запасные провайдеры ниже задаются здесь.
        </p>
      )}
      <Select
        label="Основной провайдер"
        variant="outlined"
        value={images.backend}
        disabled={disabled}
        onChange={(e) => {
          const backend = e.target.value as Backend
          onChange({ backend, fallbacks: images.fallbacks.filter((b) => b !== backend) })
        }}
      >
        {IMAGE_BACKENDS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </Select>

      {images.backend !== 'none' && (
        <div className="flex flex-col gap-3 rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--md-sys-color-outline-variant)] p-3">
          <div className="flex items-center gap-2">
            <span className="type-label-large grow">{IMAGE_LABEL[images.backend]}</span>
            <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">
              {disabled ? 'не используется' : 'основной'}
            </span>
          </div>
          <ProviderFields backend={images.backend} images={images} onChange={onChange} disabled={disabled} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="type-label-large">Запасные провайдеры</span>
        <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
          Включайте в порядке попыток: после отказа основного приложение переходит к следующему. Выключение
          убирает провайдера из очереди, сохранённые ключи и модели остаются.
        </p>
        {rows.map(([backend, label]) => {
          const index = images.fallbacks.indexOf(backend)
          const enabled = index >= 0
          return (
            <div
              key={backend}
              className={`flex flex-col gap-3 rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--md-sys-color-outline-variant)] p-3 ${
                enabled ? '' : 'bg-[var(--md-sys-color-surface-container)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="type-label-small w-4 shrink-0 text-center text-[var(--md-sys-color-on-surface-variant)]">
                  {enabled ? index + 1 : ''}
                </span>
                <span className="type-label-large grow">{label}</span>
                <RowControls
                  index={index}
                  count={images.fallbacks.length}
                  enabled={enabled}
                  canSwapPrimary={!!appPrimary}
                  onUp={() => move(backend, true)}
                  onDown={() => move(backend, false)}
                />
                <Switch
                  ariaLabel={`${label}: запасной провайдер`}
                  checked={enabled}
                  onChange={(on) => (on ? enable(backend) : disable(backend))}
                />
              </div>
              {enabled && <ProviderFields backend={backend} images={images} onChange={onChange} />}
            </div>
          )
        })}
      </div>

      <TextField
        multiline
        rows={2}
        label="Стиль"
        hint="Добавляется к каждому промпту как «. Style: …»"
        variant="outlined"
        value={images.style}
        placeholder="photorealistic, warm light"
        onChange={(e) => onChange({ style: e.target.value })}
      />

      <div className="flex flex-col gap-2 rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-low)] p-3">
        <span className="type-label-large">Порядок попыток</span>
        {route.isLoading && <span className="type-body-small">Проверяю…</span>}
        {route.error && <span className="type-body-small text-[var(--md-sys-color-error)]">{errorText(route.error)}</span>}
        {route.data?.disabled && <span className="type-body-small">Генерация выключена.</span>}
        {route.data?.providers.map((p, i) => (
          <div key={`${p.backend}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="type-body-medium">
              {i + 1}. {IMAGE_LABEL[p.backend] ?? p.backend} · {p.model}
            </span>
            {p.inherited && <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">из tutor</span>}
            <span className={`type-label-small ${p.ready ? 'text-[var(--app-success)]' : 'text-[var(--md-sys-color-error)]'}`}>
              {p.ready ? 'готов' : (p.reason ?? 'не настроен')}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="tonal" size="xs" disabled={test.pending || !canCheck} onClick={() => void check()}>
          {test.pending ? 'Генерирую…' : 'Проверить'}
        </Button>
        {test.error && <span className="type-body-small text-[var(--md-sys-color-error)]">{test.error}</span>}
      </div>
      {test.image && (
        <div className="flex flex-col gap-1">
          <img
            src={test.image.dataUrl}
            alt="Проверочная картинка"
            className="max-w-48 rounded-[var(--md-sys-shape-corner-small)]"
          />
          <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">
            {IMAGE_LABEL[test.image.provider as Backend] ?? test.image.provider} · {test.image.model}
          </span>
        </div>
      )}
    </div>
  )
}
