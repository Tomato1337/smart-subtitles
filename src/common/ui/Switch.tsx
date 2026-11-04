/**
 * MD3 switch: 52×32 track, 16dp handle when off, 24dp when on. The native input stays for
 * keyboard and screen readers, the visible track/thumb are driven from `checked`.
 */
export function Switch({ label, ariaLabel, checked, disabled, onChange }: {
 label?: string
 /** Accessible name when the visible text lives outside this component. */
 ariaLabel?: string
 checked: boolean
 disabled?: boolean
 onChange: (v: boolean) => void
}) {
 return (
  <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
   {label && <span className="type-body-medium">{label}</span>}
   <input
    type="checkbox"
    role="switch"
    aria-label={ariaLabel}
    aria-checked={checked}
    checked={checked}
    disabled={disabled}
    onChange={(e) => onChange(e.target.checked)}
    className="peer sr-only"
   />
   <span
    aria-hidden="true"
    className={`relative inline-flex h-8 w-[52px] shrink-0 items-center rounded-full transition-colors duration-200 peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--md-sys-color-secondary)] ${checked
      ? 'bg-[var(--md-sys-color-primary)]'
      : 'border-2 border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-highest)]'
     }`}
   >
    <span
     className={`rounded-full transition-all duration-200 ${checked
       ? 'mr-1 ml-auto size-6 bg-[var(--md-sys-color-on-primary)]'
       : 'ml-1 size-4 bg-[var(--md-sys-color-outline)]'
      }`}
    />
   </span>
  </label>
 )
}
