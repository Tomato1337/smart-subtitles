import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type RefObject } from 'react'
import { notify } from '@/common/api/notify'
import { api } from '@/common/api/tauri'
import type { SessionState } from '@/common/types/ipc'
import { MseStream } from './lib/MseStream'
import { rangeAt, toRanges } from './lib/mseBuffer'
import { usePlaybackStore } from './store/playback'

export type PlayerController = {
  videoRef: RefObject<HTMLVideoElement | null>
  /** Absolute media time, which is video.currentTime: stream timestamps are absolute. */
  now: () => number
  seek: (t: number) => void
  seekDebounced: (t: number) => void
  togglePlay: () => void
  play: () => void
  pause: () => void
  setRate: (r: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  changeAudio: (index: number) => void
}

export const PlayerContext = createContext<PlayerController | null>(null)

export function usePlayer(): PlayerController {
  const c = useContext(PlayerContext)
  if (!c) throw new Error('usePlayer outside PlayerProvider')
  return c
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** Owns the <video> element: MSE buffer over the backend stream, absolute-time seek, position persistence. */
export function useStreamingPlayer(session: SessionState): PlayerController {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const mseRef = useRef<MseStream | null>(null)
  const audioRef = useRef(session.audioIndex)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const patch = usePlaybackStore.getState().patch
  const { sessionId, mediaId, duration } = session

  const now = useCallback(() => videoRef.current?.currentTime ?? 0, [])

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current
      if (!v || !mseRef.current) return
      const target = clamp(t, 0, Math.max(0, duration - 0.1))
      patch({ absTime: target, lastSeekAt: Date.now() })
      if (mseRef.current.seek(target, !v.paused || usePlaybackStore.getState().playing) === 'stream') {
        patch({ buffering: true })
      }
    },
    [duration, patch],
  )

  const seekDebounced = useCallback(
    (t: number) => {
      patch({ absTime: t })
      clearTimeout(debounce.current)
      debounce.current = setTimeout(() => seek(t), 250)
    },
    [seek, patch],
  )

  // Initial open + element events + ticker.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const mse = new MseStream(
      v,
      duration,
      (t) => api.mediaOpenStream(sessionId, t, audioRef.current).then((s) => s.url),
      (m) => {
        patch({ buffering: false })
        notify('error', m)
      },
    )
    mseRef.current = mse
    const off = <K extends keyof HTMLElementEventMap>(n: K, f: () => void) => {
      v.addEventListener(n, f)
      return () => v.removeEventListener(n, f)
    }
    const offs = [
      off('playing', () => patch({ playing: true, buffering: false })),
      off('pause', () => patch({ playing: false })),
      off('waiting', () => patch({ buffering: true })),
      off('canplay', () => patch({ buffering: false })),
      off('error', () => {
        // Decode errors (corrupt torrent bytes) are recovered by MseStream itself.
        if (v.error?.code === MediaError.MEDIA_ERR_DECODE) return patch({ buffering: true })
        if (v.getAttribute('src')) notify('error', `Ошибка видео (код ${v.error?.code ?? '?'}): ${v.error?.message ?? ''}`)
      }),
    ]
    patch({ duration, absTime: session.resumeAt, playing: false, buffering: true, rate: 1 })
    v.defaultPlaybackRate = 1
    v.playbackRate = 1
    mse.seek(session.resumeAt, true)

    const tick = setInterval(() => {
      if (!mseRef.current) return
      const abs = v.currentTime
      const end = rangeAt(toRanges(v.buffered), abs)?.[1] ?? abs
      const s = usePlaybackStore.getState()
      if (!v.paused && !v.seeking) patch({ absTime: abs, bufferedEnd: end })
      else if (s.bufferedEnd !== end) patch({ bufferedEnd: end })
      mse.maintain()
    }, 100)
    const save = setInterval(() => {
      const t = v.currentTime
      if (t > 0) void api.mediaSavePosition(mediaId, t)
    }, 5000)

    return () => {
      clearInterval(tick)
      clearInterval(save)
      clearTimeout(debounce.current)
      for (const o of offs) o()
      const t = v.currentTime
      if (t > 0) void api.mediaSavePosition(mediaId, t)
      mse.destroy()
      mseRef.current = null
    }
  }, [sessionId])

  return useMemo<PlayerController>(
    () => ({
      videoRef,
      now,
      seek,
      seekDebounced,
      togglePlay: () => {
        const v = videoRef.current
        if (!v) return
        if (v.paused) void v.play().catch(() => { })
        else v.pause()
      },
      play: () => void videoRef.current?.play().catch(() => { }),
      pause: () => videoRef.current?.pause(),
      setRate: (r) => {
        const rate = clamp(Math.round(r * 100) / 100, 0.5, 2)
        // defaultPlaybackRate survives the load() of a stream restart; playbackRate alone resets to it.
        if (videoRef.current) { videoRef.current.playbackRate = rate; videoRef.current.defaultPlaybackRate = rate }
        patch({ rate })
      },
      setVolume: (vol) => {
        const x = clamp(vol, 0, 1)
        if (videoRef.current) { videoRef.current.volume = x; videoRef.current.muted = false }
        patch({ volume: x, muted: false })
      },
      toggleMute: () => {
        const v = videoRef.current
        if (!v) return
        v.muted = !v.muted
        patch({ muted: v.muted })
      },
      changeAudio: (index) => {
        audioRef.current = index
        void api.mediaSetAudio(mediaId, index)
        // now() is 0 until the first stream is attached: fall back to the position the UI shows.
        const t = videoRef.current?.currentTime || usePlaybackStore.getState().absTime
        const play = !(videoRef.current?.paused ?? true)
        void mseRef.current?.clear().then(() => mseRef.current?.restart(t, play))
        patch({ buffering: true })
      },
    }),
    [now, seek, seekDebounced, mediaId, patch],
  )
}
