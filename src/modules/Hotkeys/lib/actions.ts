/** Every rebindable player action, in the order the dialog lists them. `combo` is the default key. */
export const HOTKEY_ACTIONS = [
  { id: 'playPause', label: 'Пауза / воспроизведение', combo: 'Space' },
  { id: 'prevCue', label: 'Предыдущая реплика', combo: 'ArrowLeft' },
  { id: 'nextCue', label: 'Следующая реплика', combo: 'ArrowRight' },
  { id: 'back5', label: 'Назад на 5 с', combo: 'Shift+ArrowLeft' },
  { id: 'forward5', label: 'Вперёд на 5 с', combo: 'Shift+ArrowRight' },
  { id: 'replay', label: 'Повторить реплику', combo: 'KeyR' },
  { id: 'reveal', label: 'Показать фразу в режиме «Скрывать субтитры»', combo: 'KeyA' },
  { id: 'sidebar', label: 'Диалоги', combo: 'KeyS' },
  { id: 'showEn', label: 'Английский текст', combo: 'KeyE' },
  { id: 'showRu', label: 'Русский текст', combo: 'KeyT' },
  { id: 'patterns', label: 'Конструкции', combo: 'KeyP' },
  { id: 'guide', label: 'Как читать подсветку', combo: 'KeyH' },
  { id: 'chat', label: 'Чат с агентом', combo: 'KeyC' },
  { id: 'offsetMinus', label: 'Сдвиг субтитров −0,1 с', combo: 'KeyZ' },
  { id: 'offsetPlus', label: 'Сдвиг субтитров +0,1 с', combo: 'KeyX' },
  { id: 'slower', label: 'Медленнее', combo: 'BracketLeft' },
  { id: 'faster', label: 'Быстрее', combo: 'BracketRight' },
  { id: 'fullscreen', label: 'Полный экран', combo: 'KeyF' },
] as const

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]['id']

/** One key per action; `null` = not assigned. */
export type Bindings = Record<HotkeyAction, string | null>

export const DEFAULT_BINDINGS = Object.fromEntries(
  HOTKEY_ACTIONS.map((a) => [a.id, a.combo]),
) as Bindings

export const ACTION_LABEL = Object.fromEntries(
  HOTKEY_ACTIONS.map((a) => [a.id, a.label]),
) as Record<HotkeyAction, string>

/** Keys the dialog never binds: Escape cancels capture and always exits fullscreen; Tab moves focus. */
export const RESERVED_CODES = new Set(['Escape', 'Tab'])
