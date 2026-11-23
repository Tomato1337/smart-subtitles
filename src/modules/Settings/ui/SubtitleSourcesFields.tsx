import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, IconButton, ListGroup, Switch } from '@tomato1337/m3e-react'
import type { SubtitleSource } from '@/common/types/ipc'
import { AppStatusChip } from './SettingsPrimitives'

const SOURCES: [SubtitleSource, string, string][] = [
  ['torrserver', 'TorrServer', 'Субтитры из той же раздачи'],
  ['sidecar', 'Рядом с файлом', '.srt и .ass рядом с видео или из Lampa'],
  ['embedded', 'В контейнере', 'Дорожки внутри mkv; с диска сразу, из TorrServer по частям'],
  ['opensubtitles', 'OpenSubtitles', 'Поиск по названию и хешу'],
]

const INFO = new Map(SOURCES.map(([id, title, hint]) => [id, { title, hint }]))

/**
 * Order of the automatic subtitle search: enabled sources first (in order), disabled below.
 * Supports pointer drag-and-drop on the handle (with Esc cancel and layout midpoints) as well
 * as ArrowUp/ArrowDown keyboard reordering and explicit move buttons.
 */
export function SubtitleSourcesFields({
  sources,
  hasOpenSubtitlesKey,
  onChange,
}: {
  sources: SubtitleSource[]
  hasOpenSubtitlesKey: boolean
  onChange: (s: SubtitleSource[]) => void
}) {
  const rows: SubtitleSource[] = [
    ...sources.filter((id) => INFO.has(id)),
    ...SOURCES.map(([id]) => id).filter((id) => !sources.includes(id)),
  ]

  const [announcement, setAnnouncement] = useState('')
  const [draggingId, setDraggingId] = useState<SubtitleSource | null>(null)
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null)
  const [dragOffsetY, setDragOffsetY] = useState(0)
  const [dropSlot, setDropSlot] = useState<number | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<SubtitleSource, HTMLDivElement>())
  const handleRefs = useRef(new Map<SubtitleSource, HTMLButtonElement>())

  const dragRef = useRef<{
    id: SubtitleSource
    pointerId: number
    startY: number
    fromIndex: number
    currentSlot: number
  } | null>(null)

  const reorder = useCallback(
    (id: SubtitleSource, toIndex: number) => {
      const fromIndex = sources.indexOf(id)
      if (fromIndex < 0) return
      const clamped = Math.max(0, Math.min(sources.length - 1, toIndex))
      if (fromIndex === clamped) return
      const next = [...sources]
      const [item] = next.splice(fromIndex, 1)
      next.splice(clamped, 0, item)
      onChange(next)
      const label = INFO.get(id)?.title ?? id
      setAnnouncement(`${label} перемещён на позицию ${clamped + 1} из ${next.length}`)
    },
    [sources, onChange],
  )

  const moveStep = useCallback(
    (id: SubtitleSource, step: -1 | 1, focusAfter?: 'up' | 'down' | 'handle') => {
      const from = sources.indexOf(id)
      const to = from + step
      if (from < 0 || to < 0 || to >= sources.length) return
      reorder(id, to)
      if (focusAfter === 'handle') {
        requestAnimationFrame(() => handleRefs.current.get(id)?.focus({ preventScroll: true }))
      }
    },
    [sources, reorder],
  )

  const computeSlot = useCallback(
    (clientY: number): number => {
      const enabledIds = sources.filter((id) => INFO.has(id))
      if (enabledIds.length <= 1) return 0
      for (let i = 0; i < enabledIds.length; i += 1) {
        const el = rowRefs.current.get(enabledIds[i])
        if (!el) continue
        const rect = el.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        if (clientY < mid) return i
      }
      return enabledIds.length - 1
    },
    [sources],
  )

  const finishDrag = useCallback(
    (commit: boolean) => {
      const active = dragRef.current
      if (!active) return
      dragRef.current = null
      setDraggingId(null)
      setDragFromIndex(null)
      setDragOffsetY(0)
      setDropSlot(null)
      if (commit && active.currentSlot !== active.fromIndex) {
        reorder(active.id, active.currentSlot)
      } else if (!commit) {
        const label = INFO.get(active.id)?.title ?? active.id
        setAnnouncement(`Перемещение «${label}» отменено`)
      }
    },
    [reorder],
  )

  useEffect(() => {
    if (!draggingId) return
    const onMove = (e: PointerEvent) => {
      const active = dragRef.current
      if (!active || e.pointerId !== active.pointerId) return
      setDragOffsetY(e.clientY - active.startY)
      const slot = computeSlot(e.clientY)
      active.currentSlot = slot
      setDropSlot(slot)
    }
    const onUp = (e: PointerEvent) => {
      const active = dragRef.current
      if (!active || e.pointerId !== active.pointerId) return
      finishDrag(true)
    }
    const onCancel = (e: PointerEvent) => {
      const active = dragRef.current
      if (!active || e.pointerId !== active.pointerId) return
      finishDrag(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finishDrag(false)
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [draggingId, computeSlot, finishDrag])

  return (
    <div className="flex flex-col gap-2" ref={listRef}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <ListGroup className={draggingId ? 'cursor-grabbing' : undefined}>
        {rows.map((id) => {
          const pos = sources.indexOf(id)
          const on = pos >= 0
          const isDragging = draggingId === id
          const showDropLineAbove = draggingId !== null && dropSlot === pos && dragFromIndex !== null && dragFromIndex > pos
          const showDropLineBelow = draggingId !== null && dropSlot === pos && dragFromIndex !== null && dragFromIndex < pos
          const { title, hint } = INFO.get(id) ?? { title: id, hint: '' }
          const warn = id === 'opensubtitles' && !hasOpenSubtitlesKey

          return (
            <div
              key={id}
              ref={(el) => {
                if (el) rowRefs.current.set(id, el)
                else rowRefs.current.delete(id)
              }}
              style={
                isDragging
                  ? { transform: `translateY(${dragOffsetY}px)`, zIndex: 10, position: 'relative' }
                  : undefined
              }
              className={`relative flex items-center gap-3 px-4 py-3 transition-colors ${
                isDragging
                  ? 'bg-[var(--md-sys-color-surface-container-high)] shadow-[var(--md-sys-elevation-level2)] ring-2 ring-[var(--md-sys-color-primary)]'
                  : on
                    ? 'bg-[var(--md-sys-color-surface-container)]'
                    : 'bg-[var(--md-sys-color-surface-container-low)] opacity-75'
              }`}
            >
              {showDropLineAbove && (
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 -top-[2px] z-20 h-[3px] rounded-full bg-[var(--md-sys-color-primary)]" />
              )}
              {showDropLineBelow && (
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 -bottom-[2px] z-20 h-[3px] rounded-full bg-[var(--md-sys-color-primary)]" />
              )}

              <button
                ref={(el) => {
                  if (el) handleRefs.current.set(id, el)
                  else handleRefs.current.delete(id)
                }}
                type="button"
                disabled={!on || sources.length < 2}
                aria-label={`${title}: перетащите или используйте стрелки ↑ / ↓ для изменения порядка`}
                style={{ touchAction: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                onPointerDown={(e) => {
                  if (!on || sources.length < 2 || e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  dragRef.current = {
                    id,
                    pointerId: e.pointerId,
                    startY: e.clientY,
                    fromIndex: pos,
                    currentSlot: pos,
                  }
                  setDraggingId(id)
                  setDragFromIndex(pos)
                  setDragOffsetY(0)
                  setDropSlot(pos)
                }}
                onKeyDown={(e) => {
                  if (!on) return
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    moveStep(id, -1, 'handle')
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    moveStep(id, 1, 'handle')
                  }
                }}
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--md-sys-color-on-surface-variant)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--md-sys-color-primary)] ${
                  on && sources.length >= 2
                    ? 'cursor-grab hover:bg-[var(--md-sys-color-surface-container-highest)] active:cursor-grabbing'
                    : 'cursor-default opacity-30'
                }`}
              >
                <Icon name="drag_indicator" size={22} />
              </button>

              <span
                className={`type-label-large flex size-8 shrink-0 items-center justify-center rounded-full ${
                  on
                    ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
                    : 'bg-[var(--md-sys-color-surface-container-highest)] text-[var(--md-sys-color-on-surface-variant)]'
                }`}
              >
                {on ? pos + 1 : '—'}
              </span>

              <div className="flex min-w-0 flex-1 flex-col">
                <span className="type-title-medium type-emph">{title}</span>
                <span className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">{hint}</span>
              </div>

              {warn && (
                <AppStatusChip tone="error" size="md" icon="key_off" className="shrink-0">
                  нужен ключ
                </AppStatusChip>
              )}

              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  icon="arrow_upward"
                  label={`${title}: выше`}
                  size="sm"
                  tipPos="top"
                  disabled={!on || pos === 0}
                  onClick={() => moveStep(id, -1)}
                />
                <IconButton
                  icon="arrow_downward"
                  label={`${title}: ниже`}
                  size="sm"
                  tipPos="top"
                  disabled={!on || pos === sources.length - 1}
                  onClick={() => moveStep(id, 1)}
                />
              </div>

              <Switch
                ariaLabel={title}
                checked={on}
                onChange={(v) => {
                  onChange(v ? [...sources, id] : sources.filter((s) => s !== id))
                  setAnnouncement(v ? `${title} включён` : `${title} выключен`)
                }}
              />
            </div>
          )
        })}
      </ListGroup>
      {sources.length === 0 && (
        <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
          Автопоиск выключен: субтитры можно выбрать в плеере
        </p>
      )}
    </div>
  )
}
