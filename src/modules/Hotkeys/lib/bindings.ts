import { DEFAULT_BINDINGS, HOTKEY_ACTIONS, type Bindings, type HotkeyAction } from './actions'

/** The action currently holding `combo`, if any. */
export function actionFor(b: Bindings, combo: string): HotkeyAction | undefined {
 return HOTKEY_ACTIONS.find((a) => b[a.id] === combo)?.id
}

/**
 * Gives `combo` to `action`. A key belongs to one action only: whoever held it before loses it,
 * and comes back as `stolen` so the caller can say so.
 */
export function rebind(b: Bindings, action: HotkeyAction, combo: string): { bindings: Bindings; stolen: HotkeyAction | null } {
 const holder = actionFor(b, combo)
 if (holder === action) return { bindings: b, stolen: null }
 const bindings: Bindings = { ...b, [action]: combo }
 if (holder) bindings[holder] = null
 return { bindings, stolen: holder ?? null }
}

/** Two actions must never share a key: the first one in `HOTKEY_ACTIONS` order keeps it. */
function dedupe(b: Bindings): Bindings {
 const seen = new Set<string>()
 const out = { ...b }
 for (const { id } of HOTKEY_ACTIONS) {
  const combo = out[id]
  if (combo === null) continue
  if (seen.has(combo)) out[id] = null
  else seen.add(combo)
 }
 return out
}

/** Defaults with the saved overrides on top; anything unrecognised is ignored. */
export function parseOverrides(raw: string | null): Bindings {
 const bindings: Bindings = { ...DEFAULT_BINDINGS }
 let parsed: unknown = null
 try {
  parsed = raw === null ? null : JSON.parse(raw)
 } catch {
  parsed = null
 }
 if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
  for (const [key, value] of Object.entries(parsed)) {
   if (!Object.hasOwn(DEFAULT_BINDINGS, key)) continue
   if (value !== null && typeof value !== 'string') continue
   bindings[key as HotkeyAction] = value
  }
 }
 return dedupe(bindings)
}

/** Only what differs from the defaults: actions added later still get their own default key. */
export function overridesOf(b: Bindings): Partial<Bindings> {
 const out: Partial<Bindings> = {}
 for (const { id } of HOTKEY_ACTIONS) {
  if (b[id] !== DEFAULT_BINDINGS[id]) out[id] = b[id]
 }
 return out
}

const CODE_LABEL: Record<string, string> = {
 Space: 'Пробел',
 ArrowLeft: '←',
 ArrowRight: '→',
 ArrowUp: '↑',
 ArrowDown: '↓',
 BracketLeft: '[',
 BracketRight: ']',
 Comma: ',',
 Period: '.',
 Slash: '/',
 Backslash: '\\',
 Semicolon: ';',
 Quote: "'",
 Backquote: '`',
 Minus: '-',
 Equal: '=',
}

/** `KeyP` → `P`, modifiers and unusual codes are shown as they are. */
function codeLabel(code: string): string {
 const letter = /^Key([A-Z])$/.exec(code)
 if (letter) return letter[1]
 const digit = /^Digit(\d)$/.exec(code)
 if (digit) return digit[1]
 const numpad = /^Numpad(\d)$/.exec(code)
 if (numpad) return `Num ${numpad[1]}`
 return CODE_LABEL[code] ?? code
}

/** Human-readable combo for buttons and hints; an unassigned action shows a dash. */
export function keyLabel(combo: string | null): string {
 if (combo === null) return '—'
 return combo.split('+').map(codeLabel).join('+')
}

/** `text` with its current key in brackets, or just `text` while the action has no key. */
export function withKey(text: string, combo: string | null): string {
 return combo === null ? text : `${text} (${keyLabel(combo)})`
}
