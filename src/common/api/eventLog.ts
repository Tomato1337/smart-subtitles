import { invoke } from '@tauri-apps/api/core'
import { comboOf } from '@/common/utilities/keys'
import { notify } from './notify'

/** Longest single interaction line kept; a pasted config must not bloat the log. */
const MAX_LINE = 2000
/** Lines are batched for a second so a burst of IPC calls becomes one write. */
const FLUSH_MS = 1000
const INTERACTIVE = 'button,a,[role=button],[role=menuitem],[role=tab],[role=switch],[role=option],input,select,summary'

let buf: string[] = []
let timer: number | null = null
let installed = false

/**
 * Appends one interaction line to `~/.config/smart-subtitle/logs/events.log`. Lines are buffered and
 * sent with `log_events`, which stamps them server-side; logging never surfaces errors.
 */
export function logEvent(line: string): void {
 buf.push(`${new Date().toISOString()} ${line.slice(0, MAX_LINE)}`)
 if (timer !== null) return
 timer = setTimeout(() => {
  timer = null
  flushEvents()
 }, FLUSH_MS)
}

/** Sends whatever is buffered right now (page hide, before a long blocking action). */
export function flushEvents(): void {
 if (timer !== null) {
  clearTimeout(timer)
  timer = null
 }
 const lines = buf.splice(0)
 if (lines.length === 0) return
 // Direct invoke: going through `api` would log the logger's own call and recurse.
 invoke('log_events', { lines }).catch(() => undefined)
}

function errorText(e: unknown): string {
 return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e)
}

function labelOf(el: Element): string {
 const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim()
 return text ? text.slice(0, 80) : el.tagName
}

function onClick(e: MouseEvent): void {
 const target = e.target
 if (!(target instanceof Element)) return
 const el = target.closest(INTERACTIVE)
 if (el) {
  logEvent(`click "${labelOf(el)}"`)
  return
 }
 // Cue and phrase clicks have no interactive ancestor; the tag plus its text still identifies them.
 const text = (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
 logEvent(`click "${[target.tagName.toLowerCase(), text].filter(Boolean).join(' ')}"`)
}

function onKey(e: KeyboardEvent): void {
 if (e.repeat) return
 const combo = comboOf(e)
 if (!combo) return
 const t = e.target
 const typing = t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
 if (typing) return
 logEvent(`key ${combo}`)
}

function onJsError(e: ErrorEvent): void {
 logEvent(`js error: ${e.message} at ${e.filename}:${e.lineno}`)
 notify('error', `Ошибка интерфейса: ${e.message}`)
}

function onRejection(e: PromiseRejectionEvent): void {
 const text = errorText(e.reason)
 logEvent(`js rejection: ${text}`)
 notify('error', `Ошибка интерфейса: ${text}`)
}

/** Registers the global listeners once; safe to call from every entry path. */
export function installInteractionLog(): void {
 if (installed) return
 installed = true
 document.addEventListener('click', onClick, true)
 window.addEventListener('keydown', onKey, true)
 window.addEventListener('error', onJsError)
 window.addEventListener('unhandledrejection', onRejection)
 window.addEventListener('pagehide', flushEvents)
}
