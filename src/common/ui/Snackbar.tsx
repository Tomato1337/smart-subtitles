import { useEffect } from 'react'
import { useToast } from './toast'

/** MD3 snackbar: bottom center, 4 s by default, optional text action. */
export function Snackbar() {
  const { message, options, seq, hide } = useToast()
  const durationMs = options.durationMs ?? 4000
  useEffect(() => {
    if (!message) return
    const t = setTimeout(hide, durationMs)
    return () => clearTimeout(t)
  }, [message, seq, hide, durationMs])
  if (!message) return null
  return (
    <div
      role="status"
      className="type-body-medium fixed bottom-24 left-1/2 z-[200] flex max-w-[min(90vw,560px)] -translate-x-1/2 items-center gap-3 bg-[var(--md-sys-color-inverse-surface)] py-3 pr-2 pl-4 text-[var(--md-sys-color-inverse-on-surface)]"
      style={{ borderRadius: 'var(--md-sys-shape-corner-extra-small)' }}
    >
      <span className="pr-2">{message}</span>
      {options.action && (
        <button
          type="button"
          onClick={() => { options.action!.run(); hide() }}
          className="state-layer type-label-large relative shrink-0 rounded-full px-3 py-1.5 text-[var(--md-sys-color-inverse-primary)]"
        >
          {options.action.label}
        </button>
      )}
    </div>
  )
}
