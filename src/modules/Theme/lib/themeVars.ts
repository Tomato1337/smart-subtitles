import { argbFromHex, customColor, hexFromArgb } from '@material/material-color-utilities'

/** MD3 roles, camelCase. inir's palettes carry the same names in snake_case. */
export const roles = [
 'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
 'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
 'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
 'error', 'onError', 'errorContainer', 'onErrorContainer',
 'surface', 'onSurface', 'onSurfaceVariant', 'surfaceVariant',
 'surfaceDim', 'surfaceBright', 'surfaceContainerLowest', 'surfaceContainerLow',
 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest',
 'inverseSurface', 'inverseOnSurface', 'inversePrimary',
 'outline', 'outlineVariant', 'scrim',
] as const

/** Chunk kinds, blended towards the wallpaper seed so they sit in the inir palette. */
const kinds: [name: string, hex: string][] = [
 ['idiom', '#FF9800'], ['phrasal-verb', '#4FC3F7'], ['collocation', '#81C784'],
 ['slang', '#F06292'], ['reduction', '#BA68C8'], ['grammar', '#FFD54F'],
]
const ANKI = '#FFB74D'
/** Warnings: kept unblended so the orange stays orange on any wallpaper. */
const WARNING = '#FF9800'

export type ThemeInput = { seed: string; mode: string; colors: Record<string, string> }

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

/**
 * CSS custom properties for an inir theme: the roles the palette actually has, plus the app's own
 * kind/Anki colors derived from the seed. Both the live theme and the generated fallback use this.
 */
export function themeVars(t: ThemeInput): Record<string, string> {
 const out: Record<string, string> = {}
 for (const r of roles) {
  const v = t.colors[snake(r)]
  if (v) out[`--md-sys-color-${kebab(r)}`] = v
 }
 const group = t.mode === 'light' ? 'light' : 'dark'
 const seed = argbFromHex(t.seed)
 for (const [name, hex] of kinds) {
  out[`--app-kind-${name}`] = hexFromArgb(customColor(seed, { name, value: argbFromHex(hex), blend: true })[group].color)
 }
 const anki = customColor(seed, { name: 'anki-label', value: argbFromHex(ANKI), blend: true })[group]
 out['--app-anki-label'] = hexFromArgb(anki.color)
 out['--app-anki-label-container'] = hexFromArgb(anki.colorContainer)
 out['--app-anki-on-label-container'] = hexFromArgb(anki.onColorContainer)
 const warn = customColor(seed, { name: 'warning', value: argbFromHex(WARNING), blend: false })[group]
 out['--app-warning'] = hexFromArgb(warn.color)
 out['--app-warning-container'] = hexFromArgb(warn.colorContainer)
 out['--app-on-warning-container'] = hexFromArgb(warn.onColorContainer)
 // Dialog list text: pure white / black, the tinted on-surface roles read worse over tonal rows.
 out['--app-dialog-text'] = group === 'light' ? '#000000' : '#ffffff'
 return out
}
