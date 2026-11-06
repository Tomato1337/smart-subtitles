import { useEffect, useState } from 'react'
import { Dialog, IconButton, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { comboOf } from '@/common/utilities/keys'
import { ACTION_LABEL, HOTKEY_ACTIONS, RESERVED_CODES, type HotkeyAction } from '../lib/actions'
import { keyLabel } from '../lib/bindings'
import { useHotkeysStore } from '../store/hotkeysStore'

const PRIMARY =
 'state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-40'
const TEXT_BUTTON = 'state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]'
const HINT = 'type-body-small text-[var(--md-sys-color-on-surface-variant)]'

/**
 * One key per player action, applied as soon as it is pressed. A native modal dialog: Esc closes it,
 * focus stays inside and comes back to the opener. While a key is being captured, a capture-phase
 * listener takes every key (Esc included, so it cancels the capture instead of closing the dialog).
 */
export function HotkeysDialog({ onClose }: { onClose: () => void }) {
 const bindings = useHotkeysStore((s) => s.bindings)
 const bind = useHotkeysStore((s) => s.bind)
 const unbind = useHotkeysStore((s) => s.unbind)
 const reset = useHotkeysStore((s) => s.reset)
 const [capturing, setCapturing] = useState<HotkeyAction | null>(null)

 useEffect(() => {
  if (!capturing) return
  const onKey = (e: KeyboardEvent) => {
   // The key is the new binding: it must not press the focused button, move focus, close the dialog
   // (preventDefault on Esc cancels the close request) or reach the player.
   e.stopPropagation()
   e.preventDefault()
   if (e.repeat) return
   if (e.code === 'Escape') { setCapturing(null); return }
   if (RESERVED_CODES.has(e.code)) return
   const combo = comboOf(e)
   if (!combo) return
   const stolen = bind(capturing, combo)
   if (stolen) notify('warn', `Клавиша ${keyLabel(combo)} перешла к «${ACTION_LABEL[capturing]}»: у «${ACTION_LABEL[stolen]}» клавиши больше нет`)
   setCapturing(null)
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
 }, [capturing, bind])

 return (
  <Dialog
   onClose={onClose}
   dismissible
   aria-labelledby="hotkeys-title"
   className="max-h-[90vh] w-[520px] max-w-[96vw] p-0"
  >
   <div className="flex items-start justify-between gap-2 px-6 pt-5 pb-2">
    <div className="min-w-0">
     <h2 id="hotkeys-title" className="type-headline-small">Горячие клавиши</h2>
     <p className={HINT}>Работают в плеере. Нажмите на клавишу, чтобы изменить; Esc — отмена.</p>
    </div>
    <IconButton icon="close" label="Закрыть" onClick={onClose} />
   </div>

   <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-1">
    {HOTKEY_ACTIONS.map((a) => {
     const combo = bindings[a.id]
     const here = capturing === a.id
     return (
      <div key={a.id} className="flex items-center gap-2 border-b border-[var(--md-sys-color-outline-variant)] py-1.5 last:border-0">
       <span className="type-body-medium min-w-0 flex-1">{a.label}</span>
       <button
        type="button"
        aria-pressed={here}
        onClick={() => setCapturing((c) => (c === a.id ? null : a.id))}
        className={`state-layer state-on-surface type-label-large relative shrink-0 rounded-full px-4 py-1.5 ${here
         ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
         : combo === null
          ? 'border border-dashed border-[var(--md-sys-color-outline)] text-[var(--md-sys-color-on-surface-variant)]'
          : 'bg-[var(--md-sys-color-surface-container-highest)]'
         }`}
       >
        {here ? 'Нажмите клавишу…' : combo === null ? 'Не назначено' : keyLabel(combo)}
       </button>
       <IconButton icon="close" label="Убрать клавишу" tipPos="left" disabled={combo === null} onClick={() => unbind(a.id)} />
      </div>
     )
    })}
   </div>

   <div className="flex items-center justify-end gap-2 px-6 pt-2 pb-4">
    <button type="button" className={TEXT_BUTTON} onClick={() => { reset(); toast('Клавиши сброшены') }}>Сбросить все</button>
    <button type="button" data-autofocus className={PRIMARY} onClick={onClose}>Готово</button>
   </div>
  </Dialog>
 )
}
