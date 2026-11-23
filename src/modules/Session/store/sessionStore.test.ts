import { beforeEach, expect, it } from 'vitest'
import type { SessionLoading, SessionState } from '@/common/types/ipc'
import { useSessionStore } from './sessionStore'

const sampleLoading: SessionLoading = {
  title: 'Гангстерленд',
  originalTitle: 'MobLand',
  season: 1,
  episode: 3,
  posterUrl: 'http://127.0.0.1:47800/poster/m1',
  kind: 'lampa',
}

const sampleSession: SessionState = {
  sessionId: 's1',
  mediaId: 'm1',
  title: 'Гангстерленд',
  originalTitle: 'MobLand',
  year: 2025,
  season: 1,
  episode: 3,
  episodeTitle: null,
  posterUrl: 'http://127.0.0.1:47800/poster/m1',
  duration: 3120,
  audioTracks: [],
  audioIndex: 0,
  resumeAt: 0,
  subOffset: 0,
  playlist: [],
  playlistIndex: null,
  llmEnabled: true,
  torrent: true,
}

beforeEach(() => {
  useSessionStore.setState({ session: null, loading: null })
})

it('stores enriched session:loading metadata with startedAt timestamp', () => {
  useSessionStore.getState().setLoading(sampleLoading, 1_700_000_000_000)
  expect(useSessionStore.getState().loading).toEqual({
    ...sampleLoading,
    startedAt: 1_700_000_000_000,
  })
})

it('clears loading and startedAt cleanly on ready and cancel/error', () => {
  useSessionStore.getState().setLoading(sampleLoading, 1_700_000_000_000)
  useSessionStore.getState().setSession(sampleSession)
  expect(useSessionStore.getState().loading).toBeNull()
  expect(useSessionStore.getState().session?.sessionId).toBe('s1')

  useSessionStore.getState().setLoading(sampleLoading, 1_700_000_005_000)
  useSessionStore.getState().setLoading(null)
  expect(useSessionStore.getState().loading).toBeNull()
})
