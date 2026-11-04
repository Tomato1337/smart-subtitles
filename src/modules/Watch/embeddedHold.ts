import type { EmbeddedState } from '@/common/types/ipc'

/**
 * What the film waits for while its subtitles are still inside the video file: the confirmation
 * card, then the first part of the track. `skipped` lets the user watch and let the rest load.
 *
 * Kept apart from the component so it can be tested without the stores.
 */
export function embeddedHold(e: EmbeddedState | null, skipped: boolean): 'confirm' | 'loading' | null {
 if (e?.phase === 'confirm') return 'confirm'
 if (e?.phase === 'loading' && e.loadedUntil < e.headUntil && !skipped) return 'loading'
 return null
}
