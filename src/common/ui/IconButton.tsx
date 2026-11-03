import type { ButtonHTMLAttributes } from 'react'
import { Icon } from './Icon'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: string
  label: string
  variant?: 'standard' | 'filled'
  selected?: boolean
}

/** MD3 icon button: standard 40px or filled 56px with hover 8% / pressed 10% state layers. */
export function IconButton({ icon, label, variant = 'standard', selected, className = '', ...rest }: Props) {
  const size = variant === 'filled' ? 'size-14' : 'size-10'
  const colors =
    variant === 'filled'
      ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] state-on-primary'
      : `${selected ? 'text-[var(--md-sys-color-primary)]' : 'text-[var(--md-sys-color-on-surface)]'} state-on-surface`
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      className={`state-layer relative inline-flex shrink-0 items-center justify-center rounded-full ${size} ${colors} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={variant === 'filled' ? 28 : undefined} />
    </button>
  )
}
