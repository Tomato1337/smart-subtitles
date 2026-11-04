export function Icon({ name, size, fill }: { name: string; size?: number; fill?: boolean }) {
  return (
    <span
      className={`material-symbols-rounded${fill ? ' icon-fill' : ''}`}
      style={size ? { fontSize: size } : undefined}
      aria-hidden="true"
    >
      {name}
    </span>
  )
}
