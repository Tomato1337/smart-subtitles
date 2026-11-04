export type ShapeName = 'cookie9' | 'sunny' | 'clover4' | 'burst12'

/** [lobes, depth, rotation] per silhouette — the same parameters the mockup's SVG clipPaths were built from. */
const SPEC: Record<ShapeName, [lobes: number, depth: number, rot: number]> = {
  cookie9: [9, 0.07, 0],
  sunny: [8, 0.1, 0],
  clover4: [4, 0.2, Math.PI / 4],
  burst12: [12, 0.06, 0],
}

function polygon(lobes: number, depth: number, rot: number): string {
  const pts: [number, number][] = []
  let mx = 0
  for (let i = 0; i < 120; i++) {
    const t = (2 * Math.PI * i) / 120
    const r = 1 - depth + depth * Math.cos(lobes * (t + rot))
    const x = r * Math.cos(t)
    const y = r * Math.sin(t)
    pts.push([x, y])
    mx = Math.max(mx, Math.abs(x), Math.abs(y))
  }
  const out = pts.map(([x, y]) => `${(50 + (50 * x) / mx).toFixed(2)}% ${(50 + (50 * y) / mx).toFixed(2)}%`)
  return `polygon(${out.join(', ')})`
}

/** CSS clip-path per expressive silhouette, computed once at module load. */
export const shapeClip: Record<ShapeName, string> = {
  cookie9: polygon(...SPEC.cookie9),
  sunny: polygon(...SPEC.sunny),
  clover4: polygon(...SPEC.clover4),
  burst12: polygon(...SPEC.burst12),
}
