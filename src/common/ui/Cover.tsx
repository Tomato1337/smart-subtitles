import { useState } from 'react'
import { Icon } from '@tomato1337/m3e-react'

/** Poster image with a movie-icon tile fallback; a missing or broken poster never shows a video frame. */
export function Cover({ src, title, className = '' }: { src: string | null; title: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (src && failed !== src) {
    return (
      <img
        src={src}
        alt={`Постер «${title}»`}
        loading="lazy"
        onError={() => setFailed(src)}
        className={`block object-cover rounded-[var(--md-sys-shape-corner-medium)] ${className}`}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-highest)] text-[var(--md-sys-color-on-surface-variant)] ${className}`}
    >
      <Icon name="movie" />
    </span>
  )
}
