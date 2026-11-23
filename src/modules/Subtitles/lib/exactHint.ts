import type { SubsStatus } from '@/common/types/ipc'

export const EXACT_HINT_MS = 8000

export type ExactHintState = {
  status: SubsStatus
  baseOffset: number
  dismissed: boolean
}

export type ExactHintTimer = {
  resume: () => void
  pause: () => void
  dispose: () => void
}

export function isNonExactReady(status: SubsStatus | null): boolean {
  return status?.state === 'ready' && status.exact === false
}

export function formatSyncHint(minusLabel: string | null, plusLabel: string | null): string {
  const keys = [minusLabel, plusLabel].filter((k): k is string => k !== null && k.length > 0)
  const suffix = keys.length > 0 ? `: ${keys.join(' / ')}` : ' субтитры'
  return `Подобраны по названию — если рассинхрон, сдвиньте${suffix}`
}

/**
 * Reconciles the non-exact subtitle banner state with the latest `subs:status` and `offset`.
 * Re-arms on a new non-exact `SubsStatus` object and dismisses once `offset` moves away
 * from the baseline offset recorded when that status arrived.
 */
export function syncExactHint(
  current: ExactHintState | null,
  status: SubsStatus | null,
  offset: number,
): ExactHintState | null {
  if (!isNonExactReady(status) || status === null) return null
  if (current === null || current.status !== status) {
    return { status, baseOffset: offset, dismissed: false }
  }
  if (!current.dismissed && Math.abs(offset - current.baseOffset) > 1e-6) {
    return { ...current, dismissed: true }
  }
  return current
}

export function dismissExactHint(current: ExactHintState | null): ExactHintState | null {
  if (!current || current.dismissed) return current
  return { ...current, dismissed: true }
}

/** Pausable auto-dismiss countdown so hover or keyboard focus freezes remaining visibility time. */
export function createExactHintTimer(
  durationMs: number,
  onDone: () => void,
  now: () => number = () => performance.now(),
): ExactHintTimer {
  let remaining = Math.max(0, durationMs)
  let since = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let disposed = false

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    resume() {
      if (disposed || finished || timer !== undefined) return
      since = now()
      timer = setTimeout(() => {
        timer = undefined
        if (disposed || finished) return
        finished = true
        onDone()
      }, remaining)
    },
    pause() {
      if (disposed || finished || timer === undefined) return
      clear()
      remaining = Math.max(0, remaining - Math.max(0, now() - since))
    },
    dispose() {
      disposed = true
      clear()
    },
  }
}
