import type { ButtonHTMLAttributes } from 'react'
import { Icon } from './Icon'
import { useTipAnchor } from './tipAnchor'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: string
  label: string
  variant?: 'standard' | 'filled'
  selected?: boolean
  /** Tooltip side; "bottom" for buttons at the top of the window, "left" near its right edge. */
  tipPos?: 'top' | 'bottom' | 'bottom-start' | 'bottom-end' | 'left'
}

/** MD3 icon button: standard 40px or filled 56px with hover 8% / pressed 10% state layers. */
export function IconButton({ icon, label, variant = 'standard', selected, tipPos = 'top', className = '', style, ...rest }: Props) {
  const size = variant === 'filled' ? 'size-14' : 'size-10'
  const colors =
    variant === 'filled'
      ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] state-on-primary'
      : `${selected ? 'text-[var(--md-sys-color-primary)]' : 'text-[var(--md-sys-color-on-surface)]'} state-on-surface`
  const tip = useTipAnchor()
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      data-tip-pos={tipPos}
      className={`state-layer relative inline-flex shrink-0 items-center justify-center rounded-full ${size} ${colors} ${className}`}
      style={{ ...tip, ...style }}
      {...rest}
    >
      <Icon name={icon} size={variant === 'filled' ? 28 : undefined} />
    </button>
  )
}
