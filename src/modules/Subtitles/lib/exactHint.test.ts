import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsStatus } from '@/common/types/ipc'
import {
  createExactHintTimer,
  dismissExactHint,
  EXACT_HINT_MS,
  formatSyncHint,
  isNonExactReady,
  syncExactHint,
} from './exactHint'

describe('isNonExactReady', () => {
  it('returns true only for ready statuses with exact=false', () => {
    expect(isNonExactReady(null)).toBe(false)
    expect(isNonExactReady({ mediaId: 'm1', state: 'searching', exact: false })).toBe(false)
    expect(isNonExactReady({ mediaId: 'm1', state: 'downloading', exact: false })).toBe(false)
    expect(isNonExactReady({ mediaId: 'm1', state: 'ready' })).toBe(false)
    expect(isNonExactReady({ mediaId: 'm1', state: 'ready', exact: true })).toBe(false)
    expect(isNonExactReady({ mediaId: 'm1', state: 'ready', source: 'opensubtitles', exact: false })).toBe(true)
  })
})

describe('formatSyncHint', () => {
  it('formats current offset hotkeys or falls back cleanly when unbound', () => {
    expect(formatSyncHint('Z', 'X')).toBe(
      'Подобраны по названию — если рассинхрон, сдвиньте: Z / X',
    )
    expect(formatSyncHint('[', null)).toBe(
      'Подобраны по названию — если рассинхрон, сдвиньте: [',
    )
    expect(formatSyncHint(null, 'Alt+=')).toBe(
      'Подобраны по названию — если рассинхрон, сдвиньте: Alt+=',
    )
    expect(formatSyncHint(null, null)).toBe('Подобраны по названию — если рассинхрон, сдвиньте субтитры')
  })
})

describe('syncExactHint & dismissExactHint', () => {
  const nonExactA: SubsStatus = { mediaId: 'm1', state: 'ready', source: 'opensubtitles', exact: false }
  const nonExactB: SubsStatus = { mediaId: 'm1', state: 'ready', source: 'opensubtitles', exact: false }
  const exactStatus: SubsStatus = { mediaId: 'm1', state: 'ready', source: 'opensubtitles', exact: true }

  it('arms on non-exact status and dismisses when offset changes (auto-sync or manual)', () => {
    const s1 = syncExactHint(null, nonExactA, 0)
    expect(s1).toEqual({ status: nonExactA, baseOffset: 0, dismissed: false })

    // Tiny float noise within 1e-6 keeps the banner visible.
    expect(syncExactHint(s1, nonExactA, 0)).toBe(s1)

    // Any real shift from baseOffset (auto-sync `subs:offset` or manual Z/X) dismisses immediately.
    const s2 = syncExactHint(s1, nonExactA, 0.4)
    expect(s2?.dismissed).toBe(true)
  })

  it('supports manual dismissal and re-arms on a new non-exact status object', () => {
    const s1 = syncExactHint(null, nonExactA, -0.5)
    const closed = dismissExactHint(s1)
    expect(closed?.dismissed).toBe(true)
    expect(dismissExactHint(closed)).toBe(closed)

    // New SubsStatus emission for another track re-arms with current offset as baseline.
    const rearmed = syncExactHint(closed, nonExactB, -0.5)
    expect(rearmed).toEqual({ status: nonExactB, baseOffset: -0.5, dismissed: false })

    // Switching to exact or cleared state removes hint state.
    expect(syncExactHint(rearmed, exactStatus, -0.5)).toBeNull()
    expect(syncExactHint(rearmed, null, -0.5)).toBeNull()
  })
})

describe('createExactHintTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires after duration, freezes remaining time while paused, and respects dispose', () => {
    let clockMs = 1000
    const done = vi.fn()
    const timer = createExactHintTimer(EXACT_HINT_MS, done, () => clockMs)

    timer.resume()
    clockMs += 3000
    vi.advanceTimersByTime(3000)
    expect(done).not.toHaveBeenCalled()

    // Pause for 20s; countdown must stay frozen at 5000 ms remaining.
    timer.pause()
    clockMs += 20_000
    vi.advanceTimersByTime(20_000)
    expect(done).not.toHaveBeenCalled()

    // Resume and advance 4999 ms — still alive, then 1 ms triggers completion.
    timer.resume()
    clockMs += 4999
    vi.advanceTimersByTime(4999)
    expect(done).not.toHaveBeenCalled()
    clockMs += 1
    vi.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledTimes(1)

    // Disposing a second timer prevents completion.
    const cancelled = vi.fn()
    const t2 = createExactHintTimer(EXACT_HINT_MS, cancelled, () => clockMs)
    t2.resume()
    t2.dispose()
    vi.advanceTimersByTime(EXACT_HINT_MS + 100)
    expect(cancelled).not.toHaveBeenCalled()
  })
})
