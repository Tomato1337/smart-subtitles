import { expect, it } from 'vitest'
import { overlaysReachBoundary, overlayTopOffset, snackbarBand } from '../lib/placement'

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
