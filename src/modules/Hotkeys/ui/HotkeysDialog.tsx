import { Button, Dialog, IconButton, Kbd } from '@tomato1337/m3e-react'
import { HOTKEY_ACTIONS } from '../lib/actions'
import { comboParts, useHotkeyCapture } from '../useHotkeyCapture'

const HINT = 'type-body-small text-[var(--md-sys-color-on-surface-variant)]'

/**
 * One key per player action, applied as soon as it is pressed. A native modal dialog: Esc closes it,
 * focus stays inside and comes back to the opener. While a key is being captured, `useHotkeyCapture`
 * intercepts keys in capture phase (Esc cancels capture instead of closing the dialog).
 */
export function HotkeysDialog({ onClose }: { onClose: () => void }) {
  const { bindings, capturing, toggleCapture, unbind, reset } = useHotkeyCapture()

  return (
    <Dialog
      onClose={onClose}
      dismissible
      aria-labelledby="hotkeys-title"
      className="max-h-[90vh] w-[520px] max-w-[96vw] p-0"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 px-6 pt-5 pb-2">
        <div className="min-w-0">
          <h2 id="hotkeys-title" className="type-headline-small">Горячие клавиши</h2>
          <p className={HINT}>Работают в плеере. Нажмите на клавишу, чтобы изменить; Esc — отмена.</p>
        </div>
        <IconButton icon="close" label="Закрыть" onClick={onClose} />
      </div>

      <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain">
        <div className="flex flex-col px-6 py-1">
          {HOTKEY_ACTIONS.map((a) => {
            const combo = bindings[a.id]
            const here = capturing === a.id
            const parts = comboParts(combo)
            return (
              <div key={a.id} className="flex items-center gap-2 border-b border-[var(--md-sys-color-outline-variant)] py-1.5 last:border-0">
                <span className="type-body-medium min-w-0 flex-1">{a.label}</span>
                <button
                  type="button"
                  aria-pressed={here}
                  onClick={() => toggleCapture(a.id)}
                  className={`state-layer state-on-surface type-label-large relative inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 ${
                    here
                      ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                      : combo === null
                        ? 'border border-dashed border-[var(--md-sys-color-outline)] text-[var(--md-sys-color-on-surface-variant)]'
                        : 'bg-[var(--md-sys-color-surface-container-high)]'
                  }`}
                >
                  {here ? (
                    'Нажмите клавишу…'
                  ) : combo === null ? (
                    'Не назначено'
                  ) : (
                    parts.map((part, idx) => (
                      <Kbd key={`${part}-${idx}`} size="sm">{part}</Kbd>
                    ))
                  )}
                </button>
                <IconButton icon="close" label="Убрать клавишу" tipPos="left" disabled={combo === null} onClick={() => unbind(a.id)} />
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 px-6 pt-2 pb-4">
        <Button variant="text" onClick={reset}>Сбросить все</Button>
        <Button variant="filled" data-autofocus onClick={onClose}>Готово</Button>
      </div>
    </Dialog>
  )
}
