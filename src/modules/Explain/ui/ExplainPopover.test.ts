import { describe, expect, test } from 'vitest'
import { clampPopoverPos } from './ExplainPopover'

describe('clampPopoverPos', () => {
  test('clamps top and left >= 8 even when tall content exceeds viewport height', () => {
    const pos = clampPopoverPos({ left: 360, top: 40, bottom: 80 }, 360, 925, 1080, 900)
    expect(pos.top).toBe(8)
    expect(pos.left).toBe(344)
  })

  test('clamps horizontally inside narrow viewports', () => {
    const pos = clampPopoverPos({ left: 680, top: 40, bottom: 80 }, 360, 200, 720, 540)
    expect(pos.left).toBe(352)
    expect(pos.top).toBe(88)
  })
})
