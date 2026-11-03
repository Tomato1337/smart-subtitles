import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { api } from '@/common/api/tauri'
import type { Cue, CueAnnotation } from '@/common/types/ipc'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { Menu, MenuItem, MenuDivider } from '@/common/ui/Menu'
import { formatTime } from '@/common/utilities/time'
import { usePlaybackStore, usePlayer } from '@/modules/Player'
import { focusEnd } from '../lib/cues'
import { useSubsStore } from '../store/subsStore'
import { useFocusedCueIndex } from '../useActiveCue'

/** Bar along the bottom of the focused row: fills from the phrase start until the next phrase takes focus. */
function FocusProgress({ from, to }: { from: number; to: number }) {
  const f = usePlaybackStore((s) => Math.min(1, Math.max(0, (s.absTime - from) / Math.max(0.001, to - from))))
  return (
    <div className="absolute inset-x-0 bottom-0 h-1 bg-[var(--md-sys-color-surface-container-highest)]" aria-hidden>
      <div className="h-full bg-[var(--md-sys-color-primary)] transition-[width] duration-100 ease-linear" style={{ width: `${f * 100}%` }} />
    </div>
  )
}

type Props = {
  mediaId: string
  onReplay: (cue: Cue) => void
  onSlowReplay: (cue: Cue) => void
  onCard: (cue: Cue) => void
  onExplain: (cue: Cue) => void
  /** Renders the English text of a row (Anki labels live in the composing layer); `active` = the focused phrase. */
  renderEn: (cue: Cue, ann: CueAnnotation | undefined, active: boolean) => ReactNode
}

const FONT = { S: 'type-title-small', M: 'type-title-medium', L: 'type-title-large' } as const

function TonalButton({ icon, label, onClick, compact }: { icon: string; label: string; onClick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`state-layer state-on-surface relative flex items-center justify-center bg-[var(--md-sys-color-surface-container-highest)] text-[var(--md-sys-color-on-surface)] ${compact ? 'size-7 rounded-[var(--md-sys-shape-corner-small)]' : 'size-10 rounded-[var(--md-sys-shape-corner-medium)]'}`}
    >
      <Icon name={icon} size={compact ? 18 : 22} />
    </button>
  )
}

function RowActions({ cue, p, compact }: { cue: Cue; p: Pick<Props, 'onReplay' | 'onSlowReplay' | 'onCard' | 'onExplain'>; compact?: boolean }) {
  return (
    <div className={compact ? 'flex gap-1' : 'flex gap-2'}>
      <TonalButton compact={compact} icon="replay" label="Повторить" onClick={() => p.onReplay(cue)} />
      <TonalButton compact={compact} icon="volume_up" label="Медленно" onClick={() => p.onSlowReplay(cue)} />
      <TonalButton compact={compact} icon="add" label="Фразу в Anki" onClick={() => p.onCard(cue)} />
      <TonalButton compact={compact} icon="auto_awesome" label="Объяснить агентом" onClick={() => p.onExplain(cue)} />
    </div>
  )
}

export function Sidebar({ mediaId, onReplay, onSlowReplay, onCard, onExplain, renderEn }: Props) {
  const player = usePlayer()
  const { cues, annotations, offset, showSidebarTranslation, sidebarFont, failedBatches, set } = useSubsStore()
  const focused = useFocusedCueIndex()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [gear, setGear] = useState(false)
  const list = useRef<VirtuosoHandle>(null)
  const lastScroll = useRef(0)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cues
    return cues.filter((c) => c.text.toLowerCase().includes(q) || (annotations.get(c.idx)?.ru ?? '').toLowerCase().includes(q))
  }, [cues, annotations, query])

  // Keep the focused phrase centered; manual wheel/touch scrolling pauses it for 5 s.
  // Moving to a nearby phrase glides once the rows finished expanding/collapsing (300 ms), so the target
  // is measured and the list moves in one motion; long jumps (seek, first load) snap right away.
  const prevFocused = useRef(-1)
  useEffect(() => {
    const prev = prevFocused.current
    prevFocused.current = focused
    if (focused < 0 || query || Date.now() - lastScroll.current < 5000) return
    const near = prev >= 0 && Math.abs(focused - prev) <= 3
    // Deferred so Virtuoso has measured the freshly loaded / resized rows.
    const t = setTimeout(
      () => list.current?.scrollToIndex({ index: focused, align: 'center', behavior: near ? 'smooth' : 'auto' }),
      near ? 320 : 60,
    )
    return () => clearTimeout(t)
  }, [focused, query, cues.length])

  const actions = { onReplay, onSlowReplay, onCard, onExplain }

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col bg-[var(--md-sys-color-surface-container-low)]" aria-label="Диалоги">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="type-title-medium px-2">Диалоги</h2>
        <div className="relative flex">
          <IconButton icon="settings" label="Настройки списка" data-menu-trigger onClick={() => setGear((v) => !v)} />
          <IconButton icon="search" label="Поиск" selected={searching} onClick={() => { setSearching((v) => !v); setQuery('') }} />
          <IconButton icon="close" label="Свернуть" onClick={() => set({ sidebarOpen: false })} />
          <Menu open={gear} onClose={() => setGear(false)} align="right">
            <MenuItem label="Показывать перевод" on={showSidebarTranslation} onClick={() => set({ showSidebarTranslation: !showSidebarTranslation })} />
            <MenuDivider title="Размер шрифта" />
            {(['S', 'M', 'L'] as const).map((s) => (
              <MenuItem key={s} label={s} selected={sidebarFont === s} onClick={() => set({ sidebarFont: s })} />
            ))}
          </Menu>
        </div>
      </div>
      {searching && (
        <div className="px-3 pb-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по EN и RU"
            className="type-body-medium w-full rounded-full bg-[var(--md-sys-color-surface-container-highest)] px-4 py-2 outline-none"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-x-hidden" onWheel={() => { lastScroll.current = Date.now() }} onTouchMove={() => { lastScroll.current = Date.now() }}>
        {rows.length === 0 ? (
          <p className="type-body-medium p-4 text-[var(--md-sys-color-on-surface-variant)]">{cues.length === 0 ? 'Реплик пока нет' : 'Ничего не найдено'}</p>
        ) : (
          <Virtuoso
            ref={list}
            style={{ overflowX: 'hidden' }}
            data={rows}
            computeItemKey={(_, c) => c.idx}
            itemContent={(_, cue) => {
              const ann = annotations.get(cue.idx)
              const isActive = cue.idx === focused
              const needsRetry = !ann && failedBatches.has(Math.floor(cue.idx / 40) * 40)
              return (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { lastScroll.current = 0; player.seek(cue.start + offset) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') player.seek(cue.start + offset) }}
                  className={`group relative cursor-pointer overflow-hidden border-l-4 px-5 py-4 transition-colors duration-300 ease-out ${isActive ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-surface-container-high)]' : 'border-transparent hover:bg-[var(--md-sys-color-surface-container)]'}`}
                >
                  <div className="type-label-medium font-bold tracking-wide text-[var(--md-sys-color-primary)]">{formatTime(cue.start)}</div>
                  <div className={`${FONT[sidebarFont]} mt-3 min-w-0 whitespace-pre-line break-words font-semibold`}>{renderEn(cue, ann, isActive)}</div>
                  {showSidebarTranslation && ann?.ru && (
                    <div className="type-body-medium mt-1 min-w-0 whitespace-pre-line break-words text-[var(--md-sys-color-on-surface-variant)]">{ann.ru}</div>
                  )}
                  {needsRetry && (
                    <button type="button" className="type-label-small mt-1 flex items-center gap-1 text-[var(--md-sys-color-primary)]" onClick={(e) => { e.stopPropagation(); void api.annotRetry(mediaId, Math.floor(cue.idx / 40) * 40) }}>
                      <Icon name="refresh" size={14} /> перевести снова
                    </button>
                  )}
                  <div inert={!isActive} className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${isActive ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                    <div className="overflow-hidden"><div className="pt-4"><RowActions cue={cue} p={actions} /></div></div>
                  </div>
                  {isActive && <FocusProgress from={cue.start + offset} to={focusEnd(cues, cue.idx, offset)} />}
                  {!isActive && (
                    <div className="absolute right-2 top-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                      <RowActions cue={cue} p={actions} compact />
                    </div>
                  )}
                </div>
              )
            }}
          />
        )}
      </div>
    </aside>
  )
}
