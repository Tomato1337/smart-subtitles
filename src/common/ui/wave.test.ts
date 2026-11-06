import { describe, expect, it } from 'vitest'
import { waveGeom } from './wave'

const BASE = { amp: 4, len: 30, stroke: 6, phase: 0, thumb: true }

describe('waveGeom', () => {
  it('draws no wave at zero and starts the track after the thumb gap', () => {
    const g = waveGeom(200, 32, { ...BASE, value: 0 })
    expect(g.wave).toBe('')
    expect(g.track?.[0]).toBe(8)
  })

  it('drops the track at the end and keeps the wave inside the right cap', () => {
    const g = waveGeom(200, 32, { ...BASE, value: 1 })
    expect(g.track).toBeNull()
    expect(g.wave).not.toBe('')
    const lastX = Number(g.wave.match(/([\d.]+) [\d.-]+$/)?.[1])
    expect(lastX).toBeLessThanOrEqual(192)
  })

  it('hides a buffer that sits behind the playhead', () => {
    const g = waveGeom(200, 32, { ...BASE, value: 0.5, buffer: 0.1 })
    expect(g.buffer).toBeNull()
  })

  it('skips the path on request and keeps the rest of the geometry', () => {
    const full = waveGeom(200, 32, { ...BASE, value: 0.5, buffer: 0.8 })
    const bare = waveGeom(200, 32, { ...BASE, value: 0.5, buffer: 0.8, path: false })
    expect(bare.wave).toBe('')
    expect({ ...bare, wave: full.wave }).toEqual(full)
  })

  it('ends the buffer at its share of the width', () => {
    const g = waveGeom(200, 32, { ...BASE, value: 0.5, buffer: 0.8 })
    expect(g.buffer).toEqual([108, 160])
  })
})
