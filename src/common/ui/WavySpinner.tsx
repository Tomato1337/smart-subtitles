// 300 samples of a wavy circle with a 79% sweep, the same path the mockup draws at module load.
const D = (() => {
  let d = ''
  for (let i = 0; i <= 300; i++) {
    const a = (i / 300) * 2 * Math.PI * 0.78
    const r = 18 + 1.6 * Math.sin(a * 10)
    d += `${i ? 'L' : 'M'}${(24 + r * Math.cos(a)).toFixed(2)} ${(24 + r * Math.sin(a)).toFixed(2)}`
  }
  return d
})()

/** Wavy circular spinner for indeterminate work (opening a file). */
export function WavySpinner({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 48 48" width={48} height={48} role="progressbar" aria-label={label} className="wavy-spinner shrink-0">
      <path d={D} fill="none" stroke="var(--md-sys-color-primary)" strokeWidth={4} strokeLinecap="round" />
    </svg>
  )
}
