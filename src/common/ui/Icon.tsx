export function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <span className="material-symbols-outlined" style={size ? { fontSize: size } : undefined} aria-hidden="true">
      {name}
    </span>
  )
}
