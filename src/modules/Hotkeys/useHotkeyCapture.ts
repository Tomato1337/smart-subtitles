import { useCallback, useEffect, useState } from 'react'
import { toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { comboOf } from '@/common/utilities/keys'
import { ACTION_LABEL, RESERVED_CODES, type HotkeyAction } from './lib/actions'
import { keyLabel } from './lib/bindings'
import { useHotkeysStore } from './store/hotkeysStore'

/** Splits a stored combo (`Shift+ArrowLeft`) into readable per-key labels (`['Shift', '←']`) for `<Kbd>` caps. */
export function comboParts(combo: string | null): string[] {
  if (combo === null) return []
  return combo.split('+').map((part) => keyLabel(part))
}

/**
 * Shared key-capture state machine for `HotkeysDialog` and the Settings Hub hotkeys section.
 * Attaches a capture-phase listener while recording so Esc cancels capture instead of closing
 * dialogs or triggering page shortcuts, and captured keys never reach buttons or the player.
 */
export function useHotkeyCapture() {
  const bindings = useHotkeysStore((s) => s.bindings)
  const bind = useHotkeysStore((s) => s.bind)
  const storeUnbind = useHotkeysStore((s) => s.unbind)
  const storeReset = useHotkeysStore((s) => s.reset)
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null)

  const startCapture = useCallback((action: HotkeyAction) => setCapturing(action), [])
  const toggleCapture = useCallback(
    (action: HotkeyAction) => setCapturing((c) => (c === action ? null : action)),
    [],
  )
  const cancelCapture = useCallback(() => setCapturing(null), [])

  const unbind = useCallback(
    (action: HotkeyAction) => {
      setCapturing((c) => (c === action ? null : c))
      storeUnbind(action)
    },
    [storeUnbind],
  )

  const reset = useCallback(() => {
    setCapturing(null)
    storeReset()
    toast('Клавиши сброшены')
  }, [storeReset])

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      // The key is the new binding: it must not press the focused button, move focus, close a dialog
      // (preventDefault on Esc cancels the close request), trigger page shortcuts or reach the player.
      e.stopImmediatePropagation()
      e.stopPropagation()
      e.preventDefault()
      if (e.repeat) return
      if (e.code === 'Escape') {
        setCapturing(null)
        return
      }
      if (RESERVED_CODES.has(e.code)) return
      const combo = comboOf(e)
      if (!combo) return
      const stolen = bind(capturing, combo)
      if (stolen) {
        notify(
          'warn',
          `Клавиша ${keyLabel(combo)} перешла к «${ACTION_LABEL[capturing]}»: у «${ACTION_LABEL[stolen]}» клавиши больше нет`,
        )
      }
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, bind])

  return { bindings, capturing, startCapture, toggleCapture, cancelCapture, unbind, reset }
}
