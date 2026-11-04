import type { ModelPrice } from '@/common/types/ipc'

/** Compact token count: `60`, `23K`, `1M`, `1.4M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}K`
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}

/** Dollars with cents from a cent up, one significant digit below that, `$0` for nothing. */
export function formatUsd(x: number): string {
  if (x >= 0.01) return `$${x.toFixed(2)}`
  if (x > 0) return `$${x.toPrecision(1)}`
  return '$0'
}

/** The same arithmetic as `catalog::cost_usd`: cached input may be cheaper than fresh input. */
export function estimateUsd(p: ModelPrice, input: number, cached: number, output: number): number {
  return ((input - cached) * p.input + cached * (p.cacheRead ?? p.input) + output * p.output) / 1e6
}
