/** Mbit/s with two decimals, matching TorrServer's and Lampa's player-info row. */
export function formatMbps(bytesPerSecond: number): string {
  const bits = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) * 8 : 0
  return (bits / 1e6).toFixed(2)
}
