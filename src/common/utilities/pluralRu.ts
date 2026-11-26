/**
 * Selects the Russian plural form for an integer count:
 * `one` (1, 21), `few` (2–4, 22–24), `many` (0, 5–20, 25–30…).
 * Non-finite inputs fall back to `many`.
 */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  if (!Number.isFinite(n)) return many
  const abs = Math.abs(Math.trunc(n)) % 100
  const mod10 = abs % 10
  if (abs >= 11 && abs <= 19) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/** Formats `<count> <pluralized noun>` cleanly, clamping non-finite counts to `0`. */
export function formatCountRu(n: number, one: string, few: string, many: string): string {
  const safe = Number.isFinite(n) ? Math.trunc(n) : 0
  return `${safe} ${pluralRu(safe, one, few, many)}`
}
