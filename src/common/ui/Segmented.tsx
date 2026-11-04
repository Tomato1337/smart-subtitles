/** MD3 segmented button, single-select: outlined 40dp pill, selected segment in secondary-container. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-10 overflow-hidden rounded-full border border-[var(--md-sys-color-outline)]">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`state-layer state-on-surface type-label-large relative flex items-center px-4 whitespace-nowrap ${
            i > 0 ? 'border-l border-[var(--md-sys-color-outline)]' : ''
          } ${
            o.value === value
              ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
              : 'text-[var(--md-sys-color-on-surface)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
