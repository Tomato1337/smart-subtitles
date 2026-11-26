import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type RefObject } from 'react'
import { notify } from '@/common/api/notify'
import { api } from '@/common/api/tauri'
import type { SessionState } from '@/common/types/ipc'
import { MseStream } from './lib/MseStream'
import { rangeAt, toRanges } from './lib/mseBuffer'
import { WatchAccumulator } from './lib/watchAccumulator'
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
  /** The audio track chosen in the player right now: what a new card captures. */
  audioIndex: () => number
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
  const opNonce = useRef(0)
  const audioChain = useRef(Promise.resolve())
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const patch = usePlaybackStore.getState().patch
  const { sessionId, mediaId, duration } = session

  const now = useCallback(() => mseRef.current?.currentTime() ?? 0, [])

  const sanitizeSeek = useCallback(
    (t: number) => {
      if (!Number.isFinite(t)) return 0
      if (Number.isFinite(duration) && duration > 0) return clamp(t, 0, Math.max(0, duration - 0.1))
      return Math.max(0, t)
    },
    [duration],
  )

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current
      if (!v || !mseRef.current) return
      opNonce.current++
      const target = sanitizeSeek(t)
      patch({ absTime: target, lastSeekAt: Date.now() })
      if (mseRef.current.seek(target, !v.paused || usePlaybackStore.getState().playing) === 'stream') {
        patch({ buffering: true })
      }
    },
    [sanitizeSeek, patch],
  )

  const seekDebounced = useCallback(
    (t: number) => {
      patch({ absTime: sanitizeSeek(t) })
      clearTimeout(debounce.current)
      debounce.current = setTimeout(() => seek(t), 250)
    },
    [sanitizeSeek, seek, patch],
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
    const watch = new WatchAccumulator(15)
    const flushWatch = () => {
      const sec = watch.flush()
      if (sec) void api.watchTick(mediaId, sec)
    }

    const offs = [
      off('playing', () => patch({ playing: true, buffering: false })),
      off('pause', () => {
        patch({ playing: false })
        flushWatch()
      }),
      off('waiting', () => { if (!mse.isFatal()) patch({ buffering: true }) }),
      off('canplay', () => patch({ buffering: false })),
      off('error', () => {
        if (mse.isFatal()) return patch({ buffering: false })
        // MseStream handles decode errors first and may already have cleared video.error by rebuilding.
        if (!v.error || v.error.code === MediaError.MEDIA_ERR_DECODE) return patch({ buffering: true })
        if (v.getAttribute('src')) notify('error', `Ошибка видео (код ${v.error.code}): ${v.error.message}`)
      }),
    ]
    patch({ duration, absTime: session.resumeAt, playing: false, buffering: true, rate: 1 })
    v.defaultPlaybackRate = 1
    v.playbackRate = 1
    mse.seek(session.resumeAt, true)

    const tick = setInterval(() => {
      if (!mseRef.current) return
      const abs = mse.currentTime()
      const end = rangeAt(toRanges(v.buffered), abs)?.[1] ?? abs
      const s = usePlaybackStore.getState()
      if (!v.paused && !v.seeking) patch({ absTime: abs, bufferedEnd: end })
      else if (s.bufferedEnd !== end) patch({ bufferedEnd: end })
      const sec = watch.sample(Date.now(), !v.paused && !v.seeking && !s.buffering)
      if (sec) void api.watchTick(mediaId, sec)
      mse.maintain()
    }, 100)
    const save = setInterval(() => {
      const t = mse.currentTime()
      if (t > 0) void api.mediaSavePosition(mediaId, t)
    }, 5000)

    return () => {
      clearInterval(tick)
      clearInterval(save)
      clearTimeout(debounce.current)
      for (const o of offs) o()
      flushWatch()
      const t = mse.currentTime()
      if (t > 0) void api.mediaSavePosition(mediaId, t)
      mse.destroy()
      mseRef.current = null
    }
  }, [sessionId])

  return useMemo<PlayerController>(
    () => ({
      videoRef,
      now,
      audioIndex: () => audioRef.current,
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
        const nonce = ++opNonce.current
        audioRef.current = index
        void api.mediaSetAudio(mediaId, index)
        const mse = mseRef.current
        if (!mse) return
        // now() is 0 until the first stream is attached: fall back to the position the UI shows.
        const fallbackT = now() || usePlaybackStore.getState().absTime
        const fallbackPlay = !(videoRef.current?.paused ?? true)
        patch({ buffering: true })
        audioChain.current = audioChain.current.then(async () => {
          if (mseRef.current !== mse || opNonce.current !== nonce) return
          await mse.clear()
          if (mseRef.current !== mse || opNonce.current !== nonce) return
          const latestT = usePlaybackStore.getState().absTime
          const t = Number.isFinite(latestT) && latestT > 0 ? latestT : fallbackT
          const play = videoRef.current ? !videoRef.current.paused : fallbackPlay
          mse.restart(Number.isFinite(t) ? t : 0, play)
        })
      },
    }),
    [now, seek, seekDebounced, mediaId, patch],
  )
}
