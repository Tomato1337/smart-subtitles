import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoldClient } from './hold'

type Gate = () => void

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function holdSender(calls: boolean[], gates: Gate[]) {
  return (_job: string, _client: string, held: boolean) => {
    calls.push(held)
    const g = Promise.withResolvers<void>()
    gates.push(() => g.resolve())
    return g.promise
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hold lease', () => {
  it('keeps one request in flight and sends the latest state after its acknowledgment', async () => {
    const calls: boolean[] = []
    const gates: Gate[] = []
    const send = holdSender(calls, gates)
    const hold = new HoldClient('j', send, 'c')
    hold.onInteraction(true)
    expect(calls).toEqual([true])
    // Released while the hold is still in flight: no second request races it.
    hold.onInteraction(false)
    expect(calls).toEqual([true])
    gates[0]()
    await flush()
    expect(calls).toEqual([true, false])
    gates[1]()
    await flush()
    expect(calls).toEqual([true, false])
  })

  it('renews a held lease every 3 s, skipping an enqueue while one is in flight', async () => {
    const calls: boolean[] = []
    const gates: Gate[] = []
    const send = holdSender(calls, gates)
    const hold = new HoldClient('j', send, 'c')
    hold.onInteraction(true)
    gates[0]()
    await flush()
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls).toEqual([true, true])
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls).toEqual([true, true])
    gates[1]()
    await flush()
    expect(calls).toEqual([true, true])
  })

  it('releases a held lease after the in-flight acknowledgment, never before', async () => {
    const calls: boolean[] = []
    const gates: Gate[] = []
    const send = holdSender(calls, gates)
    const hold = new HoldClient('j', send, 'c')
    hold.onInteraction(true)
    hold.release()
    expect(calls).toEqual([true])
    gates[0]()
    await flush()
    expect(calls).toEqual([true, false])
    hold.release()
    await flush()
    expect(calls).toEqual([true, false])
  })

  it('does not spin on a failed hold and lets the 3 s heartbeat retry instead', async () => {
    const send = vi.fn(() => Promise.reject(new Error('offline')))
    const hold = new HoldClient('j', send, 'c')
    hold.onInteraction(true)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    hold.release()
    await flush()
    // The failed hold was never acknowledged, so a release is not fabricated.
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends nothing for a release that was never held', async () => {
    const send = vi.fn(() => Promise.resolve())
    const hold = new HoldClient('j', send, 'c')
    hold.onInteraction(false)
    hold.release()
    await flush()
    expect(send).not.toHaveBeenCalled()
  })
})
