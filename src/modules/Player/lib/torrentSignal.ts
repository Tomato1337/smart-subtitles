/** Lampa's five-dot torrent signal: the first dot is the health of the contiguous buffer, the rest
 * fill from left to right as the reader's window finishes downloading. */
export type SignalDot = 'bad' | 'weak' | 'good' | 'on' | 'off'

const DOTS = 5

export function signalDots(percent: number | null): SignalDot[] {
 if (percent === null || !Number.isFinite(percent)) return Array<SignalDot>(DOTS).fill('off')
 const p = Math.min(100, Math.max(0, percent))
 const filled = Math.round((p / 100) * DOTS)
 return Array.from({ length: DOTS }, (_, i) => {
  if (i === 0) return p > 80 ? 'good' : p >= 40 ? 'weak' : 'bad'
  return i < filled ? 'on' : 'off'
 })
}
