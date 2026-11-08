import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { IconButton, Switch } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, ImageBackend, ImagesConfig } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { Field, Secret, Text, inputClass } from './SettingsPanel'

type Backend = ImagesConfig['backend']

export const IMAGE_BACKENDS: [Backend, string][] = [
  ['none', 'Нет'],
  ['openai', 'OpenAI-совместимый'],
  ['runware', 'Runware'],
  ['gemini', 'Google Gemini'],
  ['omp', 'omp'],
]

/** Backends that can actually generate; `none` only disables the whole route. */
const IMAGE_PROVIDERS: [ImageBackend, string][] = IMAGE_BACKENDS.filter(([id]) => id !== 'none') as [ImageBackend, string][]

const IMAGE_LABEL = Object.fromEntries(IMAGE_BACKENDS) as Record<Backend, string>

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

const TEST_PROMPT = 'A smiling man receiving a gift'

/** Credentials and model of one provider; shared by the primary and every enabled fallback. */
export function ProviderFields({ backend, images, disabled, onChange }: {
  backend: ImageBackend
  images: ImagesConfig
  disabled?: boolean
  onChange: (patch: Partial<ImagesConfig>) => void
}) {
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      {backend === 'openai' && (
        <>
          <Field label="Адрес API" hint="Любой OpenAI-совместимый прокси">
            <Text value={images.openai.baseUrl} onChange={(baseUrl) => onChange({ openai: { ...images.openai, baseUrl } })} />
          </Field>
          <Field label="API-ключ">
            <Secret value={images.openai.apiKey} onChange={(apiKey) => onChange({ openai: { ...images.openai, apiKey } })} placeholder="sk-…" />
          </Field>
          <Field label="Модель">
            <Text value={images.openai.model} onChange={(model) => onChange({ openai: { ...images.openai, model } })} placeholder="gpt-image-1" />
          </Field>
          <Field label="Размер">
            <Text value={images.openai.size} onChange={(size) => onChange({ openai: { ...images.openai, size } })} placeholder="1024x1024" />
          </Field>
        </>
      )}
      {backend === 'runware' && (
        <>
          <Field label="API-ключ">
            <Secret value={images.runware.apiKey} onChange={(apiKey) => onChange({ runware: { ...images.runware, apiKey } })} />
          </Field>
          <Field label="Модель">
            <Text value={images.runware.model} onChange={(model) => onChange({ runware: { ...images.runware, model } })} placeholder="runware:400@2" />
          </Field>
        </>
      )}
      {backend === 'gemini' && (
        <>
          <Field label="API-ключ">
            <Secret value={images.gemini.apiKey} onChange={(apiKey) => onChange({ gemini: { ...images.gemini, apiKey } })} />
          </Field>
          <Field label="Модель" hint="gemini-*-image или imagen-*">
            <Text value={images.gemini.model} onChange={(model) => onChange({ gemini: { ...images.gemini, model } })} placeholder="gemini-2.5-flash-image" />
          </Field>
        </>
      )}
      {backend === 'omp' && (
        <>
          <Field label="Модель картинки" hint="Пусто — модель роли image в omp; omp не сможет уйти в свою цепочку">
            <Text value={images.omp.model} onChange={(model) => onChange({ omp: { ...images.omp, model } })} />
          </Field>
          <Field label="Модель агента">
            <Text value={images.omp.agentModel} onChange={(agentModel) => onChange({ omp: { ...images.omp, agentModel } })} placeholder="anthropic/claude-haiku-5-5" />
          </Field>
        </>
      )}
    </fieldset>
  )
}

/** Arrow controls of one fallback row, matching the subtitle sources list. */
function RowControls({ index, count, enabled, canSwapPrimary, onUp, onDown }: {
  index: number
  count: number
  enabled: boolean
  /** The first enabled row can trade places with an app-owned primary. */
  canSwapPrimary: boolean
  onUp: () => void
  onDown: () => void
}) {
  const button = 'size-8 disabled:opacity-30'
  return (
    <>
      <IconButton
        icon="arrow_upward"
        label="Выше"
        tipPos="left"
        disabled={!enabled || (index === 0 && !canSwapPrimary)}
        onClick={onUp}
        className={button}
      />
      <IconButton
        icon="arrow_downward"
        label="Ниже"
        tipPos="left"
        disabled={!enabled || index === count - 1}
        onClick={onDown}
        className={button}
      />
    </>
  )
}

/** Primary image backend, ordered fallbacks, the resolved route and a live whole-route check. */
export function ImageFields({ images, tutor, disabled, onChange }: {
  images: ImagesConfig
  tutor: AppConfig['tutor']
  disabled: boolean
  onChange: (patch: Partial<ImagesConfig>) => void
}) {
  const [test, setTest] = useState<{ pending: boolean; image?: { dataUrl: string; provider: string; model: string }; error?: string }>({ pending: false })
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
      const image = await api.imagesGenerate(TEST_PROMPT, images, tutor)
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
    // Enabling appends to the end; disabling keeps every credential field untouched.
    setFallbacks([...images.fallbacks, backend])
  }
  const disable = (backend: ImageBackend) => setFallbacks(images.fallbacks.filter((b) => b !== backend))
  const move = (backend: ImageBackend, up: boolean) => {
    const from = images.fallbacks.indexOf(backend)
    if (from < 0) return
    const to = from + (up ? -1 : 1)
    if (up && from === 0) {
      // The first fallback trades places with an app-owned primary: the old primary was enabled too.
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
      <Field label="Основной провайдер">
        <select
          className={inputClass}
          value={images.backend}
          disabled={disabled}
          onChange={(e) => {
            const backend = e.target.value as Backend
            // Changing the primary removes it from the fallbacks; the old primary is not enabled by itself.
            onChange({ backend, fallbacks: images.fallbacks.filter((b) => b !== backend) })
          }}
        >
          {IMAGE_BACKENDS.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </Field>

      {images.backend !== 'none' && (
        <div className="flex flex-col gap-3 rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--md-sys-color-outline-variant)] p-3">
          <div className="flex items-center gap-2">
            <span className="type-label-large grow">{IMAGE_LABEL[images.backend]}</span>
            <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">
              {disabled ? 'не используется' : 'основной'}
            </span>
          </div>
          {/* Ownership locks the primary fields only; app-owned fallbacks stay editable. */}
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
              className={`flex flex-col gap-3 rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--md-sys-color-outline-variant)] p-3 ${enabled ? '' : 'bg-[var(--md-sys-color-surface-container)]'}`}
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

      <Field label="Стиль" hint="Добавляется к каждому промпту как «. Style: …»">
        <textarea
          rows={2}
          value={images.style}
          onChange={(e) => onChange({ style: e.target.value })}
          className={`${inputClass} resize-y`}
          placeholder="photorealistic, warm light"
        />
      </Field>

      <div className="flex flex-col gap-2 rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container)] p-3">
        <span className="type-label-large">Порядок попыток</span>
        {route.isLoading && <span className="type-body-small">Проверяю…</span>}
        {route.error && <span className="type-body-small text-[var(--md-sys-color-error)]">{errorText(route.error)}</span>}
        {route.data?.disabled && <span className="type-body-small">Генерация выключена.</span>}
        {route.data?.providers.map((p, i) => (
          <div key={`${p.backend}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="type-body-medium">{i + 1}. {IMAGE_LABEL[p.backend] ?? p.backend} · {p.model}</span>
            {p.inherited && <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">из tutor</span>}
            <span className={`type-label-small ${p.ready ? 'text-[var(--md-sys-color-primary)]' : 'text-[var(--md-sys-color-error)]'}`}>
              {p.ready ? 'готов' : (p.reason ?? 'не настроен')}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={test.pending || !canCheck}
          onClick={() => void check()}
          className="state-layer type-label-large relative rounded-full bg-[var(--md-sys-color-secondary-container)] px-4 py-1.5 text-[var(--md-sys-color-on-secondary-container)] disabled:opacity-40"
        >
          {test.pending ? 'Генерирую…' : 'Проверить'}
        </button>
        {test.error && <span className="type-body-small text-[var(--md-sys-color-error)]">{test.error}</span>}
      </div>
      {test.image && (
        <div className="flex flex-col gap-1">
          <img src={test.image.dataUrl} alt="Проверочная картинка" className="max-w-48 rounded-[var(--md-sys-shape-corner-small)]" />
          <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">
            {IMAGE_LABEL[test.image.provider as Backend] ?? test.image.provider} · {test.image.model}
          </span>
        </div>
      )}
    </div>
  )
}
