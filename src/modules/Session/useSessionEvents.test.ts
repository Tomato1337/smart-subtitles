import { describe, expect, it, vi } from 'vitest'
import type { SessionLoading, SessionState } from '@/common/types/ipc'
import { attachSessionEvents } from './useSessionEvents'

const loadingSample: SessionLoading = {
  title: 'New Film',
  originalTitle: null,
  season: null,
  episode: null,
  posterUrl: null,
  kind: 'file',
}

const sessionOne: SessionState = {
  sessionId: 's1',
  mediaId: 'm1',
  title: 'Old Film',
  originalTitle: null,
  year: 2024,
  season: null,
  episode: null,
  episodeTitle: null,
  posterUrl: null,
  duration: 1200,
  audioTracks: [],
  audioIndex: 0,
  resumeAt: 0,
  subOffset: 0,
  playlist: [],
  playlistIndex: null,
  llmEnabled: true,
  torrent: false,
}

const sessionTwo: SessionState = { ...sessionOne, sessionId: 's2', mediaId: 'm2', title: 'New Film' }

function createHarness(sessionCurrent: () => Promise<SessionState | null>) {
  const listeners = new Map<string, (payload: unknown) => void>()
  const setSession = vi.fn()
  const setLoading = vi.fn()
  const onError = vi.fn()
  const onToast = vi.fn()
  const onOpened = vi.fn()

  const cleanup = attachSessionEvents({
    onEvent: (name, cb) => {
      listeners.set(name, cb as (payload: unknown) => void)
      return Promise.resolve(() => {
        listeners.delete(name)
      })
    },
    sessionCurrent,
    setSession,
    setLoading,
    onError,
    onToast,
    onOpened,
  })

  return { listeners, setSession, setLoading, onError, onToast, onOpened, cleanup }
}

describe('attachSessionEvents', () => {
  it('hydrates startup sessionCurrent when no live session event arrived first', async () => {
    const h = createHarness(() => Promise.resolve(sessionOne))
    await Promise.resolve()
    await Promise.resolve()

    expect(h.setSession).toHaveBeenCalledWith(sessionOne)
    expect(h.onOpened).toHaveBeenCalledTimes(1)
  })

  it('ignores stale startup sessionCurrent after live session:loading fires', async () => {
    let resolveCurrent!: (s: SessionState | null) => void
    const h = createHarness(() => new Promise((r) => { resolveCurrent = r }))

    h.listeners.get('session:loading')?.(loadingSample)
    expect(h.setSession).toHaveBeenCalledWith(null)
    expect(h.setLoading).toHaveBeenCalledWith(loadingSample)

    resolveCurrent(sessionOne)
    await Promise.resolve()
    await Promise.resolve()

    expect(h.setSession).toHaveBeenCalledTimes(1)
    expect(h.onOpened).not.toHaveBeenCalled()
  })

  it('ignores stale startup sessionCurrent after live session:opened fires', async () => {
    let resolveCurrent!: (s: SessionState | null) => void
    const h = createHarness(() => new Promise((r) => { resolveCurrent = r }))

    h.listeners.get('session:opened')?.(sessionTwo)
    expect(h.setSession).toHaveBeenCalledWith(sessionTwo)
    expect(h.onOpened).toHaveBeenCalledTimes(1)

    resolveCurrent(sessionOne)
    await Promise.resolve()
    await Promise.resolve()

    expect(h.setSession).toHaveBeenCalledTimes(1)
    expect(h.onOpened).toHaveBeenCalledTimes(1)
  })

  it('ignores startup sessionCurrent after unmount cleanup', async () => {
    let resolveCurrent!: (s: SessionState | null) => void
    const h = createHarness(() => new Promise((r) => { resolveCurrent = r }))

    h.cleanup()
    resolveCurrent(sessionOne)
    await Promise.resolve()
    await Promise.resolve()

    expect(h.setSession).not.toHaveBeenCalled()
    expect(h.onOpened).not.toHaveBeenCalled()
  })
})
