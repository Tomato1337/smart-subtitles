import type { ButtonHTMLAttributes, CSSProperties } from 'react'
import { Icon } from './Icon'
import { shapeClip, type ShapeName } from './shapes'
import { useTipAnchor } from './tipAnchor'

type Variant = 'standard' | 'tonal' | 'secondary' | 'tertiary' | 'filled' | 'anki' | 'scrim'
type Size = 'sm' | 'md' | 'lg' | 'xl' | 'hero'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
 icon: string
 label: string
 variant?: Variant
 size?: Size
 /** Expressive silhouette, e.g. "cookie9" for the Anki/ask actions. */
 shape?: ShapeName
 /** Corner radius at rest (any CSS border-radius, finite lengths only); defaults per size. */
 radius?: string
 /** Corner radius while pressed: the expressive shape morph. Defaults to `radius`. */
 pressRadius?: string
 fill?: boolean
 selected?: boolean
 /** Tooltip side; "bottom" for buttons at the top of the window, "left" near its right edge. */
 tipPos?: 'top' | 'bottom' | 'bottom-start' | 'bottom-end' | 'left'
}

const BOX: Record<Size, string> = { sm: 'size-7', md: 'size-10', lg: 'size-12', xl: 'h-14 w-16', hero: 'h-[72px] w-24' }
const GLYPH: Record<Size, number> = { sm: 18, md: 22, lg: 24, xl: 28, hero: 40 }
/** Finite pill radii (half the height): see the `.morph` comment in main.css for why never rounded-full. */
const RADIUS: Record<Size, [rest: string, press: string]> = {
 sm: ['var(--md-sys-shape-corner-small)', 'var(--md-sys-shape-corner-small)'],
 md: ['20px', '20px'],
 lg: ['24px', '24px'],
 xl: ['var(--md-sys-shape-corner-large-increased)', '28px'],
 hero: ['36px', 'var(--md-sys-shape-corner-extra-large)'],
}

const BG: Record<Variant, string> = {
 standard: 'transparent',
 tonal: 'var(--tonal-bg, var(--md-sys-color-surface-container-highest))',
 secondary: 'var(--md-sys-color-secondary-container)',
 tertiary: 'var(--md-sys-color-tertiary-container)',
 filled: 'var(--md-sys-color-primary)',
 anki: 'var(--app-anki-label-container)',
 scrim: 'var(--app-video-scrim)',
}
const FG: Record<Variant, string> = {
 standard: 'var(--md-sys-color-on-surface-variant)',
 tonal: 'var(--tonal-fg, var(--md-sys-color-on-surface))',
 secondary: 'var(--md-sys-color-on-secondary-container)',
 tertiary: 'var(--md-sys-color-on-tertiary-container)',
 filled: 'var(--md-sys-color-on-primary)',
 anki: 'var(--app-anki-on-label-container)',
 scrim: 'var(--app-on-video)',
}

/**
 * MD3 Expressive icon button: 28/40/48/64×56/96×72 boxes, a variant colour pair, an optional
 * silhouette and a radius morph on press.
 *
 * The <button> itself only hosts the tooltip (`data-tip` ::after) and has no transitions: the
 * container colour, the state layer and the morph live on child spans (`.btn-surface`,
 * `.btn-state`). WebKitGTK restarts an element's transitions from its ::after's values when that
 * pseudo appears, so a transitioned button flashed to the tooltip colour and shape on every hover.
 */
export function IconButton({
 icon,
 label,
 variant = 'standard',
 size = 'md',
 shape,
 radius,
 pressRadius,
 fill,
 selected,
 tipPos = 'top',
 disabled,
 className = '',
 style,
 ...rest
}: Props) {
 const tip = useTipAnchor()
 const tonalSelected = selected && variant === 'tonal'
 const bg = disabled
  ? variant === 'standard'
   ? 'transparent'
   : 'color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent)'
  : tonalSelected
   ? 'var(--md-sys-color-secondary-container)'
   : BG[variant]
 const fg = disabled
  ? 'color-mix(in srgb, var(--md-sys-color-on-surface) 38%, transparent)'
  : tonalSelected
   ? 'var(--md-sys-color-on-secondary-container)'
   : selected && variant === 'standard'
    ? 'var(--md-sys-color-primary)'
    : FG[variant]
 const rest0 = radius ?? (variant === 'anki' ? 'var(--md-sys-shape-corner-medium)' : RADIUS[size][0])
 const press = pressRadius ?? (radius ?? (variant === 'anki' ? rest0 : RADIUS[size][1]))
 const clip = shape ? { clipPath: shapeClip[shape], WebkitClipPath: shapeClip[shape] } : undefined

 const classes = [
  'btn relative inline-flex shrink-0 items-center justify-center text-[var(--btn-fg)]',
  disabled ? 'cursor-default' : 'cursor-pointer',
  BOX[size],
  !disabled && !selected && variant === 'standard' ? 'hover:text-[var(--md-sys-color-on-surface)]' : '',
  className,
 ]
  .filter(Boolean)
  .join(' ')

 return (
  <button
   type="button"
   aria-label={label}
   data-tip={label}
   data-tip-pos={tipPos}
   disabled={disabled}
   className={classes}
   style={{
    '--btn-bg': bg,
    '--btn-fg': fg,
    '--btn-radius': rest0,
    '--btn-press-radius': press,
    '--state-color': variant === 'filled' ? 'var(--md-sys-color-on-primary)' : 'var(--md-sys-color-on-surface)',
    ...tip,
    ...style,
   } as CSSProperties}
   {...rest}
  >
   <span aria-hidden="true" className="btn-surface" style={clip} />
   {!disabled && <span aria-hidden="true" className="btn-state" style={clip} />}
   <span className="btn-glyph relative inline-flex">
    <Icon name={icon} size={GLYPH[size]} fill={fill} />
   </span>
  </button>
 )
}
