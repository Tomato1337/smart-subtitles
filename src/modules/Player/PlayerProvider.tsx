import type { ReactNode } from 'react'
import type { SessionState } from '@/common/types/ipc'
import { PlayerContext, useStreamingPlayer } from './usePlayerController'

export function PlayerProvider({ session, children }: { session: SessionState; children: ReactNode }) {
  const controller = useStreamingPlayer(session)
  return <PlayerContext.Provider value={controller}>{children}</PlayerContext.Provider>
}
