import { expect, it, vi } from 'vitest'
import { overlaysReachBoundary, overlayTopOffset, snackbarBand } from '../lib/placement'

vi.mock('@/modules/Session', () => ({
  useSessionStore: () => '',
}))

import {
  getRegisteredTriggers,
  headerAnchorStyle,
  isInsideNotificationControls,
  liveToastTopOffset,
  notificationRouteLayout,
  registerNotificationTrigger,
  type ContainsTarget,
} from './NotificationCenter'

const header = 48
const viewport = 1200

it('keeps the snackbar under the header when no warning shares its band', () => {
  expect(overlayTopOffset(viewport, header, null)).toBe(header + 8)
  // Far-left stack does not intersect the centered snackbar band.
  expect(overlayTopOffset(viewport, header, { left: 0, right: 100, top: 56, bottom: 240 })).toBe(header + 8)
})

it('pushes the snackbar below a warning stack that intersects its horizontal band', () => {
  const band = snackbarBand(viewport)
  const stack = { left: band.right - 200, right: band.right + 100, top: header + 8, bottom: 240 }
  expect(overlayTopOffset(viewport, header, stack)).toBe(248)
})

it('collapses warnings only when the stack plus the live toast would reach the boundary', () => {
  // 380 px wide at the right edge (12 px inset).
  const stack = { left: 808, right: 1188, top: 56, bottom: 300 }
  // Toast sits below the stack because they overlap horizontally: 300 + 8 + 80 = 388.
  expect(overlaysReachBoundary({ viewportWidth: viewport, headerBottom: header, stack, toastHeight: 80, boundaryTop: 380 })).toBe(true)
  expect(overlaysReachBoundary({ viewportWidth: viewport, headerBottom: header, stack, toastHeight: 80, boundaryTop: 420 })).toBe(false)
})

it('uses the taller of the stack and the toast when their bands do not overlap', () => {
  const stack = { left: 0, right: 100, top: 56, bottom: 200 }
  expect(overlaysReachBoundary({ viewportWidth: viewport, headerBottom: header, stack, toastHeight: 300, boundaryTop: 340 })).toBe(true)
  expect(overlaysReachBoundary({ viewportWidth: viewport, headerBottom: header, stack, toastHeight: 300, boundaryTop: 420 })).toBe(false)
})

it('never collapses an empty stack', () => {
  const stack = { left: 1080, right: 1180, top: 56, bottom: 56 }
  expect(overlaysReachBoundary({ viewportWidth: 360, headerBottom: header, stack, toastHeight: 0, boundaryTop: 60 })).toBe(false)
})

it('tracks trigger buttons across mounts and keeps header/floating clicks inside', () => {
  const headerChild = {} as Node
  const floatingChild = {} as Node
  const panelChild = {} as Node
  const outside = {} as Node

  const headerBtn: ContainsTarget = { contains: (n) => n === headerBtn || n === headerChild }
  const floatingBtn: ContainsTarget = { contains: (n) => n === floatingBtn || n === floatingChild }
  const panel: ContainsTarget = { contains: (n) => n === panel || n === panelChild }

  const unHeader = registerNotificationTrigger(headerBtn, 'header')
  const unFloating = registerNotificationTrigger(floatingBtn, 'floating')
  expect(getRegisteredTriggers()).toEqual([headerBtn, floatingBtn])

  expect(isInsideNotificationControls(headerChild, panel)).toBe(true)
  expect(isInsideNotificationControls(floatingChild, panel)).toBe(true)
  expect(isInsideNotificationControls(panelChild, panel)).toBe(true)
  expect(isInsideNotificationControls(outside, panel)).toBe(false)

  // Unmounting one button does not wipe out the other active trigger.
  unFloating()
  expect(getRegisteredTriggers()).toEqual([headerBtn])
  expect(isInsideNotificationControls(headerChild, panel)).toBe(true)
  expect(isInsideNotificationControls(floatingChild, panel)).toBe(false)

  unHeader()
  expect(getRegisteredTriggers()).toEqual([])
})

it('anchors the home panel below the top-right header trigger with safe viewport clamping', () => {
  expect(headerAnchorStyle({ bottom: 96, right: 1244 }, 1440, 900)).toEqual({
    top: 104,
    right: 196,
    maxHeight: 540,
  })
  // Falls back when the button rect is not measured yet.
  expect(headerAnchorStyle(null, 1200, 800)).toEqual({
    top: 96,
    right: 24,
    maxHeight: 480,
  })
  // Clamps right and height on tight viewports.
  expect(headerAnchorStyle({ bottom: 96, right: 1200 }, 1200, 420)).toEqual({
    top: 104,
    right: 12,
    maxHeight: 252,
  })
})

it('places notification center and fallback top-right on every route without bottom-left anchors', () => {
  for (const route of ['/', '/settings']) {
    for (const hasHeader of [false, true]) {
      const layout = notificationRouteLayout(route, hasHeader)
      expect(layout.player).toBe(false)
      expect(layout.anchorToHeader).toBe(true)
      expect(layout.showFloatingFallback).toBe(false)
      expect(layout.panelPositionClass).toBe('origin-top-right')
      expect(layout.toastRightClass).toBe('right-4')
    }
  }

  const playerLayout = notificationRouteLayout('/player', false)
  expect(playerLayout.player).toBe(true)
  expect(playerLayout.anchorToHeader).toBe(false)
  expect(playerLayout.showFloatingFallback).toBe(false)
  expect(playerLayout.panelPositionClass).toBe('top-18 right-3 origin-top-right max-h-[60vh]')
  expect(playerLayout.toastRightClass).toBe('right-3')

  const unknownFallback = notificationRouteLayout('/unknown', false)
  expect(unknownFallback.showFloatingFallback).toBe(true)
  expect(unknownFallback.fallbackButtonClass).toContain('top-4 right-4')
  expect(unknownFallback.fallbackButtonClass).not.toContain('bottom-')
  expect(unknownFallback.fallbackButtonClass).not.toContain('left-')
  expect(unknownFallback.panelPositionClass).toBe('top-18 right-4 origin-top-right max-h-[60vh]')
  expect(unknownFallback.panelPositionClass).not.toContain('bottom-')
  expect(unknownFallback.panelPositionClass).not.toContain('left-')

  expect(notificationRouteLayout('/unknown', true)).toMatchObject({
    anchorToHeader: true,
    showFloatingFallback: false,
    panelPositionClass: 'origin-top-right',
  })
})

it('computes non-player live toast top offset below header trigger, topbar, or 76px fallback', () => {
  expect(liveToastTopOffset({ bottom: 96, height: 56 }, { bottom: 112, height: 112 })).toBe(104)
  expect(liveToastTopOffset({ bottom: 54, height: 40 }, null)).toBe(62)
  // Clamps to 16px when the header bell scrolls above the viewport.
  expect(liveToastTopOffset({ bottom: -12, height: 56 }, null)).toBe(16)
  // Falls back to [data-app-topbar] when trigger is unmeasured or missing.
  expect(liveToastTopOffset({ bottom: 0, height: 0 }, { bottom: 68, height: 68 })).toBe(76)
  expect(liveToastTopOffset(null, { bottom: 60, height: 60 })).toBe(68)
  expect(liveToastTopOffset(null, null)).toBe(76)
})
