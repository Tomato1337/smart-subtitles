import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { api } from '@/common/api/tauri'
import type { Cue, CueAnnotation } from '@/common/types/ipc'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { Menu, MenuItem, MenuDivider } from '@/common/ui/Menu'
import { WavyProgress } from '@/common/ui/WavyProgress'
import { formatTime } from '@/common/utilities/time'
import { usePlaybackStore, usePlayer } from '@/modules/Player'
import { focusEnd } from '../lib/cues'
import { useSubsStore } from '../store/subsStore'
import { useFocusedCueIndex } from '../useActiveCue'

/**
 * Wave under the focused row: fills from the phrase start until the next phrase takes focus.
 * While playing it follows the video clock every frame: the store's absTime ticks at 10 Hz, which
 * on a two-second phrase moved the wave end in visible steps.
 */
function FocusProgress({ from, to }: { from: number; to: number }) {
 const player = usePlayer()
 const absTime = usePlaybackStore((s) => s.absTime)
 const playing = usePlaybackStore((s) => s.playing)
 const [clock, setClock] = useState<number | null>(null)
 useEffect(() => {
  if (!playing) { setClock(null); return }
  let raf = requestAnimationFrame(function frame() {
   setClock(player.now())
   raf = requestAnimationFrame(frame)
  })
  return () => cancelAnimationFrame(raf)
 }, [playing, player])
 const now = playing && clock !== null ? clock : absTime
 const f = Math.min(1, Math.max(0, (now - from) / Math.max(0.001, to - from)))
 return <WavyProgress className="mt-3 h-3.5 w-full" value={f} amp={2} len={18} stroke={4} animated={playing} />
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
const FONT_ACTIVE = { S: 'type-title-medium', M: 'type-title-large', L: 'type-title-large' } as const

/**
 * Row colours for the active cue: tonal buttons and the wave read them from the container.
 * The container is secondary-container pulled toward the surface: on the plain tone the dimmed,
 * not-yet-spoken karaoke words lacked contrast.
 */
const ACTIVE_VARS = {
 '--active-bg': 'color-mix(in srgb, var(--md-sys-color-secondary-container) 65%, var(--md-sys-color-surface-container-lowest))',
 '--tonal-bg': 'color-mix(in srgb, var(--md-sys-color-on-secondary-container) 12%, transparent)',
 '--tonal-fg': 'var(--md-sys-color-on-secondary-container)',
 '--wave-active': 'var(--md-sys-color-on-secondary-container)',
 '--wave-track': 'color-mix(in srgb, var(--md-sys-color-on-secondary-container) 20%, transparent)',
} as CSSProperties

function RowActions({ cue, p, compact }: { cue: Cue; p: Pick<Props, 'onReplay' | 'onSlowReplay' | 'onCard' | 'onExplain'>; compact?: boolean }) {
 // The whole row seeks on click, so every action stops the propagation the old button did.
 const act = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn() }
 const size = compact ? 'sm' : 'md'
 return (
  <div className={compact ? 'flex gap-1' : 'flex gap-2'}>
   <IconButton size={size} variant="tonal" icon="replay" label="Повторить" onClick={act(() => p.onReplay(cue))} />
   <IconButton size={size} variant="tonal" icon="volume_up" label="Медленно" onClick={act(() => p.onSlowReplay(cue))} />
   <IconButton size={size} variant={compact ? 'tonal' : 'anki'} icon="add" label="Фразу в Anki" onClick={act(() => p.onCard(cue))} />
   <IconButton
    size={size}
    variant={compact ? 'tonal' : 'tertiary'}
    shape={compact ? undefined : 'cookie9'}
    fill={!compact}
    className={compact ? undefined : '!size-11'}
    icon="auto_awesome"
    label="Объяснить агентом"
    onClick={act(() => p.onExplain(cue))}
   />
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
  <aside data-tour="sidebar" className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner-extra-large)] bg-[var(--md-sys-color-surface-container-low)]" aria-label="Диалоги">
   <div className="flex items-center justify-between pl-6 pr-2 pt-4 pb-2">
    <h2 className="type-title-large type-emph">Диалоги</h2>
    <div className="relative flex">
     <IconButton icon="tune" label="Настройки списка" data-menu-trigger onClick={() => setGear((v) => !v)} />
     <IconButton icon="search" label="Поиск" selected={searching} onClick={() => { setSearching((v) => !v); setQuery('') }} />
     <IconButton icon="left_panel_close" label="Свернуть" onClick={() => set({ sidebarOpen: false })} />
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
      className="type-body-medium h-10 w-full rounded-full bg-[var(--md-sys-color-surface-container-highest)] px-4 outline-none"
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
         aria-current={isActive || undefined}
         onClick={() => { lastScroll.current = 0; player.seek(cue.start + offset) }}
         onKeyDown={(e) => { if (e.key === 'Enter') player.seek(cue.start + offset) }}
         style={isActive ? ACTIVE_VARS : undefined}
         className={`group relative cursor-pointer overflow-hidden transition-colors duration-300 ease-out ${isActive
          ? 'my-1 rounded-[var(--md-sys-shape-corner-extra-large)] bg-[var(--active-bg)] px-4 pb-3 pt-4 text-[var(--md-sys-color-on-secondary-container)]'
          : 'mx-2 my-0.5 rounded-[var(--md-sys-shape-corner-large)] px-4 py-3 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_6%,transparent)]'}`}
        >
         <div className={`type-label-medium font-semibold tabular-nums ${isActive ? 'text-[var(--md-sys-color-on-secondary-container)]' : 'text-[var(--md-sys-color-primary)]'}`}>{formatTime(cue.start)}</div>
         <div
          className={`${isActive ? FONT_ACTIVE[sidebarFont] : FONT[sidebarFont]} mt-3 min-w-0 whitespace-pre-line break-words font-semibold text-[var(--app-dialog-text)]`}
          style={isActive ? { fontStretch: '108%' } : undefined}
         >
          {renderEn(cue, ann, isActive)}
         </div>
         {showSidebarTranslation && ann?.ru && (
          <div className="type-body-medium mt-1 min-w-0 whitespace-pre-line break-words text-[var(--app-dialog-text)]">{ann.ru}</div>
         )}
         {needsRetry && (
          <button type="button" className={`type-label-small mt-1 flex items-center gap-1 ${isActive ? 'text-[var(--md-sys-color-on-secondary-container)]' : 'text-[var(--md-sys-color-primary)]'}`} onClick={(e) => { e.stopPropagation(); void api.annotRetry(mediaId, Math.floor(cue.idx / 40) * 40) }}>
           <Icon name="refresh" size={14} /> перевести снова
          </button>
         )}
         <div inert={!isActive} className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${isActive ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <div className="overflow-hidden">
           <div className="pt-4"><RowActions cue={cue} p={actions} /></div>
           {isActive && <FocusProgress from={cue.start + offset} to={focusEnd(cues, cue.idx, offset)} />}
          </div>
         </div>
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
