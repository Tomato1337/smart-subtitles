const SNACKBAR_MAX_WIDTH = 560
const SNACKBAR_MARGIN = 32

export type OverlayRect = { left: number; right: number; top: number; bottom: number }

/** Horizontal band of the centered top snackbar at this viewport width. */
export function snackbarBand(viewportWidth: number): { left: number; right: number } {
  const width = Math.max(0, Math.min(SNACKBAR_MAX_WIDTH, viewportWidth - SNACKBAR_MARGIN))
  const left = (viewportWidth - width) / 2
  return { left, right: left + width }
}

/** Clear the header and only the warnings that share the snackbar's horizontal band. */
export function overlayTopOffset(viewportWidth: number, headerBottom: number, warning: OverlayRect | null): number {
  const band = snackbarBand(viewportWidth)
  let offset = Math.max(8, Math.ceil(headerBottom) + 8)
  if (warning && warning.bottom > warning.top && warning.right > band.left && warning.left < band.right) {
    offset = Math.max(offset, Math.ceil(warning.bottom) + 8)
  }
  return offset
}

/** Warnings collapse only when their stack plus the undo toast reaches the subtitles or controls. */
export function overlaysReachBoundary({ viewportWidth, headerBottom, stack, toastHeight, boundaryTop }: {
  viewportWidth: number
  headerBottom: number
  stack: OverlayRect
  toastHeight: number
  boundaryTop: number
}): boolean {
  if (stack.bottom <= stack.top) return false
  const band = snackbarBand(viewportWidth)
  const overlaps = stack.right > band.left && stack.left < band.right
  const toastTop = overlaps
    ? Math.max(8, Math.ceil(headerBottom) + 8, Math.ceil(stack.bottom) + 8)
    : Math.max(8, Math.ceil(headerBottom) + 8)
  return Math.max(stack.bottom, toastTop + toastHeight) > boundaryTop - 8
}
