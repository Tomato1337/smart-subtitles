import { Icon } from './Icon'

/** MD3 filter chip: 32dp, 8dp corners, a check mark and secondary-container when selected. */
export function Chip({ label, selected, disabled, onClick }: {
  label: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`state-layer state-on-surface type-label-large relative inline-flex h-8 max-w-full items-center gap-1.5 rounded-[var(--md-sys-shape-corner-small)] px-3 disabled:opacity-40 ${
        selected
          ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
          : 'border border-[var(--md-sys-color-outline)] text-[var(--md-sys-color-on-surface-variant)]'
      }`}
    >
      {selected && <Icon name="check" size={18} />}
      <span className="truncate">{label}</span>
    </button>
  )
}
