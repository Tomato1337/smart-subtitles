import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

type MenuProps = {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Anchor side inside a `relative` parent. */
  align?: 'left' | 'right'
  placement?: 'above' | 'below'
  className?: string
}

/** MD3 menu surface (level 2). Closes on outside press and Escape. */
export function Menu({ open, onClose, children, align = 'left', placement = 'below', className = '' }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-menu-trigger]')) onClose()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('keydown', key, true)
    }
  }, [open, onClose])
  if (!open) return null
  const pos = `${align === 'left' ? 'left-0' : 'right-0'} ${placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'}`
  return (
    <div
      ref={ref}
      role="menu"
      className={`md-pop absolute z-50 min-w-48 max-h-[60vh] overflow-y-auto bg-[var(--md-sys-color-surface-container)] py-2 text-[var(--md-sys-color-on-surface)] ${pos} ${className}`}
      style={{ borderRadius: 'var(--md-sys-shape-corner-small)', transformOrigin: 'top' }}
    >
      {children}
    </div>
  )
}

type ItemProps = {
  label: string
  onClick: () => void
  icon?: string
  /** radio/check indicator; undefined = none */
  selected?: boolean
  /** MD3 switch; undefined = none */
  on?: boolean
  disabled?: boolean
  hint?: string
}

export function MenuItem({ label, onClick, icon, selected, on, disabled, hint }: ItemProps) {
  const role = on !== undefined ? 'menuitemcheckbox' : selected !== undefined ? 'menuitemradio' : 'menuitem'
  return (
    <button
      type="button"
      role={role}
      aria-checked={on ?? selected}
      disabled={disabled}
      onClick={onClick}
      className="state-layer state-on-surface type-label-large relative flex w-full items-center gap-3 px-3 py-2 text-left disabled:opacity-40"
    >
      {selected !== undefined && <Icon name={selected ? 'radio_button_checked' : 'radio_button_unchecked'} size={20} />}
      {icon && <Icon name={icon} size={20} />}
      <span className="flex-1">{label}</span>
      {hint && <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">{hint}</span>}
      {on !== undefined && <Switch on={on} />}
    </button>
  )
}

export function Switch({ on }: { on: boolean }) {
  return (
    <span
      className="relative inline-block h-8 w-[52px] shrink-0 rounded-full border-2 transition-colors"
      style={{
        background: on ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-surface-container-highest)',
        borderColor: on ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-outline)',
      }}
    >
      <span
        className="absolute top-1/2 -translate-y-1/2 rounded-full transition-all"
        style={{
          left: on ? 24 : 6,
          width: on ? 24 : 16,
          height: on ? 24 : 16,
          marginLeft: on ? -4 : 2,
          background: on ? 'var(--md-sys-color-on-primary)' : 'var(--md-sys-color-outline)',
        }}
      />
    </span>
  )
}

export function MenuDivider({ title }: { title?: string }) {
  return (
    <div className="type-label-small mt-1 border-t border-[var(--md-sys-color-outline-variant)] px-3 pt-2 pb-1 text-[var(--md-sys-color-on-surface-variant)]">
      {title}
    </div>
  )
}
