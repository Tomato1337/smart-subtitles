import { useId, type CSSProperties } from 'react'

/**
 * A unique anchor name for one CSS tooltip. CSS Anchor Positioning resolves duplicate names to the
 * last element in the document, so every button gets its own name via the `--tip-anchor` variable.
 */
export function useTipAnchor(): CSSProperties {
 const id = useId().replace(/[^A-Za-z0-9_-]/g, '_')
 return { '--tip-anchor': `--tip-${id}` } as CSSProperties
}
