import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api, errorText } from '@/common/api/tauri'
import type { Cue, SessionState } from '@/common/types/ipc'
import { formatTime } from '@/common/utilities/time'
import { IconButton } from '@/common/ui/IconButton'
import { toast } from '@/common/ui/toast'
import { AgentPanel, cueExplainPrompt, useAgentActions, useAgentEvents, useAgentStore } from '@/modules/Agent'
import { useAnkiEvents } from '@/modules/Anki'
import { CardDraftModal, useCardsStore } from '@/modules/Cards'
import { ExplainPopover, useExplainStore } from '@/modules/Explain'
import { PatternBadges, PatternCard, usePatternExposure } from '@/modules/Patterns'
import { ControlBar, PlayerProvider, TopBar, usePlayer, usePlaybackStore, VideoSurface } from '@/modules/Player'
import { useSessionStore } from '@/modules/Session'
import {
  lastStartedBefore, nextCueIndex, prevCueIndex, Sidebar, startReveal, SubsStatusBanner, SubtitleOverlay, useActiveCueIndex, useSubsStore, useSubtitlesData,
  type SpanPick,
} from '@/modules/Subtitles'
import { CueLine } from './CueLine'
import { guideUnseen, HighlightGuide } from './HighlightGuide'
import { SettingsMenu } from './SettingsMenu'
import { SLOW_RATE, slowStep, type SlowWindow } from './slowReplay'
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
  useSubtitlesData(session.mediaId, session.subOffset)
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
  const explain = useExplainStore()
  const openDraft = useCardsStore((s) => s.openDraft)
  usePatternExposure(session.mediaId, useActiveCueIndex())
  const [guide, setGuide] = useState(guideUnseen)
  const openGuide = useCallback(() => { p.pause(); setGuide(true) }, [p])

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

  // A plain replay always runs at the normal speed of the film, even right after a slowed one.
  const replay = useCallback((cue: Cue) => {
    endSlow(true)
    p.seek(cue.start + useSubsStore.getState().offset)
    p.play()
  }, [p, endSlow])

  // Slow-down applies to this cue only: it ends when the cue ends or the playhead leaves it.
  const slowReplay = useCallback((cue: Cue) => {
    const prevRate = slow.current?.win.prevRate ?? usePlaybackStore.getState().rate
    endSlow(false)
    const off = useSubsStore.getState().offset
    const win: SlowWindow = { from: cue.start + off, to: cue.end + off, prevRate, armed: false, startedAt: Date.now() }
    p.setRate(SLOW_RATE)
    p.seek(win.from)
    p.play()
    const timer = setInterval(() => {
      const st = usePlaybackStore.getState()
      const action = slowStep(win, p.now(), st.rate, st.buffering || !!p.videoRef.current?.seeking, Date.now())
      if (action !== 'keep') endSlow(action === 'restore')
    }, 100)
    slow.current = { win, timer }
  }, [p, endSlow])
  useEffect(() => () => { if (slow.current) clearInterval(slow.current.timer) }, [])

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
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]')) return
      const s = useSubsStore.getState()
      switch (e.code) {
        case 'Space': e.preventDefault(); p.togglePlay(); break
        case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) p.seek(p.now() - 5); else cueStep(-1); break
        case 'ArrowRight': e.preventDefault(); if (e.shiftKey) p.seek(p.now() + 5); else cueStep(1); break
        case 'KeyA': reveal(); break
        case 'KeyR': { const { cues, offset } = s; const i = cues.findIndex((c) => p.now() < c.end + offset); if (i >= 0) replay(cues[i]); break }
        case 'KeyS': s.set({ sidebarOpen: !s.sidebarOpen }); break
        case 'KeyF': void toggleFullscreen(); break
        case 'KeyE': s.set({ showEn: !s.showEn }); break
        case 'KeyT': s.set({ showRu: !s.showRu }); break
        case 'KeyP': s.set({ patterns: !s.patterns }); break
        case 'KeyH': openGuide(); break
        case 'KeyC': useAgentStore.getState().toggle(); break
        case 'KeyZ': shiftOffset(-0.1); break
        case 'KeyX': shiftOffset(0.1); break
        case 'BracketLeft': p.setRate(usePlaybackStore.getState().rate - 0.05); break
        case 'BracketRight': p.setRate(usePlaybackStore.getState().rate + 0.05); break
        case 'Escape': void getCurrentWindow().setFullscreen(false); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p, cueStep, reveal, replay, shiftOffset, openGuide])

  const [, force] = useState(0)
  const openEpisode = (i: number) => api.sessionOpenPlaylistItem(i).catch((e) => toast(errorText(e)))
  useMediaSession(session, p, openEpisode)

  return (
    <div className="flex size-full bg-[var(--md-sys-color-surface)]">
      {subs.sidebarOpen && !subs.hideMode && (
        <Sidebar
          mediaId={session.mediaId}
          onReplay={replay}
          onSlowReplay={slowReplay}
          onCard={(cue) => cardFor(cue.idx, null)}
          onExplain={explainCue}
          renderEn={(cue, ann, active) => <CueLine cue={cue} ann={ann} live={active} onPick={pickSpan} onHover={(pk) => (pk ? explain.hoverOpen(pk) : explain.hoverLeave())} />}
        />
      )}
      <div className="relative min-w-0 flex-1 overflow-hidden bg-black" style={{ cursor: visible ? 'default' : 'none' }}>
        <VideoSurface />
        <SubsStatusBanner mediaId={session.mediaId} llmEnabled={session.llmEnabled} />
        <SubtitleOverlay
          lifted={visible}
          onReplay={replay}
          onCard={(cue) => cardFor(cue.idx, null)}
          onExplain={explainCue}
          above={(cue) => (subs.patterns ? <PatternBadges ann={subs.annotations.get(cue.idx)} /> : null)}
          renderEn={(cue, ann, karaoke) => <CueLine cue={cue} ann={ann} karaoke={karaoke} onPick={pickSpan} />}
        />
        <AgentPanel
          mediaId={session.mediaId}
          locate={locate}
          here={<AgentHere />}
          cueTime={(i) => { const c = cueByIdx(i); return c ? formatTime(c.start + useSubsStore.getState().offset) : null }}
          cueText={(i) => cueByIdx(i)?.text ?? ''}
          onSeekCue={seekCue}
          onSeekTime={(t) => p.seek(t)}
        />
        <div className={`absolute inset-x-0 top-0 transition-opacity duration-200 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
          <TopBar
            session={session}
            onBack={onBack}
            onOpenEpisode={openEpisode}
            rightSlot={<IconButton icon="forum" label="Чат с агентом (C)" selected={chatOpen} onClick={() => useAgentStore.getState().toggle()} />}
          />
        </div>
        <div className={`absolute inset-x-0 bottom-0 transition-opacity duration-200 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
          <ControlBar
            onPrevCue={() => cueStep(-1)}
            onNextCue={() => cueStep(1)}
            leftSlot={
              <>
                <IconButton icon="menu" label="Диалоги (S)" selected={subs.sidebarOpen} onClick={() => subs.set({ sidebarOpen: !subs.sidebarOpen })} />
                <button type="button" aria-pressed={subs.showEn} onClick={() => subs.set({ showEn: !subs.showEn })} className={`state-layer state-on-surface type-label-large relative rounded-full px-3 py-1.5 ${subs.showEn ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]' : 'border border-[var(--md-sys-color-outline)]'}`}>EN</button>
                <button type="button" aria-pressed={subs.showRu} onClick={() => subs.set({ showRu: !subs.showRu })} className={`state-layer state-on-surface type-label-large relative rounded-full px-3 py-1.5 ${subs.showRu ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]' : 'border border-[var(--md-sys-color-outline)]'}`}>РУ</button>
              </>
            }
            rightSlot={
              <>
                <SettingsMenu session={session} onChanged={() => force((n) => n + 1)} onGuide={openGuide} />
                <IconButton icon="fullscreen" label="Полный экран (F)" onClick={() => void toggleFullscreen()} />
              </>
            }
          />
        </div>
      </div>
      <ExplainPopover mediaId={session.mediaId} onCard={cardFor} onAsk={askSpan} />
      <CardDraftModal mediaId={session.mediaId} />
      <PatternCard
        mediaId={session.mediaId}
        cueStart={(i) => cueByIdx(i)?.start ?? 0}
        onSeekCue={seekCue}
        onExplain={askPattern}
      />
      <HighlightGuide open={guide} onClose={() => setGuide(false)} />
    </div>
  )
}

export function WatchScreen({ onClose }: { onClose: () => void }) {
  const session = useSessionStore((s) => s.session)
  if (!session) return null
  const back = () => {
    void api.sessionClose().finally(() => { useSessionStore.getState().setSession(null); onClose() })
  }
  return (
    <PlayerProvider key={session.sessionId} session={session}>
      <WatchLayout session={session} onBack={back} />
    </PlayerProvider>
  )
}
