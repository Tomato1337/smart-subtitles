import type { ReactNode } from 'react'
import type { CueAnnotation } from '@/common/types/ipc'
import { patternById } from '../lib/catalog'
import { usePatternStore } from '../store/patternStore'
import { usePatternStats } from '../usePatterns'

/** Grammar badge chip, shared by the overlay and the highlight guide. */
export function PatternChip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="state-layer type-label-medium relative rounded-full bg-[var(--app-grammar-container)] px-3 py-1 text-[var(--app-grammar-on-container)]"
    >
      {children}
    </button>
  )
}

/** Row of grammar badges of a cue: `label · formula · ×N`; patterns marked as known are hidden. */
export function PatternBadges({ ann }: { ann: CueAnnotation | undefined }) {
  const stats = usePatternStats()
  const open = usePatternStore((s) => s.open)
  if (!ann || ann.patterns.length === 0) return null
  const byId = new Map(stats.data?.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const shown = ann.patterns.filter((p) => {
    if (seen.has(p.patternId)) return false
    if (byId.get(p.patternId)?.status === 'known' || !patternById(p.patternId)) return false
    seen.add(p.patternId)
    return true
  })
  if (shown.length === 0) return null
  return (
    <div data-tour="patterns" className="mb-2 flex flex-wrap justify-center gap-2">
      {shown.map((p) => {
        const pat = patternById(p.patternId)!
        return (
          <PatternChip key={p.patternId} onClick={() => open(p.patternId)}>
            {pat.label} · {pat.formula} · ×{byId.get(p.patternId)?.count ?? 0}
          </PatternChip>
        )
      })}
    </div>
  )
}
