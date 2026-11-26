import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useShallow } from 'zustand/react/shallow'
import { ButtonGroup, IconButton, Presence, ToggleButton, toast, usePresence } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { Cue, CueAnnotation, SessionState } from '@/common/types/ipc'
import { formatTime } from '@/common/utilities/time'
import { comboOf } from '@/common/utilities/keys'
import { AgentPanel, cueExplainPrompt, useAgentActions, useAgentEvents, useAgentStore } from '@/modules/Agent'
import { useAnkiEvents } from '@/modules/Anki'
import { CardsActivityButton, useCardIslandDock, useCardsStore } from '@/modules/Cards'
import { NotificationButton } from '@/modules/Notifications'
import { ExplainPopover, useExplainStore } from '@/modules/Explain'
import { actionFor, HotkeysDialog, useHotkeysStore, withKey, type HotkeyAction } from '@/modules/Hotkeys'
import { PatternBadges, PatternCard, usePatternExposure } from '@/modules/Patterns'
import { ControlBar, PlayerProvider, TopBar, usePlayer, usePlaybackStore, VideoSurface } from '@/modules/Player'
import { useSessionStore } from '@/modules/Session'
import {
 AnalysisLine, findCueByIdx, lastStartedBefore, nextCueIndex, prevCueIndex, Sidebar, startReveal, SubsChooserDialog, SubsLoadLine, SubsStatusBanner, SubtitleOverlay, useActiveCueIndex, useAnnotPriority, useSubsStore,
 useSubtitlesData,
 type SpanPick,
} from '@/modules/Subtitles'
import { TourOverlay } from '@/modules/Tour'
import { AnnotGate, headReady } from './AnnotGate'
import { CueLine } from './CueLine'
import { EmbeddedGate, embeddedHold } from './EmbeddedGate'
import { HighlightGuide } from './HighlightGuide'
import { markTourSeen, playerTourSteps, tourUnseen } from './playerTour'
import { SettingsMenu } from './SettingsMenu'
import { SLOW_RATE, replayStep, slowStep, type ReplayWindow, type SlowWindow } from './slowReplay'
import { useIdleVisible } from './useIdleHide'
import { useMediaSession } from './useMediaSession'

async function toggleFullscreen() {
 const w = getCurrentWindow()
 await w.setFullscreen(!(await w.isFullscreen()))
}

const INTERACTIVE_OVERLAY_SELECTOR =
 'dialog[open], [role="dialog"]:not([data-closing]), [role="menu"]:not([data-closing]), [role="listbox"]:not([data-closing]), [popover]:popover-open:not(.card-island):not(.m3e-snackbar):not([data-app-warning-stack]):not([data-closing])'

const INTERACTIVE_SPACE_TARGET_SELECTOR =
 'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="slider"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [role="tab"]'

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

export function isImeKeyEvent(e: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'>): boolean {
 return e.isComposing || e.key === 'Process' || e.keyCode === 229
}

export function shouldIgnorePlayerHotkey(
 e: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode' | 'code' | 'target'>,
 options: { explainOpen: boolean; doc?: Document },
): boolean {
 if (isImeKeyEvent(e)) return true
 const targetEl = typeof Element !== 'undefined' && e.target instanceof Element ? e.target : null
 if (targetEl?.closest('input,textarea,select,[contenteditable]')) return true
 const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
 if (doc?.querySelector(INTERACTIVE_OVERLAY_SELECTOR)) return true
 if (options.explainOpen) return true
 if ((e.code === 'Space' || e.key === ' ') && targetEl?.closest(INTERACTIVE_SPACE_TARGET_SELECTOR)) return true
 if (SLIDER_KEYS.has(e.key) && targetEl?.closest('[role="slider"]')) return true
 return false
}

export function cardDedupKey(mediaId: string, cueIdx: number, span: string | null): string {
 return `${mediaId}:${cueIdx}:${span ?? ''}`
}

export function shouldFinishSessionClose(currentSessionId: string | null | undefined, closingSessionId: string): boolean {
 return !currentSessionId || currentSessionId === closingSessionId
}

function useMediaQuery(query: string): boolean {
 const [matches, setMatches] = useState(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false))
 useEffect(() => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  const mql = window.matchMedia(query)
  setMatches(mql.matches)
  const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
 }, [query])
 return matches
}

/** "Where am I" line of the agent chat: film time and the last started cue. */
function AgentHere() {
 const cues = useSubsStore((s) => s.cues)
 const offset = useSubsStore((s) => s.offset)
 const sec = usePlaybackStore((s) => Math.floor(s.absTime))
 const i = usePlaybackStore((s) => lastStartedBefore(cues, s.absTime, offset))
 const line = i >= 0 ? ` · «${cues[i].text.replace(/\s*\n\s*/g, ' ')}»` : ''
 return <>Сейчас {formatTime(sec)}{line}</>
}

/**
 * Its own component: the active cue index changes at every cue start and end, and in `WatchLayout`
 * each change re-rendered the whole player screen, a main-thread stall that froze the film for a moment.
 */
function PatternExposure({ mediaId }: { mediaId: string }) {
 usePatternExposure(mediaId, useActiveCueIndex())
 return null
}

/** Tracks any modal dialog, notification panel, or open menu outside Sidebar without polling. */
function useDomOverlayOpen() {
 const [open, setOpen] = useState(false)
 useEffect(() => {
  let raf = 0
  const check = () => {
   raf = 0
   setOpen(Boolean(document.querySelector(INTERACTIVE_OVERLAY_SELECTOR)))
  }
  const schedule = () => {
   if (!raf) raf = requestAnimationFrame(check)
  }
  check()
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
   childList: true,
   subtree: true,
   attributes: true,
   attributeFilter: ['open', 'role', 'data-closing'],
  })
  return () => {
   if (raf) cancelAnimationFrame(raf)
   observer.disconnect()
  }
 }, [])
 return open
}

/** Isolates popover/modal/menu wake subscriptions from WatchLayout so hover popovers never re-render the video stage. */
function SidebarDock({ modalOpen, ...props }: ComponentProps<typeof Sidebar> & { modalOpen: boolean }) {
 const explainOpen = useExplainStore((s) => s.target !== null)
 const cardsModalOpen = useCardsStore((s) => s.activityOpen || s.editor !== null)
 const domOverlayOpen = useDomOverlayOpen()
 return <Sidebar {...props} keepAwake={modalOpen || explainOpen || cardsModalOpen || domOverlayOpen} />
}

function WatchLayout({ session, onBack }: { session: SessionState; onBack: () => void }) {
 const p = usePlayer()
 const playing = usePlaybackStore((s) => s.playing)
 const visible = useIdleVisible(!playing)
 const topBarRef = useRef<HTMLDivElement>(null)
 useCardIslandDock(topBarRef, visible)
 // Selected fields only: a whole-store subscription re-rendered the entire player screen (video, overlay,
 // dialog list, dock) on every analysis batch, status or progress update of the subtitles.
 const subs = useSubsStore(useShallow((s) => ({
  sidebarOpen: s.sidebarOpen, hideMode: s.hideMode, showEn: s.showEn, showRu: s.showRu, patterns: s.patterns,
  set: s.set, embedded: s.embedded, annot: s.annot, hasCues: s.cues.length > 0,
 })))
 const slow = useRef<{ win: SlowWindow; timer: ReturnType<typeof setInterval> } | null>(null)
 const replayEnd = useRef<{ win: ReplayWindow; timer: ReturnType<typeof setInterval> } | null>(null)
 useSubtitlesData(session.mediaId, session.subOffset)
 useAnnotPriority(session.mediaId)
 useAnkiEvents()
 useAgentEvents(session.mediaId)
 /** Position sent with every agent message: the given cue, or the last cue started at the playhead. */
 const locate = useCallback((cueIdx?: number) => {
  const { cues, offset } = useSubsStore.getState()
  if (cueIdx !== undefined) {
   const cue = findCueByIdx(cues, cueIdx)
   if (cue) return { cueIdx: cue.idx, at: cue.start + offset }
  }
  const i = lastStartedBefore(cues, p.now(), offset)
  return { cueIdx: i >= 0 ? cues[i].idx : null, at: p.now() }
 }, [p])
 const agent = useAgentActions(session.mediaId, locate)
 const chatOpen = useAgentStore((s) => s.open)
 // The page behind the player is black too: whatever shows through a rounded or composited edge
 // (the video card's corners) must not be the light-theme surface.
 useEffect(() => {
  const prev = document.body.style.background
  document.body.style.background = '#000'
  return () => { document.body.style.background = prev }
 }, [])
 const hotkey = useHotkeysStore((s) => s.bindings)
 // The actions only: the popover target changes on every hover, which must not re-render this screen.
 const explain = useExplainStore(useShallow((s) => ({ pinOpen: s.pinOpen, hoverOpen: s.hoverOpen, hoverLeave: s.hoverLeave })))
 useEffect(() => () => useExplainStore.getState().close(), [session.mediaId])
 const cardInFlight = useRef(new Set<string>())
 const config = useQuery({ queryKey: ['config'], queryFn: api.configGet, staleTime: 60_000 })
 const [guide, setGuide] = useState(false)
 const [hotkeysOpen, setHotkeysOpen] = useState(false)
 const [subsOpen, setSubsOpen] = useState(false)
 const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
 const openGuide = useCallback(() => { p.pause(); setGuide(true) }, [p])

 // Consent dialog: asked once per mount, as soon as the cues and the analysis state are known.
 const [gate, setGate] = useState<'ask' | 'wait' | null>(null)
 const [resumeOnClose, setResumeOnClose] = useState(false)
 // Embedded subtitles: the film waits for the first part of the track until the user skips it.
 const [skipped, setSkipped] = useState(false)
 const hold = embeddedHold(subs.embedded, skipped)
 // The tour points at what is on screen, so it waits for the consent dialog and the subtitle hold.
 const [tour, setTour] = useState(tourUnseen)
 const tourShown = tour && gate === null && hold === null
 const openTour = useCallback(() => setTour(true), [])
 const tourSteps = useMemo(() => playerTourSteps(hotkey, openGuide), [hotkey, openGuide])
 // `playing` is a dependency on purpose: the film autoplays once its stream is ready, so pausing only
 // when the tour appears would leave it running underneath.
 useEffect(() => { if (tourShown && playing) p.pause() }, [tourShown, playing, p])
 const decided = useRef(false)
 // The gate effect re-runs on every analysis update, so its answer must outlive the effect itself;
 // only unmounting may drop it (StrictMode runs the body and the cleanup twice, hence the reset).
 const mounted = useRef(true)
 useEffect(() => {
  mounted.current = true
  return () => { mounted.current = false }
 }, [])
 // Replacing the subtitles clears the consent in the DB: ask again even without leaving the player.
 const consent = subs.annot?.consent ?? null
 const seenConsent = useRef(consent)
 useEffect(() => {
  if (seenConsent.current !== null && consent === null) decided.current = false
  seenConsent.current = consent
 }, [consent])
 const annot = subs.annot
 const hasCues = subs.hasCues
 useEffect(() => {
  // The subtitle hold comes first: the analysis dialog only appears once the film can start.
  if (decided.current || !annot || !hasCues || hold !== null) return
  decided.current = true
  if (session.llmEnabled && annot.consent === null && annot.done < annot.total) {
   // A model the user already trusted for this film's analysis needs no question.
   void api.annotModel().then(async (m) => {
    if (!mounted.current) return
    if (!m.auto) {
     setResumeOnClose(true)
     setGate('ask')
     return
    }
    try {
     await api.annotSet(session.mediaId, true, false)
    } catch (e) {
     // Without the stored consent the scheduler cannot run: ask after all.
     notify('error', errorText(e))
     if (mounted.current) {
      setResumeOnClose(true)
      setGate('ask')
     }
     return
    }
    if (!mounted.current) return
    setResumeOnClose(true)
    setGate(headReady(session, useSubsStore.getState()) ? null : 'wait')
   }).catch((e) => {
    notify('error', errorText(e))
    if (!mounted.current) return
    setResumeOnClose(true)
    setGate('ask')
   })
  } else if (
   session.llmEnabled &&
   annot.consent === 'on' &&
   !annot.failure?.blocked &&
   (annot.running || annot.done + annot.failed < annot.total || subs.embedded?.phase === 'loading' || subs.embedded?.phase === 'confirm') &&
   !headReady(session, useSubsStore.getState())
  ) {
   // The user already agreed earlier: wait for the batches at the resume point, then play.
   setResumeOnClose(true)
   setGate('wait')
  }
 }, [annot, hasCues, session, hold])

 const cueByIdx = (i: number) => findCueByIdx(useSubsStore.getState().cues, i)
 // Stable callbacks: the dialog rows and subtitle lines are memoized on them.
 const { pinOpen, hoverOpen, hoverLeave } = explain
 const { askOnce } = agent
 const pickSpan = useCallback((pk: SpanPick) => { p.pause(); pinOpen(pk) }, [p, pinOpen])
 const hoverSpan = useCallback((pk: SpanPick | null) => (pk ? hoverOpen(pk) : hoverLeave()), [hoverOpen, hoverLeave])
 // The one entry point of every card click: quick mode never pauses or opens a dialog; review mode
 // pauses explicitly and opens the durable job's editor.
 const cardFor = useCallback((cueIdx: number, span: string | null) => {
  const key = cardDedupKey(session.mediaId, cueIdx, span)
  if (cardInFlight.current.has(key)) return
  cardInFlight.current.add(key)
  const quick = config.data?.anki.quickAdd === true
  if (!quick) p.pause()
  const offset = useSubsStore.getState().offset
  void api.cardsJobCreate(session.mediaId, cueIdx, span, p.audioIndex(), offset, quick ? 'quick' : 'review')
   .then(async (job) => {
    const store = useCardsStore.getState()
    store.upsert(job)
    if (quick) { store.trackTask(job); return }
    store.openEditor(await api.cardsJobEdit(job.id, true))
   })
   .catch((e) => notify('error', errorText(e)))
   .finally(() => { cardInFlight.current.delete(key) })
 }, [config.data?.anki.quickAdd, p, session.mediaId])
 const cardForCue = useCallback((cue: Cue) => cardFor(cue.idx, null), [cardFor])
 const explainCue = useCallback((cue: Cue) => { p.pause(); void askOnce(cueExplainPrompt(cue.text), cue.idx) }, [p, askOnce])
 const sidebarEn = useCallback(
  (cue: Cue, ann: CueAnnotation | undefined, active: boolean) => <CueLine cue={cue} ann={ann} live={active} onPick={pickSpan} onHover={hoverSpan} shareHover showShared />,
  [pickSpan, hoverSpan],
 )
 const overlayEn = useCallback(
  (cue: Cue, ann: CueAnnotation | undefined, karaoke: number | undefined) => <CueLine cue={cue} ann={ann} karaoke={karaoke} onPick={pickSpan} shareHover showShared />,
  [pickSpan],
 )
 const showPatterns = subs.patterns
 const overlayAbove = useCallback((_: Cue, ann: CueAnnotation | undefined) => (showPatterns ? <PatternBadges ann={ann} /> : null), [showPatterns])
 const askSpan = (cueIdx: number, span: string) => { p.pause(); void agent.ask(`Объясни «${span}» в этой реплике: перевод, смысл в сцене, грамматика.`, cueIdx) }
 const askPattern = (id: string) => {
  p.pause()
  void agent.ask(`Объясни конструкцию ${id} на примерах из этого фильма (используй pattern_ref).`)
 }
 const seekCue = (i: number) => { const c = cueByIdx(i); if (c) p.seek(c.start + useSubsStore.getState().offset) }

 /** Ends a slowed replay; `restore` gives back the speed that was on before it. */
 const endSlow = useCallback((restore: boolean) => {
  const s = slow.current
  if (!s) return
  clearInterval(s.timer)
  slow.current = null
  if (restore) p.setRate(s.win.prevRate)
 }, [p])

 const endReplay = useCallback(() => {
  const r = replayEnd.current
  if (!r) return
  clearInterval(r.timer)
  replayEnd.current = null
 }, [])

 /**
  * Holds the film on the replayed cue: pause when its end is reached instead of rolling into the next cue.
  * `seekAt` catches a manual seek (clicking another cue, scrubbing) — that action cancels the scheduled pause.
  */
 const stopAtCueEnd = useCallback((from: number, to: number, seekAt: number) => {
  endReplay()
  const win: ReplayWindow = { from, to, armed: false, startedAt: Date.now() }
  const timer = setInterval(() => {
   const st = usePlaybackStore.getState()
   if (st.lastSeekAt !== seekAt) { endReplay(); return }
   const v = p.videoRef.current
   if (!v) { endReplay(); return }
   const action = replayStep(win, v.currentTime, st.buffering || v.seeking, Date.now())
   if (action === 'pause') { endReplay(); p.pause() }
   else if (action === 'cancel') endReplay()
  }, 25)
  replayEnd.current = { win, timer }
 }, [p, endReplay])

 // A plain replay always runs at the normal speed of the film, even right after a slowed one.
 const replay = useCallback((cue: Cue) => {
  endSlow(true)
  endReplay()
  void api.frictionRecord(session.mediaId, cue.idx, 'replay', null)
  const off = useSubsStore.getState().offset
  const from = cue.start + off
  p.seek(from)
  p.play()
  stopAtCueEnd(from, cue.end + off, usePlaybackStore.getState().lastSeekAt)
 }, [p, session.mediaId, endSlow, endReplay, stopAtCueEnd])

 // Slow-down applies to this cue only: the speed is restored and the film pauses when the cue ends.
 const slowReplay = useCallback((cue: Cue) => {
  const prevRate = slow.current?.win.prevRate ?? usePlaybackStore.getState().rate
  endSlow(false)
  endReplay()
  void api.frictionRecord(session.mediaId, cue.idx, 'slow_replay', null)
  const off = useSubsStore.getState().offset
  const win: SlowWindow = { from: cue.start + off, to: cue.end + off, prevRate, armed: false, startedAt: Date.now() }
  p.setRate(SLOW_RATE)
  p.seek(win.from)
  p.play()
  const seekAt = usePlaybackStore.getState().lastSeekAt
  const timer = setInterval(() => {
   const st = usePlaybackStore.getState()
   if (st.lastSeekAt !== seekAt) { endSlow(true); return }
   const action = slowStep(win, p.now(), st.rate, st.buffering || !!p.videoRef.current?.seeking, Date.now())
   if (action === 'pause') { endSlow(true); p.pause() }
   else if (action !== 'keep') endSlow(action === 'restore')
  }, 25)
  slow.current = { win, timer }
 }, [p, session.mediaId, endSlow, endReplay])
 useEffect(() => () => {
  if (slow.current) clearInterval(slow.current.timer)
  if (replayEnd.current) clearInterval(replayEnd.current.timer)
 }, [])

 const shiftOffset = useCallback((d: number) => {
  const next = Math.round((useSubsStore.getState().offset + d) * 10) / 10
  useSubsStore.getState().setOffset(next)
  void api.mediaSetSubOffset(session.mediaId, next)
  toast(`Сдвиг субтитров: ${next > 0 ? '+' : ''}${next.toFixed(1)} с`)
 }, [session.mediaId])

 const reveal = useCallback(() => {
  const { reveal: r, seekTo } = startReveal(p.now())
  useSubsStore.getState().setReveal(r)
  p.seek(seekTo)
  p.play()
 }, [p])

 const cueStep = useCallback((dir: 1 | -1) => {
  const { cues, offset } = useSubsStore.getState()
  if (cues.length === 0) return p.seek(p.now() + dir * 5)
  const i = dir > 0 ? nextCueIndex(cues, p.now(), offset) : prevCueIndex(cues, p.now(), offset)
  p.seek(cues[i].start + offset)
 }, [p])

 const narrow = useMediaQuery('(max-width: 1159px)')
 const showSidebar = subs.sidebarOpen && !subs.hideMode
 const effectiveShowSidebar = showSidebar && (!narrow || !chatOpen)
 useEffect(() => {
  if (narrow && showSidebar && chatOpen) useSubsStore.getState().set({ sidebarOpen: false })
 }, [narrow, showSidebar, chatOpen])

 const toggleSidebar = useCallback(() => {
  const s = useSubsStore.getState()
  if (narrow) {
   const visibleNow = s.sidebarOpen && !s.hideMode && !useAgentStore.getState().open
   if (!visibleNow) {
    if (!s.sidebarOpen) s.set({ sidebarOpen: true })
    if (useAgentStore.getState().open) useAgentStore.getState().toggle()
    return
   }
  }
  s.set({ sidebarOpen: !s.sidebarOpen })
 }, [narrow])

 const toggleChat = useCallback(() => {
  const opening = !useAgentStore.getState().open
  useAgentStore.getState().toggle()
  if (narrow && opening) {
   const s = useSubsStore.getState()
   if (s.sidebarOpen) s.set({ sidebarOpen: false })
  }
 }, [narrow])

 useEffect(() => {
  const run: Record<HotkeyAction, () => void> = {
   playPause: () => p.togglePlay(),
   prevCue: () => cueStep(-1),
   nextCue: () => cueStep(1),
   back5: () => p.seek(p.now() - 5),
   forward5: () => p.seek(p.now() + 5),
   // The phrase in focus stays through the pause after it is spoken; `findCueIndex` sees only the
   // active window and would pick the next phrase when replay is pressed at the end of a line.
   replay: () => { const { cues, offset } = useSubsStore.getState(); const i = lastStartedBefore(cues, p.now(), offset); if (i >= 0) replay(cues[i]) },
   reveal,
   sidebar: toggleSidebar,
   showEn: () => { const s = useSubsStore.getState(); s.set({ showEn: !s.showEn }) },
   showRu: () => { const s = useSubsStore.getState(); s.set({ showRu: !s.showRu }) },
   patterns: () => { const s = useSubsStore.getState(); s.set({ patterns: !s.patterns }) },
   guide: openGuide,
   chat: toggleChat,
   offsetMinus: () => shiftOffset(-0.1),
   offsetPlus: () => shiftOffset(0.1),
   slower: () => p.setRate(usePlaybackStore.getState().rate - 0.05),
   faster: () => p.setRate(usePlaybackStore.getState().rate + 0.05),
   fullscreen: () => void toggleFullscreen(),
  }
  const onKey = (e: KeyboardEvent) => {
   if (shouldIgnorePlayerHotkey(e, { explainOpen: useExplainStore.getState().target !== null })) return
   // Escape is not rebindable: it always leaves fullscreen.
   if (e.code === 'Escape') { void getCurrentWindow().setFullscreen(false); return }
   const combo = comboOf(e)
   if (!combo) return
   // Bindings are read at press time, so a change applies without re-registering the listener.
   const action = actionFor(useHotkeysStore.getState().bindings, combo)
   if (!action) return
   e.preventDefault()
   run[action]()
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
 }, [p, cueStep, reveal, replay, shiftOffset, openGuide, toggleSidebar, toggleChat])

 const [, force] = useState(0)
 const openEpisode = (i: number) => api.sessionOpenPlaylistItem(i).catch((e) => notify('error', errorText(e)))
 useMediaSession(session, p, openEpisode)

 const idleOpacity = config.data?.subtitles.idleOpacity ?? 0.36
 const modalOpen = settingsMenuOpen || guide || hotkeysOpen || subsOpen || gate !== null || hold !== null || tourShown
 // The side panels slide out before their grid column goes away.
 const sidebarRef = useRef<HTMLElement>(null)
 const chatRef = useRef<HTMLElement>(null)
 const sidebar = usePresence(effectiveShowSidebar, sidebarRef)
 const chat = usePresence(chatOpen, chatRef)
 return (
  <div
   className="relative grid size-full overflow-hidden bg-black"
   style={{
    gridTemplateColumns: narrow
     ? 'minmax(0,1fr)'
     : [sidebar.mounted && 'clamp(260px, 26vw, 360px)', 'minmax(0,1fr)', chat.mounted && 'clamp(280px, 28vw, 400px)'].filter(Boolean).join(' '),
   }}
  >
   {sidebar.mounted && (
    <SidebarDock
     ref={sidebarRef}
     className={narrow ? 'absolute inset-y-0 left-0 z-30 w-[min(360px,calc(100vw-32px))] shadow-2xl' : undefined}
     mediaId={session.mediaId}
     onReplay={replay}
     onSlowReplay={slowReplay}
     onCard={cardForCue}
     onExplain={explainCue}
     renderEn={sidebarEn}
     chromeVisible={visible}
     idleOpacity={idleOpacity}
     modalOpen={modalOpen}
    />
   )}
   {/* Flush against the dialog list (no gutter, square corners on that side); rounded only on the side
       of the agent panel. Alone it fills the window edge to edge, so fullscreen has no corner cut-outs. */}
   <div className={`relative min-w-0 overflow-hidden bg-black ${!narrow && chat.mounted ? 'rounded-r-[var(--md-sys-shape-corner-extra-large)]' : ''}`} style={{ cursor: visible ? 'default' : 'none' }}>
    <PatternExposure mediaId={session.mediaId} />
    <VideoSurface />
    <SubsStatusBanner mediaId={session.mediaId} llmEnabled={session.llmEnabled} onChoose={() => setSubsOpen(true)} />
    <SubtitleOverlay
     lifted={visible}
     onReplay={replay}
     onCard={cardForCue}
     onExplain={explainCue}
     above={overlayAbove}
     renderEn={overlayEn}
    />
    <div
     ref={topBarRef}
     className={`absolute inset-x-0 top-0 transition-opacity duration-200 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
     style={{ containerType: 'inline-size', containerName: 'topbar' }}
    >
     <TopBar
      session={session}
      onBack={onBack}
      onOpenEpisode={openEpisode}
      rightSlot={(
       <>
        <CardsActivityButton />
        <NotificationButton className="relative size-12" />
        <IconButton icon="forum" label={withKey('Чат с агентом', hotkey.chat)} data-tour="chat" variant="tonal" size="lg" selected={chatOpen} onClick={toggleChat} />
       </>
      )}
     />
    </div>
    <div
     data-app-player-controls
     className={`absolute inset-x-4 bottom-4 transition-opacity duration-200 ${visible ? 'opacity-100' : 'm3e-wavy-idle pointer-events-none opacity-0'}`}
     style={{ containerType: 'inline-size', containerName: 'dock' }}
    >
     <ControlBar
      onPrevCue={() => cueStep(-1)}
      onNextCue={() => cueStep(1)}
      belowProgress={(
       <div className="mt-1 flex flex-col gap-1">
        <div data-tour="load-lines" className="flex flex-col gap-1">
         <AnalysisLine />
         <SubsLoadLine />
        </div>
       </div>
      )}
      leftSlot={
       <>
        <IconButton icon="menu" label={withKey('Диалоги', hotkey.sidebar)} data-tour="dialogs" selected={effectiveShowSidebar} onClick={toggleSidebar} />
        <ButtonGroup label="Языки субтитров" connected data-tour="subs-lang" className="mx-1">
         <ToggleButton selected={subs.showEn} className="px-3 font-semibold" onClick={() => subs.set({ showEn: !subs.showEn })}>EN</ToggleButton>
         <ToggleButton selected={subs.showRu} className="px-3 font-semibold" onClick={() => subs.set({ showRu: !subs.showRu })}>РУ</ToggleButton>
        </ButtonGroup>
       </>
      }
      rightSlot={
       <>
        <SettingsMenu
         session={session}
         onChanged={() => force((n) => n + 1)}
         onTour={openTour}
         onGuide={openGuide}
         onHotkeys={() => setHotkeysOpen(true)}
         onAnnotate={() => { setResumeOnClose(usePlaybackStore.getState().playing); setGate('ask') }}
         onChooseSubs={() => setSubsOpen(true)}
         onOpenChange={setSettingsMenuOpen}
        />
        <IconButton icon="fullscreen" label={withKey('Полный экран', hotkey.fullscreen)} data-tour="fullscreen" onClick={() => void toggleFullscreen()} />
       </>
      }
     />
    </div>
   </div>
   <AgentPanel
    ref={chatRef}
    mounted={chat.mounted}
    className={narrow ? 'absolute inset-y-0 right-0 z-30 w-[min(400px,calc(100vw-32px))] shadow-2xl' : undefined}
    mediaId={session.mediaId}
    locate={locate}
    here={<AgentHere />}
    cueTime={(i) => { const c = cueByIdx(i); return c ? formatTime(c.start + useSubsStore.getState().offset) : null }}
    cueText={(i) => cueByIdx(i)?.text ?? ''}
    onSeekCue={seekCue}
    onSeekTime={(t) => p.seek(t)}
   />
   <ExplainPopover mediaId={session.mediaId} onCard={cardFor} onAsk={askSpan} />
   <PatternCard
    mediaId={session.mediaId}
    cueStart={(i) => cueByIdx(i)?.start ?? 0}
    onSeekCue={seekCue}
    onExplain={askPattern}
   />
   <HighlightGuide open={guide} onClose={() => setGuide(false)} />
   <Presence>{hotkeysOpen && <HotkeysDialog onClose={() => setHotkeysOpen(false)} />}</Presence>
   <Presence>{subsOpen && <SubsChooserDialog mediaId={session.mediaId} onClose={() => setSubsOpen(false)} />}</Presence>
   <AnnotGate session={session} open={gate} resumeOnClose={resumeOnClose} onOpenChange={setGate} />
   <EmbeddedGate session={session} open={hold} onSkip={() => setSkipped(true)} />
   <Presence>{tourShown && <TourOverlay steps={tourSteps} onClose={() => { markTourSeen(); setTour(false) }} />}</Presence>
  </div>
 )
}

export function WatchScreen({ onClose }: { onClose: () => void }) {
 const session = useSessionStore((s) => s.session)
 const qc = useQueryClient()
 if (!session) return null
 const back = () => {
  const closingId = session.sessionId
  void api.sessionClose()
   .catch((e) => notify('error', errorText(e)))
   .finally(() => {
    const cur = useSessionStore.getState().session
    if (!shouldFinishSessionClose(cur?.sessionId, closingId)) return
    useSessionStore.getState().setSession(null)
    onClose()
    // The analysis went on in the background: the home screen's badges are stale by now.
    void qc.invalidateQueries({ queryKey: ['recent'] })
   })
 }
 return (
  <PlayerProvider key={session.sessionId} session={session}>
   <WatchLayout session={session} onBack={back} />
  </PlayerProvider>
 )
}
