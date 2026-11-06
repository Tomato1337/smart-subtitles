import { colorRoles, colorVar, customColorTones } from '@tomato1337/m3e-tokens'

/** Chunk kinds, blended towards the wallpaper seed so they sit in the inir palette. */
const kinds: [name: string, hex: string][] = [
 ['idiom', '#FF9800'], ['phrasal-verb', '#4FC3F7'], ['collocation', '#81C784'],
 ['slang', '#F06292'], ['reduction', '#BA68C8'], ['grammar', '#FFD54F'],
]
const ANKI = '#FFB74D'
/** Warnings: kept unblended so the orange stays orange on any wallpaper. */
const WARNING = '#FF9800'

export type ThemeInput = { seed: string; mode: string; colors: Record<string, string> }

/** inir's palettes carry the M3 role names in snake_case. */
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

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
 const dark = t.mode !== 'light'
 for (const [name, hex] of kinds) out[`--app-kind-${name}`] = customColorTones(hex, t.seed, dark).color
 const anki = customColorTones(ANKI, t.seed, dark)
 out['--app-anki-label'] = anki.color
 out['--app-anki-label-container'] = anki.container
 out['--app-anki-on-label-container'] = anki.onContainer
 const warn = customColorTones(WARNING, t.seed, dark, false)
 out['--app-warning'] = warn.color
 out['--app-warning-container'] = warn.container
 out['--app-on-warning-container'] = warn.onContainer
 // Dialog list text: pure white / black, the tinted on-surface roles read worse over tonal rows.
 out['--app-dialog-text'] = dark ? '#ffffff' : '#000000'
 return out
}
