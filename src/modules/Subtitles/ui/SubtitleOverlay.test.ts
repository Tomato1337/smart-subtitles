import { describe, expect, test } from 'vitest'
import { clampOverlayBottomPx } from './SubtitleOverlay'

describe('clampOverlayBottomPx', () => {
  test('clamps upward drag below TopBar clearance', () => {
    // stageHeight=720, topClear=88, lineHeight=96 => ceiling = 536
    expect(clampOverlayBottomPx(700, 172, 720, 88, 96)).toBe(536)
  })

  test('keeps requested height within baseBottom..ceiling range', () => {
    expect(clampOverlayBottomPx(260, 172, 720, 88, 96)).toBe(260)
  })

  test('never drops below effective base above control bar', () => {
    expect(clampOverlayBottomPx(40, 172, 720, 88, 96)).toBe(172)
  })

  test('keeps safe fallback on tight viewports where ceiling < baseBottom', () => {
    // stageHeight=280, topClear=88, lineHeight=96 => ceiling = 96; baseBottom=172 clamps down to 96
    expect(clampOverlayBottomPx(172, 172, 280, 88, 96)).toBe(96)
  })
})
