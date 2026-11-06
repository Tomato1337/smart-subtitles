import { useEffect, useRef, useState } from 'react'
import { Dialog, Spinner } from '@tomato1337/m3e-react'
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

 // The last screen stays up while the dialog plays its exit (the store may drop `embedded` first).
 const [shown, setShown] = useState<{ mode: 'confirm' | 'loading'; info: NonNullable<typeof embedded> } | null>(null)
 if (open !== null && embedded && (shown?.mode !== open || shown.info !== embedded)) setShown({ mode: open, info: embedded })

 // The dialog focuses its safe action on open and gives focus back on close; the switch to the
 // wait screen removes the focused button, so focus moves to "Смотреть без ожидания".
 const dialog = useRef<HTMLDialogElement>(null)
 useEffect(() => {
  if (open !== null) dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
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

 if (!shown) return null
 const { info } = shown

 return (
  <Dialog
   ref={dialog}
   open={open !== null && !!embedded}
   // Esc means the safe action: skip the download, or stop waiting.
   onClose={() => {
    if (shown.mode === 'loading') onSkip()
    else if (!busy) void decide(false)
   }}
   aria-labelledby="embedded-gate-title"
   className="max-h-[85vh] w-[520px] max-w-[95vw] gap-4"
   style={{ userSelect: 'text' }}
  >
   {shown.mode === 'confirm' ? (
    <>
     <h2 id="embedded-gate-title" className="type-headline-small">Встроенные субтитры</h2>
     <p className="type-body-medium">
      В файле есть английские субтитры «{info.track}» — {info.totalCues.toLocaleString('ru-RU')} реплик.
      Чтобы достать их, TorrServer докачает ≈ {formatBytes(info.estBytes)} (части торрента по {formatBytes(info.pieceBytes)}).
      Начало до {formatTime(info.headUntil)} — ≈ {formatBytes(info.headBytes)}; фильм откроется, когда оно
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
      <Spinner />
      <span className="type-body-medium">
       Загружаю субтитры: {info.loadedCues.toLocaleString('ru-RU')} из {info.totalCues.toLocaleString('ru-RU')}
      </span>
     </div>
     <div className="flex justify-end">
      <button type="button" data-autofocus className={outlined} onClick={onSkip}>
       Смотреть без ожидания
      </button>
     </div>
    </>
   )}
  </Dialog>
 )
}
