import { useState } from 'react'
import { api, errorText } from '@/common/api/tauri'
import type { ImagesConfig } from '@/common/types/ipc'
import { Field, Secret, Text, inputClass } from './SettingsPanel'

type Backend = ImagesConfig['backend']

export const IMAGE_BACKENDS: [Backend, string][] = [
  ['none', 'Нет'],
  ['openai', 'OpenAI-совместимый'],
  ['runware', 'Runware'],
  ['gemini', 'Google Gemini'],
  ['omp', 'omp'],
]

/** The key an image backend cannot work without; `none`/`omp` need nothing. */
export function imagesReady(images: ImagesConfig): boolean {
  switch (images.backend) {
    case 'openai':
      return !!images.openai.apiKey
    case 'runware':
      return !!images.runware.apiKey
    case 'gemini':
      return !!images.gemini.apiKey
    default:
      return true
  }
}

const TEST_PROMPT = 'A smiling man receiving a gift'

/** Image backend and its own settings, plus a live check that actually generates one picture. */
export function ImageFields({ images, disabled, onChange }: {
  images: ImagesConfig
  disabled: boolean
  onChange: (patch: Partial<ImagesConfig>) => void
}) {
  const [test, setTest] = useState<{ pending: boolean; url?: string; error?: string }>({ pending: false })
  const check = async () => {
    setTest({ pending: true })
    try {
      setTest({ pending: false, url: await api.imagesGenerate(TEST_PROMPT, images) })
    } catch (e) {
      setTest({ pending: false, error: errorText(e) })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {disabled && (
        <p className="type-body-small rounded-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-secondary-container)] px-3 py-2 text-[var(--md-sys-color-on-secondary-container)]">
          Используются настройки tutor
        </p>
      )}
      <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <Field label="Бэкенд">
          <select className={inputClass} value={images.backend} onChange={(e) => onChange({ backend: e.target.value as Backend })}>
            {IMAGE_BACKENDS.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </Field>

        {images.backend === 'openai' && (
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

        {images.backend === 'runware' && (
          <>
            <Field label="API-ключ">
              <Secret value={images.runware.apiKey} onChange={(apiKey) => onChange({ runware: { ...images.runware, apiKey } })} />
            </Field>
            <Field label="Модель">
              <Text value={images.runware.model} onChange={(model) => onChange({ runware: { ...images.runware, model } })} placeholder="runware:400@2" />
            </Field>
          </>
        )}

        {images.backend === 'gemini' && (
          <>
            <Field label="API-ключ">
              <Secret value={images.gemini.apiKey} onChange={(apiKey) => onChange({ gemini: { ...images.gemini, apiKey } })} />
            </Field>
            <Field label="Модель" hint="gemini-*-image или imagen-*">
              <Text value={images.gemini.model} onChange={(model) => onChange({ gemini: { ...images.gemini, model } })} placeholder="gemini-2.5-flash-image" />
            </Field>
          </>
        )}

        {images.backend === 'omp' && (
          <>
            <Field label="Модель картинки" hint="Пусто — модель роли image в omp">
              <Text value={images.omp.model} onChange={(model) => onChange({ omp: { ...images.omp, model } })} />
            </Field>
            <Field label="Модель агента">
              <Text value={images.omp.agentModel} onChange={(agentModel) => onChange({ omp: { ...images.omp, agentModel } })} placeholder="anthropic/claude-haiku-5-5" />
            </Field>
          </>
        )}

        <Field label="Стиль" hint="Добавляется к каждому промпту как «. Style: …»">
          <textarea
            rows={2}
            value={images.style}
            onChange={(e) => onChange({ style: e.target.value })}
            className={`${inputClass} resize-y`}
            placeholder="photorealistic, warm light"
          />
        </Field>
      </fieldset>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || test.pending || images.backend === 'none' || !imagesReady(images)}
          onClick={() => void check()}
          className="state-layer type-label-large relative rounded-full bg-[var(--md-sys-color-secondary-container)] px-4 py-1.5 text-[var(--md-sys-color-on-secondary-container)] disabled:opacity-40"
        >
          {test.pending ? 'Генерирую…' : 'Проверить'}
        </button>
        {test.error && <span className="type-body-small text-[var(--md-sys-color-error)]">{test.error}</span>}
      </div>
      {test.url && <img src={test.url} alt="Проверочная картинка" className="max-w-48 rounded-[var(--md-sys-shape-corner-small)]" />}
    </div>
  )
}
