/** Modifier-only presses (ShiftLeft, OSLeft, …) are not a combo on their own. */
export const MODIFIER_KEY = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/

type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

/** Layout-independent combo `Ctrl+Alt+Shift+Meta+<code>` (only the held modifiers, in that order); null for a bare modifier. */
export function comboOf(e: KeyLike): string | null {
  if (MODIFIER_KEY.test(e.code)) return null
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.metaKey ? 'Meta+' : ''}${e.code}`
}
