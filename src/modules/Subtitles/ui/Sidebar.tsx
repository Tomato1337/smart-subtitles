import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
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

/** First cue of the analysis batch `idx` belongs to (the backend analyses 40 cues at a time). */
const batchOf = (idx: number) => Math.floor(idx / 40) * 40

/**
 * Wave under the focused row: fills from the phrase start until the next phrase takes focus.
 * While playing, WavyProgress follows the video clock every frame by itself, through refs: the
 * old `setState` per animation frame re-rendered this row 60 times a second all film long, and
 * WebKitGTK feeds the video from that same main thread. Paused, the store's time is enough.
 */
function FocusProgress({ from, to }: { from: number; to: number }) {
 const player = usePlayer()
 const playing = usePlaybackStore((s) => s.playing)
 // While playing the store time is not needed (the clock drives the wave): no 10 Hz re-renders.
 const absTime = usePlaybackStore((s) => (s.playing ? -1 : s.absTime))
 const frac = useCallback((t: number) => Math.min(1, Math.max(0, (t - from) / Math.max(0.001, to - from))), [from, to])
 const clock = useCallback(() => frac(player.now()), [frac, player])
 return (
  <WavyProgress
   className="mt-3 h-3.5 w-full"
   value={playing ? clock() : frac(absTime)}
   clock={playing ? clock : undefined}
   amp={2}
   len={18}
   stroke={4}
   animated={playing}
  />
 )
}

type Props = {
 mediaId: string
 onReplay: (cue: Cue) => void
 onSlowReplay: (cue: Cue) => void
 onCard: (cue: Cue) => void
 onExplain: (cue: Cue) => void
 /**
  * Renders the English text of a row (Anki labels live in the composing layer); `active` = the focused phrase.
  * Keep it referentially stable (useCallback): rows are memoized and a new function re-renders all of them.
  */
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

/** Row callbacks; one object for the whole list that never changes, so memoized rows stay put. */
type RowHandlers = {
 seek: (cue: Cue) => void
 replay: (cue: Cue) => void
 slow: (cue: Cue) => void
 card: (cue: Cue) => void
 explain: (cue: Cue) => void
 retry: (cue: Cue) => void
}

function RowActions({ cue, on, compact }: { cue: Cue; on: RowHandlers; compact?: boolean }) {
 // The whole row seeks on click, so every action stops the propagation the old button did.
 const act = (fn: (c: Cue) => void) => (e: MouseEvent) => { e.stopPropagation(); fn(cue) }
 const size = compact ? 'sm' : 'md'
 return (
  <div className={compact ? 'flex gap-1' : 'flex gap-2'}>
   <IconButton size={size} variant="tonal" icon="replay" label="Повторить" onClick={act(on.replay)} />
   <IconButton size={size} variant="tonal" icon="volume_up" label="Медленно" onClick={act(on.slow)} />
   <IconButton size={size} variant={compact ? 'tonal' : 'anki'} icon="add" label="Фразу в Anki" onClick={act(on.card)} />
   <IconButton
    size={size}
    variant={compact ? 'tonal' : 'tertiary'}
    shape={compact ? undefined : 'cookie9'}
    fill={!compact}
    className={compact ? undefined : '!size-11'}
    icon="auto_awesome"
    label="Объяснить агентом"
    onClick={act(on.explain)}
   />
  </div>
 )
}

type RowProps = {
 cue: Cue
 ann: CueAnnotation | undefined
 active: boolean
 /** Focus window of the active row in absolute time (0 for the other rows, so they keep equal props). */
 focusFrom: number
 focusTo: number
 font: keyof typeof FONT
 translation: boolean
 needsRetry: boolean
 on: RowHandlers
 renderEn: Props['renderEn']
}

/**
 * One dialog row. Memoized: a phrase change re-renders only the row that lost focus and the one
 * that got it, not every visible row (each with its word spans and four icon buttons).
 *
 * The focus change itself is instant in layout terms: the old 300 ms `grid-template-rows` expand
 * re-laid out the list every frame and made Virtuoso re-measure and re-render all rows each frame,
 * a main-thread stall at every phrase change that showed as a hitch in the film. Now only the
 * action row fades in (opacity/transform, which the compositor animates).
 */
const CueRow = memo(function CueRow({ cue, ann, active, focusFrom, focusTo, font, translation, needsRetry, on, renderEn }: RowProps) {
 const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
  e.preventDefault()
  on.seek(cue)
 }
 return (
  <div
   role="button"
   tabIndex={0}
   aria-current={active || undefined}
   onClick={() => on.seek(cue)}
   onKeyDown={onKeyDown}
   style={active ? ACTIVE_VARS : undefined}
   className={`group relative cursor-pointer overflow-hidden transition-colors duration-300 ease-out ${active
    ? 'my-1 rounded-[var(--md-sys-shape-corner-extra-large)] bg-[var(--active-bg)] px-4 pb-3 pt-4 text-[var(--md-sys-color-on-secondary-container)]'
    : 'mx-2 my-0.5 rounded-[var(--md-sys-shape-corner-large)] px-4 py-3 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_6%,transparent)]'}`}
  >
   <div className={`type-label-medium font-semibold tabular-nums ${active ? 'text-[var(--md-sys-color-on-secondary-container)]' : 'text-[var(--md-sys-color-primary)]'}`}>{formatTime(cue.start)}</div>
   <div
    className={`${active ? FONT_ACTIVE[font] : FONT[font]} mt-3 min-w-0 whitespace-pre-line break-words font-semibold text-[var(--app-dialog-text)]`}
    style={active ? { fontStretch: '108%' } : undefined}
   >
    {renderEn(cue, ann, active)}
   </div>
   {translation && ann?.ru && (
    <div className="type-body-medium mt-1 min-w-0 whitespace-pre-line break-words text-[var(--app-dialog-text)]">{ann.ru}</div>
   )}
   {needsRetry && (
    <button type="button" className={`type-label-small mt-1 flex items-center gap-1 ${active ? 'text-[var(--md-sys-color-on-secondary-container)]' : 'text-[var(--md-sys-color-primary)]'}`} onClick={(e) => { e.stopPropagation(); on.retry(cue) }}>
     <Icon name="refresh" size={14} /> перевести снова
    </button>
   )}
   {active ? (
    <div className="row-actions-in">
     <div className="pt-4"><RowActions cue={cue} on={on} /></div>
     <FocusProgress from={focusFrom} to={focusTo} />
    </div>
   ) : (
    // Shown on hover and while a button inside has keyboard focus (they used to stay invisible when tabbed to).
    <div className="absolute right-2 top-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
     <RowActions cue={cue} on={on} compact />
    </div>
   )}
  </div>
 )
})

/** Memoized: with stable callbacks from the player screen, its re-renders do not reach the list. */
export const Sidebar = memo(function Sidebar({ mediaId, onReplay, onSlowReplay, onCard, onExplain, renderEn }: Props) {
 const player = usePlayer()
 // Only the fields the list shows: the whole store also changes on analysis progress, reveal, status…
 const { cues, annotations, offset, showSidebarTranslation, sidebarFont, failedBatches, set } = useSubsStore(useShallow((s) => ({
  cues: s.cues, annotations: s.annotations, offset: s.offset, showSidebarTranslation: s.showSidebarTranslation,
  sidebarFont: s.sidebarFont, failedBatches: s.failedBatches, set: s.set,
 })))
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

 // Keep the focused phrase centered; manual wheel/touch scrolling pauses it for 5 s. Nearby phrases glide,
 // long jumps (seek, first load) snap. Deferred a little so Virtuoso has measured the resized rows.
 const prevFocused = useRef(-1)
 useEffect(() => {
  const prev = prevFocused.current
  prevFocused.current = focused
  if (focused < 0 || query || Date.now() - lastScroll.current < 5000) return
  const near = prev >= 0 && Math.abs(focused - prev) <= 3
  const t = setTimeout(() => list.current?.scrollToIndex({ index: focused, align: 'center', behavior: near ? 'smooth' : 'auto' }), 80)
  return () => clearTimeout(t)
 }, [focused, query, cues.length])

 // Handlers read the latest props when called, so the object handed to the rows never changes.
 const latest = useRef({ mediaId, offset, onReplay, onSlowReplay, onCard, onExplain })
 useLayoutEffect(() => { latest.current = { mediaId, offset, onReplay, onSlowReplay, onCard, onExplain } })
 const on = useMemo<RowHandlers>(() => ({
  seek: (c) => { lastScroll.current = 0; player.seek(c.start + latest.current.offset) },
  replay: (c) => latest.current.onReplay(c),
  slow: (c) => latest.current.onSlowReplay(c),
  card: (c) => latest.current.onCard(c),
  explain: (c) => latest.current.onExplain(c),
  retry: (c) => { void api.annotRetry(latest.current.mediaId, batchOf(c.idx)) },
 }), [player])

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
      aria-label="Поиск по EN и RU"
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
       const active = cue.idx === focused
       return (
        <CueRow
         cue={cue}
         ann={ann}
         active={active}
         focusFrom={active ? cue.start + offset : 0}
         focusTo={active ? focusEnd(cues, cue.idx, offset) : 0}
         font={sidebarFont}
         translation={showSidebarTranslation}
         needsRetry={!ann && failedBatches.has(batchOf(cue.idx))}
         on={on}
         renderEn={renderEn}
        />
       )
      }}
     />
    )}
   </div>
  </aside>
 )
})
