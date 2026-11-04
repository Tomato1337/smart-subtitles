/** One page of the tour. */
export type TourStep = {
 id: string
 /** `data-tour` ids, tried in order; the first one present on screen is highlighted. Empty = no target. */
 targets: readonly string[]
 /** Behaviour when no target is on screen: hide the step, or show the card centered without a spotlight. */
 ifMissing: 'skip' | 'center'
 title: string
 /** One paragraph per entry. */
 body: readonly string[]
 action?: { label: string; run: () => void }
}

export type Rect = { left: number; top: number; width: number; height: number }
export type Size = { width: number; height: number }

/**
 * From `from` (inclusive) walk in `dir` to the first showable step: a step whose first present target
 * is highlighted, or a step with no target that shows the card centered instead. `null` past the ends.
 */
export function resolveStep(
 steps: readonly TourStep[],
 from: number,
 dir: 1 | -1,
 present: (id: string) => boolean,
): { index: number; target: string | null } | null {
 for (let index = from; index >= 0 && index < steps.length; index += dir) {
  const step = steps[index]
  const target = step.targets.find((id) => present(id))
  if (target !== undefined) return { index, target }
  // A step pointing at nothing is either hidden or shown without a spotlight.
  if (step.targets.length === 0 || step.ifMissing === 'center') return { index, target: null }
 }
 return null
}

/** Indices of all showable steps, in order: the counter's denominator, and the end of the tour. */
export function visibleSteps(steps: readonly TourStep[], present: (id: string) => boolean): number[] {
 const out: number[] = []
 for (let index = 0; index < steps.length; index += 1) {
  if (resolveStep(steps, index, 1, present)?.index === index) out.push(index)
 }
 return out
}

/**
 * Where the card goes next to the highlighted target: above or below it, on the side of the screen the
 * target is not on; a tall target (the sidebar) pushes the card to its right or left. Without a target,
 * or with no room left, the card sits in the middle. Every coordinate stays inside the viewport margins.
 */
export function placeCard(
 target: Rect | null,
 card: Size,
 viewport: Size,
 gap = 12,
 margin = 8,
): { left: number; top: number } {
 const leftMax = viewport.width - card.width - margin
 const topMax = viewport.height - card.height - margin
 // A card wider or taller than the viewport still starts at the margin instead of a negative inset.
 const clamp = (v: number, max: number) => Math.min(Math.max(margin, v), Math.max(margin, max))
 const middle = { left: clamp((viewport.width - card.width) / 2, leftMax), top: clamp((viewport.height - card.height) / 2, topMax) }
 if (target === null) return middle

 const centerY = target.top + target.height / 2
 const left = clamp(target.left + target.width / 2 - card.width / 2, leftMax)
 const above = target.top - card.height - gap
 const below = target.top + target.height + gap
 // The lower half of the screen opens upwards, the upper half downwards, so the card covers less.
 const [first, second] = centerY > viewport.height / 2 ? [above, below] : [below, above]
 if (first >= margin && first <= topMax) return { left, top: first }
 if (second >= margin && second <= topMax) return { left, top: second }

 // A target taller than the room above and below it (the sidebar): put the card beside it.
 const top = clamp(centerY - card.height / 2, topMax)
 const right = target.left + target.width + gap
 if (right <= leftMax) return { left: clamp(right, leftMax), top }
 const beside = target.left - card.width - gap
 if (beside >= margin) return { left: clamp(beside, leftMax), top }

 return middle
}
