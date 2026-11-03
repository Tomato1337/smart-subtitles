import { useEffect, useRef } from 'react'
import type { SessionState } from '@/common/types/ipc'
import { usePlaybackStore, type PlayerController } from '@/modules/Player'
import { mediaMetaOf } from './mediaMeta'

const ACTIONS: MediaSessionAction[] = [
 'play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack',
]

/**
 * Publishes the session to the system media widget: WebKitGTK turns navigator.mediaSession into MPRIS,
 * which is what inir's media widget and playerctl read. `document.title` is the fallback WebKit uses
 * when the MediaSession API is off.
 */
export function useMediaSession(session: SessionState, p: PlayerController, openEpisode: (i: number) => void): void {
 // openEpisode is re-created on every render, so handlers read it through a ref instead of re-registering.
 const live = useRef({ p, openEpisode })
 live.current = { p, openEpisode }
 const idx = session.playlistIndex
 const count = session.playlist.length

 useEffect(() => {
  const m = mediaMetaOf(session)
  document.title = m.artist ? `${m.title} — ${m.artist}` : m.title
  if (!('mediaSession' in navigator)) {
   return () => { document.title = 'Smart Subtitles' }
  }
  navigator.mediaSession.metadata = new MediaMetadata({
   title: m.title,
   artist: m.artist,
   album: m.album,
   artwork: session.posterUrl ? [{ src: session.posterUrl, sizes: '500x750' }] : [],
  })
  return () => {
   document.title = 'Smart Subtitles'
   navigator.mediaSession.metadata = null
   navigator.mediaSession.playbackState = 'none'
  }
 }, [session])

 useEffect(() => {
  if (!('mediaSession' in navigator)) return
  const ms = navigator.mediaSession
  // Unsupported actions throw; a missing button is fine.
  const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
   try {
    ms.setActionHandler(a, h)
   } catch {
    // not supported by this WebKit
   }
  }
  set('play', () => live.current.p.play())
  set('pause', () => live.current.p.pause())
  set('stop', () => live.current.p.pause())
  set('seekbackward', (d) => live.current.p.seek(live.current.p.now() - (d.seekOffset ?? 10)))
  set('seekforward', (d) => live.current.p.seek(live.current.p.now() + (d.seekOffset ?? 10)))
  // video.currentTime is absolute media time, the same scale MPRIS SetPosition uses.
  set('seekto', (d) => {
   if (d.seekTime !== undefined) live.current.p.seek(d.seekTime)
  })
  if (idx !== null && idx > 0) set('previoustrack', () => live.current.openEpisode(idx - 1))
  if (idx !== null && idx + 1 < count) set('nexttrack', () => live.current.openEpisode(idx + 1))
  return () => {
   for (const a of ACTIONS) set(a, null)
  }
 }, [idx, count])

 const playing = usePlaybackStore((s) => s.playing)
 useEffect(() => {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
 }, [playing])
}
