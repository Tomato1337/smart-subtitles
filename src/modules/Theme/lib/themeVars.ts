import { colorRoles, colorVar, customColorTones } from '@tomato1337/m3e-tokens'

/** Chunk kinds, blended towards the wallpaper seed so they sit in the inir palette. */
const kinds: [name: string, hex: string][] = [
 ['idiom', '#FF9800'], ['phrasal-verb', '#4FC3F7'], ['collocation', '#81C784'],
 ['slang', '#F06292'], ['reduction', '#BA68C8'], ['grammar', '#FFD54F'],
]
const ANKI = '#FFB74D'
/** Warnings: amber-gold kept unblended so warnings stay clearly distinct from red error badges. */
const WARNING = '#FFC107'
/** Error badge: vivid red kept distinct from amber warnings across dark and light modes. */
const ERROR_BADGE = '#E53935'
/** Success: kept unblended so the green reads clearly across themes. */
const SUCCESS = '#2E9E6E'

export type ThemeInput = { seed: string; mode: string; colors: Record<string, string> }

/** inir's palettes carry the M3 role names in snake_case. */
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

const HEX = /^#[0-9a-f]{6}$/i

function parseHex(hex: string): [number, number, number] {
 const n = parseInt(hex.slice(1), 16)
 return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function toHex(r: number, g: number, b: number): string {
 const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
 return `#${clamp(r)}${clamp(g)}${clamp(b)}`
}

function relativeLuminance(hex: string): number {
 const [r, g, b] = parseHex(hex).map((v) => {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
 })
 return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
 const la = relativeLuminance(a)
 const lb = relativeLuminance(b)
 return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Pulls `fg` slightly toward white (on dark bg) or black (on light bg) until it meets `target`
 * contrast against `bg`, keeping the original wallpaper hue intact. Returns `fg` unchanged when it
 * already meets the floor.
 */
function ensureContrast(fg: string, bg: string, target: number): string {
 if (!HEX.test(fg) || !HEX.test(bg) || contrastRatio(fg, bg) >= target) return fg
 const [fr, fgG, fb] = parseHex(fg)
 const pole = relativeLuminance(bg) < 0.5 ? 255 : 0
 let lo = 0
 let hi = 1
 for (let i = 0; i < 14; i++) {
  const mid = (lo + hi) / 2
  const candidate = toHex(fr + (pole - fr) * mid, fgG + (pole - fgG) * mid, fb + (pole - fb) * mid)
  if (contrastRatio(candidate, bg) >= target) hi = mid
  else lo = mid
 }
 return toHex(fr + (pole - fr) * hi, fgG + (pole - fgG) * hi, fb + (pole - fb) * hi)
}

const CONTAINER_PAIRS: [fg: string, bg: string][] = [
 ['--md-sys-color-on-primary-container', '--md-sys-color-primary-container'],
 ['--md-sys-color-on-secondary-container', '--md-sys-color-secondary-container'],
 ['--md-sys-color-on-tertiary-container', '--md-sys-color-tertiary-container'],
 ['--md-sys-color-on-error-container', '--md-sys-color-error-container'],
]

/**
 * CSS custom properties for an inir theme: the M3 roles the palette actually has (the kit's baseline
 * covers the rest), plus the app's own kind/Anki/warning colors derived from the seed. Both the live
 * theme and the generated fallback use this.
 */
export function themeVars(t: ThemeInput): Record<string, string> {
 const out: Record<string, string> = {}
 for (const role of colorRoles) {
  const v = t.colors[snake(role)]
  if (v) out[colorVar(role)] = v
 }
 // inir's dark palettes can emit on_surface identical to on_surface_variant (#c7c5d1) and
 // container text right on the 4.5:1 floor; lift only those roles so hierarchy and legibility hold.
 if (out['--md-sys-color-on-surface'] && out['--md-sys-color-surface']) {
  out['--md-sys-color-on-surface'] = ensureContrast(out['--md-sys-color-on-surface'], out['--md-sys-color-surface'], 14)
 }
 for (const [fgVar, bgVar] of CONTAINER_PAIRS) {
  if (out[fgVar] && out[bgVar]) out[fgVar] = ensureContrast(out[fgVar], out[bgVar], 6.5)
 }
 const dark = t.mode !== 'light'
 for (const [name, hex] of kinds) {
  const tones = customColorTones(hex, t.seed, dark)
  const videoTones = customColorTones(hex, t.seed, true)
  out[`--app-kind-${name}`] = tones.color
  out[`--app-on-video-kind-${name}`] = videoTones.color
  if (name === 'grammar') {
   out['--app-grammar-container'] = tones.container
   out['--app-grammar-on-container'] = ensureContrast(tones.onContainer, tones.container, 6.5)
   out['--app-on-video-grammar-container'] = videoTones.container
   out['--app-on-video-grammar-on-container'] = ensureContrast(videoTones.onContainer, videoTones.container, 6.5)
  }
 }
 const anki = customColorTones(ANKI, t.seed, dark)
 const ankiOnVideo = customColorTones(ANKI, t.seed, true)
 out['--app-anki-label'] = anki.color
 out['--app-on-video-anki-label'] = ankiOnVideo.color
 out['--app-anki-label-container'] = anki.container
 out['--app-anki-on-label-container'] = anki.onContainer
 const warn = customColorTones(WARNING, t.seed, dark, false)
 out['--app-warning'] = warn.color
 out['--app-on-warning'] = ensureContrast(warn.onColor, warn.color, 4.5)
 out['--app-warning-container'] = warn.container
 out['--app-on-warning-container'] = warn.onContainer
 const errBadgeBg = dark ? '#d93025' : customColorTones(ERROR_BADGE, t.seed, false, false).color
 out['--app-error-badge'] = errBadgeBg
 out['--app-on-error-badge'] = ensureContrast('#ffffff', errBadgeBg, 4.5)
 const ok = customColorTones(SUCCESS, t.seed, dark, false)
 out['--app-success'] = ok.color
 out['--app-success-container'] = ok.container
 out['--app-on-success-container'] = ok.onContainer
 // Dialog list text: pure white / black, the tinted on-surface roles read worse over tonal rows.
 out['--app-dialog-text'] = dark ? '#ffffff' : '#000000'
 return out
}
