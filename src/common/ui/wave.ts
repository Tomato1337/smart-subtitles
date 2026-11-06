export type WaveGeom = {
  wave: string
  track: [number, number] | null
  buffer: [number, number] | null
  stopX: number
  thumbX: number | null
}

/**
 * Pure geometry of the wavy progress line, ported from the mockup's `Wave.draw`.
 * `path: false` leaves `wave` empty: WavyProgress builds its own path and calls this on every update.
 */
export function waveGeom(
  w: number,
  h: number,
  o: { value: number; buffer?: number; amp: number; len: number; stroke: number; phase: number; thumb: boolean; path?: boolean },
): WaveGeom {
  const s = o.stroke
  const mid = h / 2
  const gap = o.thumb ? 8 : 5
  const x = Math.max(0, Math.min(1, o.value)) * w

  const end = Math.max(s / 2, x - gap)
  let wave = ''
  if (x > s && o.path !== false) {
    for (let px = s / 2; px <= end; px += 1.5) {
      const y = mid + o.amp * Math.sin((px / o.len) * 2 * Math.PI - o.phase)
      wave += `${wave ? 'L' : 'M'}${px.toFixed(1)} ${y.toFixed(2)}`
    }
  }

  const t0 = Math.min(w - s / 2, x + gap)
  const trackEnd = w - s / 2
  const bufferEnd = Math.max(t0, (o.buffer ?? 0) * w)

  return {
    wave,
    track: trackEnd > t0 ? [t0, trackEnd] : null,
    buffer: bufferEnd > t0 ? [t0, bufferEnd] : null,
    stopX: trackEnd,
    thumbX: o.thumb ? x : null,
  }
}
