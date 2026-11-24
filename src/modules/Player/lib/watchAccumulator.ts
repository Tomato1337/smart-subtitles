/**
 * Accumulates real active playback time (excluding paused/buffering/seeking intervals),
 * clamping single-sample gaps to 1.5s and emitting whole seconds every `thresholdSec`.
 */
export class WatchAccumulator {
  private lastMs: number | null = null
  private pendingSec = 0
  private readonly thresholdSec: number

  constructor(thresholdSec = 15) {
    this.thresholdSec = thresholdSec
  }

  sample(nowMs: number, active: boolean): number | null {
    if (!active) {
      this.lastMs = null
      return null
    }
    if (this.lastMs !== null) {
      const dt = Math.min(Math.max(0, (nowMs - this.lastMs) / 1000), 1.5)
      this.pendingSec += dt
    }
    this.lastMs = nowMs
    if (this.pendingSec >= this.thresholdSec) {
      const whole = Math.floor(this.pendingSec)
      this.pendingSec -= whole
      return whole > 0 ? whole : null
    }
    return null
  }

  flush(nowMs?: number, active = false): number | null {
    if (active && nowMs !== undefined && this.lastMs !== null) {
      const dt = Math.min(Math.max(0, (nowMs - this.lastMs) / 1000), 1.5)
      this.pendingSec += dt
    }
    this.lastMs = null
    const whole = Math.floor(this.pendingSec)
    if (whole < 1) return null
    this.pendingSec -= whole
    return whole
  }
}
