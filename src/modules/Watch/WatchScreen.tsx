import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { Cue, SessionState } from '@/common/types/ipc'
import { formatTime } from '@/common/utilities/time'
import { comboOf } from '@/common/utilities/keys'
import { IconButton } from '@/common/ui/IconButton'
import { toast } from '@/common/ui/toast'
import { AgentPanel, cueExplainPrompt, useAgentActions, useAgentEvents, useAgentStore } from '@/modules/Agent'
import { useAnkiEvents } from '@/modules/Anki'
import { CardDraftModal, useCardsStore } from '@/modules/Cards'
import { NotificationButton } from '@/modules/Notifications'
import { ExplainPopover, useExplainStore } from '@/modules/Explain'
import { actionFor, HotkeysDialog, useHotkeysStore, withKey, type HotkeyAction } from '@/modules/Hotkeys'
import { PatternBadges, PatternCard, usePatternExposure } from '@/modules/Patterns'
import { ControlBar, PlayerProvider, TopBar, usePlayer, usePlaybackStore, VideoSurface } from '@/modules/Player'
import { useSessionStore } from '@/modules/Session'
import {
 AnalysisLine, lastStartedBefore, nextCueIndex, prevCueIndex, Sidebar, startReveal, SubsChooserDialog, SubsLoadLine, SubsStatusBanner, SubtitleOverlay, useActiveCueIndex, useAnnotPriority, useSubsStore,
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

/** "Where am I" line of the agent chat: film time and the last started cue. */
function AgentHere() {
 const cues = useSubsStore((s) => s.cues)
 const offset = useSubsStore((s) => s.offset)
 const sec = usePlaybackStore((s) => Math.floor(s.absTime))
 const i = usePlaybackStore((s) => lastStartedBefore(cues, s.absTime, offset))
 const line = i >= 0 ? ` · «${cues[i].text.replace(/\s*\n\s*/g, ' ')}»` : ''
 return <>Сейчас {formatTime(sec)}{line}</>
}

function WatchLayout({ session, onBack }: { session: SessionState; onBack: () => void }) {
 const p = usePlayer()
 const playing = usePlaybackStore((s) => s.playing)
 const visible = useIdleVisible(!playing)
 const subs = useSubsStore()
 const slow = useRef<{ win: SlowWindow; timer: ReturnType<typeof setInterval> } | null>(null)
 const replayEnd = useRef<{ win: ReplayWindow; timer: ReturnType<typeof setInterval> } | null>(null)
 useSubtitlesData(session.mediaId, session.subOffset)
 useAnnotPriority(session.mediaId)
 useAnkiEvents()
 useAgentEvents(session.mediaId)
 /** Position sent with every agent message: the given cue, or the last cue started at the playhead. */
 const locate = useCallback((cueIdx?: number) => {
  const { cues, offset } = useSubsStore.getState()
  if (cueIdx !== undefined && cues[cueIdx]) return { cueIdx, at: cues[cueIdx].start + offset }
  const i = lastStartedBefore(cues, p.now(), offset)
  return { cueIdx: i >= 0 ? i : null, at: p.now() }
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
 const explain = useExplainStore()
 const openDraft = useCardsStore((s) => s.openDraft)
 usePatternExposure(session.mediaId, useActiveCueIndex())
 const [guide, setGuide] = useState(false)
 const [hotkeysOpen, setHotkeysOpen] = useState(false)
 const [subsOpen, setSubsOpen] = useState(false)
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
 // The gate effect re-runs on every store change, so its answer must outlive the effect itself;
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
 useEffect(() => {
  // The subtitle hold comes first: the analysis dialog only appears once the film can start.
  if (decided.current || !subs.annot || subs.cues.length === 0 || hold !== null) return
  decided.current = true
  if (session.llmEnabled && subs.annot.consent === null && subs.annot.done < subs.annot.total) {
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
  } else if (subs.annot.consent === 'on' && !headReady(session, subs)) {
   // The user already agreed earlier: wait for the batches at the resume point, then play.
   setResumeOnClose(true)
   setGate('wait')
  }
 }, [subs, session, hold])

 const cueByIdx = (i: number) => useSubsStore.getState().cues[i]
 const pickSpan = (pk: SpanPick) => { p.pause(); explain.pinOpen(pk) }
 const cardFor = (cueIdx: number, span: string | null) => { p.pause(); openDraft(cueIdx, span) }
 const explainCue = (cue: Cue) => { p.pause(); void agent.askOnce(cueExplainPrompt(cue.text), cue.idx) }
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
  const off = useSubsStore.getState().offset
  const from = cue.start + off
  p.seek(from)
  p.play()
  stopAtCueEnd(from, cue.end + off, usePlaybackStore.getState().lastSeekAt)
 }, [p, endSlow, endReplay, stopAtCueEnd])

 // Slow-down applies to this cue only: the speed is restored and the film pauses when the cue ends.
 const slowReplay = useCallback((cue: Cue) => {
  const prevRate = slow.current?.win.prevRate ?? usePlaybackStore.getState().rate
  endSlow(false)
  endReplay()
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
 }, [p, endSlow, endReplay])
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
   sidebar: () => { const s = useSubsStore.getState(); s.set({ sidebarOpen: !s.sidebarOpen }) },
   showEn: () => { const s = useSubsStore.getState(); s.set({ showEn: !s.showEn }) },
   showRu: () => { const s = useSubsStore.getState(); s.set({ showRu: !s.showRu }) },
   patterns: () => { const s = useSubsStore.getState(); s.set({ patterns: !s.patterns }) },
   guide: openGuide,
   chat: () => useAgentStore.getState().toggle(),
   offsetMinus: () => shiftOffset(-0.1),
   offsetPlus: () => shiftOffset(0.1),
   slower: () => p.setRate(usePlaybackStore.getState().rate - 0.05),
   faster: () => p.setRate(usePlaybackStore.getState().rate + 0.05),
   fullscreen: () => void toggleFullscreen(),
  }
  const onKey = (e: KeyboardEvent) => {
   if (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]')) return
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
 }, [p, cueStep, reveal, replay, shiftOffset, openGuide])

 const [, force] = useState(0)
 const openEpisode = (i: number) => api.sessionOpenPlaylistItem(i).catch((e) => notify('error', errorText(e)))
 useMediaSession(session, p, openEpisode)

 const showSidebar = subs.sidebarOpen && !subs.hideMode
 return (
  <div
   className="grid size-full bg-black"
   style={{ gridTemplateColumns: [showSidebar && '360px', 'minmax(0,1fr)', chatOpen && '400px'].filter(Boolean).join(' ') }}
  >
   {showSidebar && (
    <Sidebar
     mediaId={session.mediaId}
     onReplay={replay}
     onSlowReplay={slowReplay}
     onCard={(cue) => cardFor(cue.idx, null)}
     onExplain={explainCue}
     renderEn={(cue, ann, active) => <CueLine cue={cue} ann={ann} live={active} onPick={pickSpan} onHover={(pk) => (pk ? explain.hoverOpen(pk) : explain.hoverLeave())} shareHover showShared />}
    />
   )}
   {/* Flush against the dialog list (no gutter, square corners on that side); rounded only on the side
       of the agent panel. Alone it fills the window edge to edge, so fullscreen has no corner cut-outs. */}
   <div className={`relative min-w-0 overflow-hidden bg-black ${chatOpen ? 'rounded-r-[var(--md-sys-shape-corner-extra-large)]' : ''}`} style={{ cursor: visible ? 'default' : 'none' }}>
    <VideoSurface />
    <SubsStatusBanner mediaId={session.mediaId} llmEnabled={session.llmEnabled} onChoose={() => setSubsOpen(true)} />
    <SubtitleOverlay
     lifted={visible}
     onReplay={replay}
     onCard={(cue) => cardFor(cue.idx, null)}
     onExplain={explainCue}
     above={(cue) => (subs.patterns ? <PatternBadges ann={subs.annotations.get(cue.idx)} /> : null)}
     renderEn={(cue, ann, karaoke) => <CueLine cue={cue} ann={ann} karaoke={karaoke} onPick={pickSpan} shareHover showShared />}
    />
    <div className={`absolute inset-x-0 top-0 transition-opacity duration-200 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
     <TopBar
      session={session}
      onBack={onBack}
      onOpenEpisode={openEpisode}
      rightSlot={(
       <>
        <NotificationButton className="relative size-12" />
        <IconButton icon="forum" label={withKey('Чат с агентом', hotkey.chat)} data-tour="chat" variant="tonal" size="lg" selected={chatOpen} onClick={() => useAgentStore.getState().toggle()} />
       </>
      )}
     />
    </div>
    <div
     className={`absolute inset-x-4 bottom-4 transition-opacity duration-200 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
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
        <IconButton icon="menu" label={withKey('Диалоги', hotkey.sidebar)} data-tour="dialogs" selected={subs.sidebarOpen} onClick={() => subs.set({ sidebarOpen: !subs.sidebarOpen })} />
        <div data-tour="subs-lang" className="mx-1 flex gap-0.5">
         <button type="button" aria-pressed={subs.showEn} onClick={() => subs.set({ showEn: !subs.showEn })} className={`morph state-layer state-on-surface type-label-large relative h-10 min-w-12 px-3 font-semibold ${subs.showEn ? 'rounded-[20px] bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]' : 'rounded-l-[20px] rounded-r-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-surface-container-highest)] text-[var(--md-sys-color-on-surface-variant)]'}`}>EN</button>
         <button type="button" aria-pressed={subs.showRu} onClick={() => subs.set({ showRu: !subs.showRu })} className={`morph state-layer state-on-surface type-label-large relative h-10 min-w-12 px-3 font-semibold ${subs.showRu ? 'rounded-[20px] bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]' : 'rounded-r-[20px] rounded-l-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-surface-container-highest)] text-[var(--md-sys-color-on-surface-variant)]'}`}>РУ</button>
        </div>
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
        />
        <IconButton icon="fullscreen" label={withKey('Полный экран', hotkey.fullscreen)} data-tour="fullscreen" onClick={() => void toggleFullscreen()} />
       </>
      }
     />
    </div>
   </div>
   <AgentPanel
    mediaId={session.mediaId}
    locate={locate}
    here={<AgentHere />}
    cueTime={(i) => { const c = cueByIdx(i); return c ? formatTime(c.start + useSubsStore.getState().offset) : null }}
    cueText={(i) => cueByIdx(i)?.text ?? ''}
    onSeekCue={seekCue}
    onSeekTime={(t) => p.seek(t)}
   />
   <ExplainPopover mediaId={session.mediaId} onCard={cardFor} onAsk={askSpan} />
   <CardDraftModal mediaId={session.mediaId} />
   <PatternCard
    mediaId={session.mediaId}
    cueStart={(i) => cueByIdx(i)?.start ?? 0}
    onSeekCue={seekCue}
    onExplain={askPattern}
   />
   <HighlightGuide open={guide} onClose={() => setGuide(false)} />
   {hotkeysOpen && <HotkeysDialog onClose={() => setHotkeysOpen(false)} />}
   {subsOpen && <SubsChooserDialog mediaId={session.mediaId} onClose={() => setSubsOpen(false)} />}
   <AnnotGate session={session} open={gate} resumeOnClose={resumeOnClose} onOpenChange={setGate} />
   <EmbeddedGate session={session} open={hold} onSkip={() => setSkipped(true)} />
   {tourShown && <TourOverlay steps={tourSteps} onClose={() => { markTourSeen(); setTour(false) }} />}
  </div>
 )
}

export function WatchScreen({ onClose }: { onClose: () => void }) {
 const session = useSessionStore((s) => s.session)
 const qc = useQueryClient()
 if (!session) return null
 const back = () => {
  void api.sessionClose().finally(() => {
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
