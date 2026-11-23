import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Chip, Icon, IconButton, Menu, MenuItem, Segmented, TextField } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, ImageBackend, ImagesConfig } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { SECTION_META, type NavSection } from '../lib/sections'
import {
  IMAGE_BACKENDS,
  IMAGE_LABEL,
  IMAGE_PROVIDERS,
  IMAGE_TEST_PROMPT,
  imageSettingsKey,
  ProviderFields,
  tutorOwnsImages,
} from './ImageFields'
import { AppStatusChip, SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'

const PRIMARY_OPTIONS = IMAGE_BACKENDS.map(([value, label]) => ({
  value,
  label: value === 'openai' ? 'OpenAI' : value === 'gemini' ? 'Gemini' : label,
}))

const PROVIDER_ICON: Record<ImageBackend, string> = {
  omp: 'smart_toy',
  gemini: 'auto_awesome',
  openai: 'cloud',
  runware: 'bolt',
}

const PROVIDER_SUMMARY = (backend: ImageBackend, images: ImagesConfig): string => {
  switch (backend) {
    case 'openai':
      return `${images.openai.model || 'gpt-image-1'} · ${images.openai.size || '1024x1024'}`
    case 'runware':
      return images.runware.model || 'runware:400@2'
    case 'gemini':
      return images.gemini.model || 'gemini-2.5-flash-image'
    case 'omp':
      return images.omp.model || 'роль image в omp'
  }
}

export function ImagesSection({
  cfg,
  set,
  changedKeys,
  focusId,
  onJump,
}: {
  cfg: AppConfig
  set: ApplyConfig
  changedKeys: Set<string>
  focusId?: string
  onJump: (section: NavSection, focusId?: string) => void
}) {
  const meta = SECTION_META.images
  const ownsImages = tutorOwnsImages(cfg.tutor)
  const images = cfg.images
  const onChange = (patch: Partial<ImagesConfig>) => set('images', patch)

  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [expandedUnused, setExpandedUnused] = useState<Set<ImageBackend>>(() => new Set())
  const [test, setTest] = useState<{
    pending: boolean
    image?: { dataUrl: string; provider: string; model: string }
    error?: string
  }>({ pending: false })

  const debounced = useDebounced({ images, tutor: cfg.tutor }, 400)
  const route = useQuery({
    queryKey: ['images-route', imageSettingsKey(debounced.images, debounced.tutor)],
    queryFn: () => api.imagesRoute(debounced.images, debounced.tutor),
    retry: false,
  })
  const canCheck = !!route.data && !route.data.disabled && route.data.providers.some((p) => p.ready)

  const check = async () => {
    setTest({ pending: true })
    try {
      const image = await api.imagesGenerate(IMAGE_TEST_PROMPT, images, cfg.tutor)
      setTest({ pending: false, image })
    } catch (e) {
      setTest({ pending: false, error: errorText(e) })
    }
  }

  const appPrimary: ImageBackend | null = !ownsImages && images.backend !== 'none' ? images.backend : null
  const activeProviders: { backend: ImageBackend; role: 'primary' | 'fallback'; index: number }[] = [
    ...(appPrimary ? [{ backend: appPrimary, role: 'primary' as const, index: 0 }] : []),
    ...images.fallbacks
      .filter((b) => b !== appPrimary)
      .map((backend, i) => ({ backend, role: 'fallback' as const, index: (appPrimary ? 1 : 0) + i })),
  ]
  const activeSet = new Set(activeProviders.map((p) => p.backend))
  const addable = IMAGE_PROVIDERS.filter(([id]) => !activeSet.has(id))
  const unused = IMAGE_PROVIDERS.filter(([id]) => !activeSet.has(id))

  const removeFromRoute = (backend: ImageBackend, role: 'primary' | 'fallback') => {
    if (role === 'primary') {
      // Promote first fallback to primary if one exists, otherwise disable primary.
      const [nextPrimary, ...rest] = images.fallbacks
      onChange({ backend: nextPrimary ?? 'none', fallbacks: rest })
    } else {
      onChange({ fallbacks: images.fallbacks.filter((b) => b !== backend) })
    }
  }

  const addFallback = (backend: ImageBackend) => {
    if (backend === appPrimary || images.fallbacks.includes(backend)) return
    onChange({ fallbacks: [...images.fallbacks, backend] })
    setAddMenuOpen(false)
  }

  const moveFallback = (backend: ImageBackend, step: -1 | 1) => {
    const idx = images.fallbacks.indexOf(backend)
    if (idx < 0) return
    if (step === -1 && idx === 0) {
      if (!appPrimary) return
      onChange({ backend, fallbacks: [appPrimary, ...images.fallbacks.slice(1).filter((b) => b !== appPrimary)] })
      return
    }
    const to = idx + step
    if (to < 0 || to >= images.fallbacks.length) return
    const next = [...images.fallbacks]
    ;[next[idx], next[to]] = [next[to], next[idx]]
    onChange({ fallbacks: next })
  }

  const focusMatchesUnused = (backend: ImageBackend) =>
    focusId === `images.${backend}` || Boolean(focusId?.startsWith(`images.${backend}.`))

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader title={meta.label} subtitle={meta.subtitle} icon={meta.icon} shape={meta.shape} tone={meta.tone} />

      {ownsImages && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] bg-[var(--md-sys-color-secondary-container)] px-4 py-3 text-[var(--md-sys-color-on-secondary-container)]">
          <span className="type-body-medium">
            Основной провайдер картинок берётся из настроек Tutor. Запасные провайдеры ниже задаются здесь.
          </span>
          <Button variant="text" size="xs" onClick={() => onJump('system', 'tutor.useImageSettings')}>
            К настройкам Tutor
          </Button>
        </div>
      )}

      <SettingGroup title="Маршрут" subtitle="Если основной провайдер не ответил, пробуются запасные по порядку.">
        <SettingRow
          focusId="images.backend"
          highlighted={focusId === 'images.backend'}
          changed={changedKeys.has('images.backend') || changedKeys.has('images.fallbacks')}
          configKey="images.backend · images.fallbacks"
          label="Порядок"
          below={
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {ownsImages && (
                  <>
                    <span className="type-label-large inline-flex h-10 items-center gap-2 rounded-full bg-[var(--md-sys-color-primary-container)] px-3.5 text-[var(--md-sys-color-on-primary-container)]">
                      <Icon name="school" size={18} />
                      из Tutor
                    </span>
                    {activeProviders.length > 0 && (
                      <Icon name="arrow_forward" size={18} className="text-[var(--md-sys-color-on-surface-variant)]" />
                    )}
                  </>
                )}

                {activeProviders.length === 0 && !ownsImages && (
                  <span className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
                    Генерация картинок выключена
                  </span>
                )}

                {activeProviders.map((entry, idx) => {
                  const isPrimary = entry.role === 'primary'
                  return (
                    <div key={entry.backend} className="flex items-center gap-2">
                      {idx > 0 && (
                        <Icon name="arrow_forward" size={18} className="text-[var(--md-sys-color-on-surface-variant)]" />
                      )}
                      <div
                        className={`inline-flex h-10 items-center gap-2 rounded-full pr-1.5 pl-1 ${
                          isPrimary
                            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                            : 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
                        }`}
                      >
                        <span
                          className={`type-label-large flex size-8 items-center justify-center rounded-full ${
                            isPrimary
                              ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]'
                              : 'bg-[var(--md-sys-color-secondary)] text-[var(--md-sys-color-on-secondary)]'
                          }`}
                        >
                          {entry.index + 1}
                        </span>
                        <span className="type-label-large type-emph">{IMAGE_LABEL[entry.backend]}</span>
                        <IconButton
                          icon="close"
                          size="sm"
                          label={`Убрать ${IMAGE_LABEL[entry.backend]} из маршрута`}
                          onClick={() => removeFromRoute(entry.backend, entry.role)}
                        />
                      </div>
                    </div>
                  )
                })}

                {addable.length > 0 && (
                  <div className="relative flex items-center gap-2">
                    {(activeProviders.length > 0 || ownsImages) && (
                      <Icon name="arrow_forward" size={18} className="text-[var(--md-sys-color-on-surface-variant)]" />
                    )}
                    <Chip
                      label="+ Добавить"
                      selected={false}
                      aria-haspopup="menu"
                      aria-expanded={addMenuOpen}
                      onClick={() => setAddMenuOpen((o) => !o)}
                    />
                    <Menu open={addMenuOpen} onClose={() => setAddMenuOpen(false)}>
                      {addable.map(([id, label]) => (
                        <MenuItem
                          key={id}
                          icon={PROVIDER_ICON[id]}
                          label={label}
                          onClick={() => addFallback(id)}
                        />
                      ))}
                    </Menu>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5 rounded-[16px] bg-[var(--md-sys-color-surface-container-lowest)] p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="type-label-large">Порядок попыток</span>
                  <Button variant="tonal" size="xs" disabled={test.pending || !canCheck} onClick={() => void check()}>
                    {test.pending ? 'Генерирую…' : 'Проверить маршрут'}
                  </Button>
                </div>
                {route.isLoading && <span className="type-body-small">Проверяю…</span>}
                {route.error && (
                  <span className="type-body-small text-[var(--md-sys-color-error)]">{errorText(route.error)}</span>
                )}
                {route.data?.disabled && <span className="type-body-small">Генерация выключена.</span>}
                {route.data?.providers.map((p, i) => (
                  <div key={`${p.backend}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="type-body-medium">
                      {i + 1}. {IMAGE_LABEL[p.backend] ?? p.backend} · {p.model}
                    </span>
                    {p.inherited && (
                      <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">из tutor</span>
                    )}
                    <span
                      className={`type-label-small ${p.ready ? 'text-[var(--app-success)]' : 'text-[var(--md-sys-color-error)]'}`}
                    >
                      {p.ready ? 'готов' : (p.reason ?? 'не настроен')}
                    </span>
                  </div>
                ))}
                {test.error && <span className="type-body-small text-[var(--md-sys-color-error)]">{test.error}</span>}
                {test.image && (
                  <div className="mt-2 flex flex-col gap-1">
                    <img
                      src={test.image.dataUrl}
                      alt="Проверочная картинка"
                      className="max-w-48 rounded-[var(--md-sys-shape-corner-small)]"
                    />
                    <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">
                      {IMAGE_LABEL[test.image.provider as ImagesConfig['backend']] ?? test.image.provider} · {test.image.model}
                    </span>
                  </div>
                )}
              </div>
            </div>
          }
        />

        <SettingRow
          label="Основной провайдер"
          below={
            <Segmented
              label="Основной провайдер картинок"
              value={images.backend}
              options={PRIMARY_OPTIONS}
              onChange={(backend) => {
                if (ownsImages) return
                onChange({ backend, fallbacks: images.fallbacks.filter((b) => b !== backend) })
              }}
            />
          }
        />

        <SettingRow
          focusId="images.style"
          highlighted={focusId === 'images.style'}
          changed={changedKeys.has('images.style')}
          configKey="images.style"
          label="Стиль"
          sub="Добавляется к каждой подсказке как «. Style: …»"
          below={
            <TextField
              aria-label="Стиль картинок"
              variant="outlined"
              value={images.style}
              placeholder="flat vector illustration, soft colors"
              onChange={(e) => onChange({ style: e.target.value })}
            />
          }
        />
      </SettingGroup>

      {activeProviders.map(({ backend, role }) => {
        const fbIndex = images.fallbacks.indexOf(backend)
        const isChanged =
          backend === 'omp'
            ? changedKeys.has('images.omp.model') || changedKeys.has('images.omp.agentModel')
            : backend === 'openai'
              ? changedKeys.has('images.openai.baseUrl') ||
                changedKeys.has('images.openai.apiKey') ||
                changedKeys.has('images.openai.model') ||
                changedKeys.has('images.openai.size')
              : changedKeys.has(`images.${backend}.apiKey`) || changedKeys.has(`images.${backend}.model`)

        return (
          <SettingGroup
            key={backend}
            title={IMAGE_LABEL[backend]}
            action={
              <div className="flex items-center gap-1.5">
                {role === 'fallback' && (
                  <>
                    <IconButton
                      icon="arrow_upward"
                      label="Поднять в маршруте"
                      size="sm"
                      disabled={fbIndex === 0 && !appPrimary}
                      onClick={() => moveFallback(backend, -1)}
                    />
                    <IconButton
                      icon="arrow_downward"
                      label="Опустить в маршруте"
                      size="sm"
                      disabled={fbIndex === images.fallbacks.length - 1}
                      onClick={() => moveFallback(backend, 1)}
                    />
                  </>
                )}
                <AppStatusChip tone={role === 'primary' ? 'primary' : 'secondary'} size="md">
                  {role === 'primary' ? 'основной' : 'запасной'}
                </AppStatusChip>
              </div>
            }
          >
            <SettingRow
              focusId={`images.${backend}`}
              highlighted={focusId === `images.${backend}` || focusId?.startsWith(`images.${backend}.`)}
              changed={isChanged}
              label={`Настройки ${IMAGE_LABEL[backend]}`}
              below={<ProviderFields backend={backend} images={images} onChange={onChange} />}
            />
          </SettingGroup>
        )
      })}

      {unused.length > 0 && (
        <SettingGroup
          title={unused.map(([, l]) => (l === 'OpenAI-совместимый' ? 'OpenAI' : l)).join(' и ')}
          subtitle="Не используются — добавьте в маршрут, чтобы настроить или включить как запасной."
        >
          {unused.map(([backend, label]) => {
            const expanded = expandedUnused.has(backend) || focusMatchesUnused(backend)
            const rowFocusId =
              backend === 'omp'
                ? 'images.omp'
                : expanded
                  ? `images.${backend}`
                  : `images.${backend}.apiKey`
            return (
              <SettingRow
                key={backend}
                focusId={rowFocusId}
                highlighted={focusMatchesUnused(backend)}
                icon={PROVIDER_ICON[backend]}
                label={label}
                sub={
                  backend === 'gemini' && !expanded ? (
                    <>
                      {PROVIDER_SUMMARY(backend, images)}
                      <span data-focus-id="images.gemini.model" aria-hidden="true" />
                    </>
                  ) : (
                    PROVIDER_SUMMARY(backend, images)
                  )
                }
                control={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="text"
                      size="xs"
                      onClick={() =>
                        setExpandedUnused((prev) => {
                          const next = new Set(prev)
                          if (next.has(backend)) next.delete(backend)
                          else next.add(backend)
                          return next
                        })
                      }
                    >
                      {expanded ? 'Свернуть' : 'Поля'}
                    </Button>
                    <Button variant="tonal" size="xs" icon="add" onClick={() => addFallback(backend)}>
                      В маршрут
                    </Button>
                  </div>
                }
                below={expanded ? <ProviderFields backend={backend} images={images} onChange={onChange} /> : undefined}
              />
            )
          })}
        </SettingGroup>
      )}
    </div>
  )
}
