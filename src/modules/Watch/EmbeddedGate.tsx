import { useEffect, useRef, useState } from 'react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { SessionState } from '@/common/types/ipc'
import { formatBytes } from '@/common/utilities/bytes'
import { formatTime } from '@/common/utilities/time'
import { usePlayer, usePlaybackStore } from '@/modules/Player'
import { useSubsStore } from '@/modules/Subtitles'
import { embeddedHold } from './embeddedHold'

export { embeddedHold }

type Props = {
 session: SessionState
 open: 'confirm' | 'loading' | null
 /** Watch right away; the rest of the track keeps loading in the background. */
 onSkip: () => void
}

/**
 * Download confirmation and wait screen of the embedded subtitles: the user sees how much of the
 * file TorrServer would pull before anything starts, and the film is held until the head is in.
 */
export function EmbeddedGate({ session, open, onSkip }: Props) {
 const p = usePlayer()
 const embedded = useSubsStore((s) => s.embedded)
 const playing = usePlaybackStore((s) => s.playing)
 const [busy, setBusy] = useState(false)

 // The modal owns the film while it is up: the player's own autoplay is undone on every attempt.
 useEffect(() => {
  if (open !== null && playing) p.pause()
 }, [open, playing, p])

 // The film starts by itself once the head is loaded, or when the user skips the wait.
 const wasOpen = useRef<typeof open>(null)
 useEffect(() => {
  if (wasOpen.current !== null && open === null) p.play()
  wasOpen.current = open
 }, [open, p])

 // Same overlay shell as the other dialogs of the app; focus starts on the safe action and comes back.
 const overlay = useRef<HTMLDivElement>(null)
 const invoker = useRef<HTMLElement | null>(null)
 useEffect(() => {
  if (open === null) {
   invoker.current?.focus()
   invoker.current = null
   return
  }
  invoker.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null
  overlay.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
 }, [open])

 const decide = async (accept: boolean) => {
  setBusy(true)
  try {
   await api.subsEmbeddedDecide(session.mediaId, accept)
  } catch (e) {
   notify('error', errorText(e))
  } finally {
   setBusy(false)
  }
 }

 const outlined = 'state-layer state-on-surface type-label-large relative rounded-full border border-[var(--md-sys-color-outline)] px-5 py-2'
 const filled = 'state-layer state-on-primary type-label-large relative rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)]'

 if (open === null || !embedded) return null

 return (
  <div className="fixed inset-0 z-[180] flex items-center justify-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_50%,transparent)]">
   <div
    ref={overlay}
    role="dialog"
    aria-modal="true"
    aria-labelledby="embedded-gate-title"
    className="md-pop flex max-h-[85vh] w-[520px] max-w-[95vw] flex-col gap-4 overflow-y-auto bg-[var(--md-sys-color-surface-container-high)] p-6"
    style={{ borderRadius: 'var(--md-sys-shape-corner-extra-large)', userSelect: 'text' }}
   >
    {open === 'confirm' ? (
     <>
      <h2 id="embedded-gate-title" className="type-headline-small">Встроенные субтитры</h2>
      <p className="type-body-medium">
       В файле есть английские субтитры «{embedded.track}» — {embedded.totalCues.toLocaleString('ru-RU')} реплик.
       Чтобы достать их, TorrServer докачает ≈ {formatBytes(embedded.estBytes)} (части торрента по {formatBytes(embedded.pieceBytes)}).
       Начало до {formatTime(embedded.headUntil)} — ≈ {formatBytes(embedded.headBytes)}; фильм откроется, когда оно
       загрузится, остальное догрузится во время просмотра.
      </p>
      <div className="flex justify-end gap-2">
       <button type="button" data-autofocus disabled={busy} className={outlined} onClick={() => void decide(false)}>
        Не загружать
       </button>
       <button type="button" disabled={busy} className={filled} onClick={() => void decide(true)}>
        Загрузить
       </button>
      </div>
     </>
    ) : (
     <>
      <h2 id="embedded-gate-title" className="type-headline-small">Читаю субтитры из файла</h2>
      <div className="flex items-center gap-4">
       <span className="md-spinner" aria-hidden="true" />
       <span className="type-body-medium">
        Загружаю субтитры: {embedded.loadedCues.toLocaleString('ru-RU')} из {embedded.totalCues.toLocaleString('ru-RU')}
       </span>
      </div>
      <div className="flex justify-end">
       <button type="button" data-autofocus className={outlined} onClick={onSkip}>
        Смотреть без ожидания
       </button>
      </div>
     </>
    )}
   </div>
  </div>
 )
}
