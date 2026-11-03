/** A buffered interval as `[start, end]` in media time. */
export type Range = [number, number]

const AVC = [0x61, 0x76, 0x63, 0x43] // 'avcC'
const AAC = 'mp4a.40.2'

export function toRanges(tr: TimeRanges): Range[] {
  const rs: Range[] = []
  for (let i = 0; i < tr.length; i++) rs.push([tr.start(i), tr.end(i)])
  return rs
}

/** Range containing t (start - slack <= t <= end), or null. */
export function rangeAt(rs: Range[], t: number, slack = 0): Range | null {
  for (const r of rs) if (r[0] - slack <= t && t <= r[1]) return r
  return null
}

/**
  * `video/mp4; codecs="avc1.PPCCLL,mp4a.40.2"` from the bytes after the first 'avcC': PP=b[i+5], CC=b[i+6],
  * LL=b[i+7], 2-digit lowercase hex. Null when 'avcC' or its 3 bytes are not in `b` yet.
  */
export function codecFromInit(b: Uint8Array): string | null {
  let i = -1
  for (let k = 0; k + 3 < b.length; k++) {
    if (AVC.every((v, j) => b[k + j] === v)) { i = k; break }
  }
  if (i < 0 || i + 7 >= b.length) return null
  const hex = [b[i + 5], b[i + 6], b[i + 7]].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `video/mp4; codecs="avc1.${hex},${AAC}"`
}

/** Parts of `rs` outside [t - back, t + ahead], as ranges to pass to SourceBuffer.remove. */
export function evictions(rs: Range[], t: number, back: number, ahead: number): Range[] {
  const lo = t - back
  const hi = t + ahead
  const out: Range[] = []
  for (const [a, b] of rs) {
    if (a < lo) out.push([a, Math.min(b, lo)])
    if (b > hi) out.push([Math.max(a, hi), b])
  }
  return out
}
