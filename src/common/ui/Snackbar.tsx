import { useEffect } from 'react'
import { useNotifications } from '@/common/api/notify'
import { useToast } from './toast'

/** MD3 snackbar: bottom center by default, 4 s, optional text action; `placement: 'top'` for status. */
export function Snackbar() {
  const { message, options, seq, hide } = useToast()
  // Info messages must not cover the warning/error popups stacked above the bell.
  const stackBottom = useNotifications((s) => s.stackBottomPx)
  const durationMs = options.durationMs ?? 4000
  const top = options.placement === 'top'
  useEffect(() => {
    if (!message) return
    const t = setTimeout(hide, durationMs)
    return () => clearTimeout(t)
  }, [message, seq, hide, durationMs])
  if (!message) return null
  return (
    <div
      role="status"
      className={`type-body-medium fixed left-1/2 z-[200] flex max-w-[min(90vw,560px)] -translate-x-1/2 items-center gap-3 bg-[var(--md-sys-color-inverse-surface)] py-3 pr-2 pl-4 text-[var(--md-sys-color-inverse-on-surface)] transition-[bottom] duration-200 motion-reduce:transition-none ${top ? 'top-16 shadow-xl' : ''}`}
      style={top
        ? { borderRadius: 'var(--md-sys-shape-corner-extra-small)' }
        : { bottom: Math.max(96, stackBottom + 8), borderRadius: 'var(--md-sys-shape-corner-extra-small)' }}
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
