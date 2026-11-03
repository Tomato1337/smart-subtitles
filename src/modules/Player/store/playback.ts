import { create } from 'zustand'

type PlaybackState = {
  absTime: number
  duration: number
  bufferedEnd: number
  playing: boolean
  buffering: boolean
  rate: number
  volume: number
  muted: boolean
  /** Date.now() of the last seek; used to ignore "cue became active" caused by jumps. */
  lastSeekAt: number
  patch: (p: Partial<Omit<PlaybackState, 'patch'>>) => void
}

export const usePlaybackStore = create<PlaybackState>((set) => ({
  absTime: 0,
  duration: 0,
  bufferedEnd: 0,
  playing: false,
  buffering: true,
  rate: 1,
  volume: 1,
  muted: false,
  lastSeekAt: 0,
  patch: (p) => set(p),
}))
