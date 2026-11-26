import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon, Spinner, Switch } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { CardPreview } from '@/modules/Cards'
import { imageSettingsKey } from './ImageFields'
import { AppStatusChip } from './SettingsPrimitives'

/** Reads the active document color scheme so the card preview matches dark/light mode on open. */
export function detectDarkScheme(): boolean {
  if (typeof document !== 'undefined') {
    const inline = document.documentElement.style.colorScheme
    if (inline === 'dark') return true
    if (inline === 'light') return false
    if (typeof getComputedStyle === 'function') {
      const computed = getComputedStyle(document.documentElement).colorScheme
      if (computed.includes('dark') && !computed.includes('light')) return true
      if (computed.includes('light') && !computed.includes('dark')) return false
    }
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return true
}

/**
 * Sticky right dock on `anki`, `media` and `images` sections showing the live Anki card preview.
 * Uses the FNV-1a `imageSettingsKey` digest in the query key so API keys never appear in devtools.
 */
export function CardPreviewDock({ cfg }: { cfg: AppConfig }) {
  const [night, setNight] = useState(detectDarkScheme)
  const debounced = useDebounced({ anki: cfg.anki, images: cfg.images, tutor: cfg.tutor }, 300)
  const preview = useQuery({
    queryKey: ['card-preview', debounced.anki, imageSettingsKey(debounced.images, debounced.tutor)],
    queryFn: () => api.cardsPreview(debounced.anki, null, null, null, debounced.images, debounced.tutor),
    retry: false,
  })

  return (
    <aside
      aria-label="Предпросмотр карточки Anki"
      className="stats-scroll flex w-full flex-col gap-3 rounded-[28px] bg-[var(--md-sys-color-surface-container-low)] p-4 xl:sticky xl:top-[84px] xl:max-h-[calc(100vh-108px)] xl:self-start xl:overflow-y-auto"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon name="visibility" size={20} className="text-[var(--md-sys-color-primary)]" />
          <h3 className="type-title-medium type-emph">Предпросмотр</h3>
        </div>
        <Switch label="Ночной режим" checked={night} onChange={setNight} />
      </div>

      {preview.error ? (
        <p className="type-body-medium text-[var(--md-sys-color-error)]">{errorText(preview.error)}</p>
      ) : preview.data ? (
        <CardPreview
          preview={preview.data}
          night={night}
          onNightChange={setNight}
          segmentedSize="xs"
          toolbarEnd={
            <AppStatusChip tone="secondary" size="sm">
              живой
            </AppStatusChip>
          }
        />
      ) : (
        <div className="flex min-h-[260px] items-center justify-center">
          <Spinner label="Загружаю предпросмотр" />
        </div>
      )}
    </aside>
  )
}
