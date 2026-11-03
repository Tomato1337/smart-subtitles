import raw from '../patterns.json'

export type Pattern = { id: string; label: string; formula: string; level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1'; about: string }

export const PATTERNS = raw as Pattern[]
export const patternById = (id: string): Pattern | undefined => PATTERNS.find((p) => p.id === id)
