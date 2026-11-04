import { beforeEach, expect, it } from 'vitest'
import type { AppNotification } from '@/common/types/ipc'
import { useNotifications } from './notify'

const row = (id: number): AppNotification => ({ id, level: 'error', message: `m${id}`, createdAt: id })

beforeEach(() => {
  useNotifications.setState({ items: [], live: [], actions: new Map(), open: false })
})

it('pops once when the event and the command result both arrive', () => {
  const { upsert } = useNotifications.getState()
  upsert(row(1))
  upsert(row(1), 12000)
  const s = useNotifications.getState()
  expect(s.items).toHaveLength(1)
  expect(s.live).toHaveLength(1)
  // The caller's duration wins over the default.
  expect(s.live[0].until - Date.now()).toBeGreaterThan(11000)
})

it('keeps collapsed and hidden rows in the center', () => {
  const { upsert, hideLive, setOpen } = useNotifications.getState()
  upsert(row(1))
  hideLive(1)
  upsert(row(1))
  expect(useNotifications.getState().live).toHaveLength(0)
  upsert(row(2))
  setOpen(true)
  const s = useNotifications.getState()
  expect(s.live).toHaveLength(0)
  expect(s.items.map((i) => i.id)).toEqual([1, 2])
})

it('freezes the countdown while a popup is hovered and resumes it after', () => {
  useNotifications.setState({ live: [{ id: 1, until: Date.now() + 1000 }] })
  const { pauseLive, resumeLive } = useNotifications.getState()
  pauseLive(1)
  const paused = useNotifications.getState().live[0]
  expect(paused.paused).toBe(true)
  expect(paused.remaining).toBeLessThanOrEqual(1000)
  resumeLive(1)
  const resumed = useNotifications.getState().live[0]
  expect(resumed.paused).toBe(false)
  expect(resumed.until - Date.now()).toBeGreaterThan(900)
})
