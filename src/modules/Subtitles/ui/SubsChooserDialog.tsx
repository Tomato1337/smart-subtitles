import { useQuery } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useState } from 'react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { SubCandidate, SubtitleSource } from '@/common/types/ipc'
import { formatBytes } from '@/common/utilities/bytes'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { toast } from '@/common/ui/toast'
import { useSubsStore } from '../store/subsStore'

const PRIMARY =
 'state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-40'
const TEXT_BUTTON = 'state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)] disabled:opacity-40'
const HINT = 'type-body-small text-[var(--md-sys-color-on-surface-variant)]'

const GROUPS: [SubtitleSource, string][] = [
 ['torrserver', 'TorrServer'],
 ['sidecar', 'Субтитры из Lampa'],
 ['embedded', 'Встроенные в видео'],
 ['opensubtitles', 'OpenSubtitles'],
]

/** What the user asked for: a row of the list, or a file from disk. */
type Action = { kind: 'candidate'; key: string; candidate: SubCandidate } | { kind: 'file'; path: string }

function title(c: SubCandidate): string {
 switch (c.source) {
  case 'torrserver':
   return c.lang === 'und' ? `${c.title} · язык не указан` : c.title
  case 'sidecar':
   return c.label
  case 'embedded':
   return `${c.title} · встроенные`
  case 'opensubtitles':
   return c.release
 }
}

function itemHint(c: SubCandidate): string | null {
 if (c.source === 'embedded') return `${c.cues} реплик · ≈ ${formatBytes(c.bytes)}`
 if (c.source !== 'opensubtitles') return null
 return [
  c.exact ? 'совпадает с файлом' : 'по названию',
  c.hearingImpaired ? 'для слабослышащих' : '',
  `${c.downloads} скачиваний`,
  c.cached ? 'уже скачаны' : '',
 ]
  .filter(Boolean)
  .join(' · ')
}

/**
 * Every English subtitle the sources can offer for this film, the installed one marked. The key
 * listener runs in the capture phase and swallows every key, so the player underneath stays idle.
 */
export function SubsChooserDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
 const q = useQuery({ queryKey: ['subs-candidates', mediaId], queryFn: () => api.subsCandidates(mediaId), staleTime: 0, gcTime: 0 })
 const hasAnalysis = useSubsStore((s) => s.annotations.size > 0 || (s.annot?.done ?? 0) > 0)
 const [pending, setPending] = useState<Action | null>(null)
 const [busy, setBusy] = useState<string | null>(null)

 useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
   // The player listens in the bubble phase on window: stopping here keeps it out of the way.
   e.stopPropagation()
   if (e.key !== 'Escape') return
   if (pending) setPending(null)
   else onClose()
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
 }, [pending, onClose])

 const execute = async (a: Action) => {
  setPending(null)
  setBusy(a.kind === 'candidate' ? a.key : `file:${a.path}`)
  try {
   if (a.kind === 'candidate') await api.subsSelect(mediaId, a.candidate)
   else await api.subsLoadFile(mediaId, a.path)
   toast('Субтитры заменены')
   onClose()
  } catch (e) {
   notify('error', errorText(e))
  } finally {
   setBusy(null)
  }
 }

 // Replacing the subtitles deletes the analysis: ask first when there is something to lose.
 const start = (a: Action) => {
  if (hasAnalysis) setPending(a)
  else void execute(a)
 }

 const chooseFile = async () => {
  const path = await open({ multiple: false, filters: [{ name: 'Субтитры', extensions: ['srt', 'vtt', 'ass', 'ssa'] }] })
  if (typeof path === 'string') start({ kind: 'file', path })
 }

 const data = q.data
 const idle = busy !== null || pending !== null

 return (
  <div
   className="fixed inset-0 z-[185] flex items-center justify-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_55%,transparent)]"
   onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}
  >
   <div
    role="dialog"
    aria-label="Субтитры"
    className="md-pop flex max-h-[90vh] w-[560px] max-w-[96vw] flex-col bg-[var(--md-sys-color-surface-container-high)]"
    style={{ borderRadius: 'var(--md-sys-shape-corner-extra-large)' }}
   >
    <div className="flex items-start justify-between gap-2 px-6 pt-5 pb-2">
     <div className="min-w-0">
      <h2 className="type-headline-small">Субтитры</h2>
      {data && <p className={`${HINT} truncate`}>{data.activeLabel ? `Сейчас: ${data.activeLabel}` : 'Субтитры не выбраны'}</p>}
     </div>
     <IconButton icon="close" label="Закрыть" onClick={onClose} />
    </div>

    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-1">
     {q.isPending && <p className={HINT}>Ищу варианты…</p>}
     {q.error && (
      <div className="flex items-center gap-3">
       <p className={`${HINT} min-w-0 flex-1 text-[var(--md-sys-color-error)]`}>{errorText(q.error)}</p>
       <button type="button" className={TEXT_BUTTON} onClick={() => void q.refetch()}>Повторить</button>
      </div>
     )}
     {data &&
      GROUPS.map(([id, label]) => {
       const items = data.items.filter((i) => i.candidate.source === id)
       const notes = data.notes.filter((n) => n.source === id)
       if (items.length === 0 && notes.length === 0) return null
       return (
        <section key={id} className="flex flex-col gap-1">
         <h3 className="type-title-small">{label}</h3>
         {id === 'opensubtitles' && <p className={HINT}>Скачивание тратит дневной лимит OpenSubtitles</p>}
         <div role="radiogroup" aria-label={label} className="flex flex-col">
          {items.map((it) => {
           const current = it.key === data.activeKey
           return (
            <button
             key={it.key}
             type="button"
             role="radio"
             aria-checked={current}
             disabled={current || idle}
             onClick={() => start({ kind: 'candidate', key: it.key, candidate: it.candidate })}
             className={`state-layer state-on-surface type-label-large relative flex w-full items-start gap-3 rounded-[var(--md-sys-shape-corner-small)] px-3 py-2 text-left disabled:opacity-40 ${current ? 'bg-[var(--md-sys-color-secondary-container)]' : ''}`}
            >
             <span className="mt-0.5 flex shrink-0 text-[var(--md-sys-color-primary)]">
              <Icon name={current ? 'radio_button_checked' : 'radio_button_unchecked'} size={20} />
             </span>
             <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{busy === it.key ? 'Загружаю…' : title(it.candidate)}</span>
              {itemHint(it.candidate) && <span className={HINT}>{itemHint(it.candidate)}</span>}
             </span>
            </button>
           )
          })}
         </div>
         {notes.map((n) => <p key={n.message} className={HINT}>{n.message}</p>)}
        </section>
       )
      })}
    </div>

    <div className="flex flex-col gap-2 px-6 pt-2 pb-4">
     {pending && (
      <div className="flex flex-col gap-1 rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-error-container)] px-4 py-3 text-[var(--md-sys-color-on-error-container)]">
       <p className="type-body-medium">Разбор диалогов этого фильма будет удалён, новый придётся запускать заново.</p>
       <div className="flex items-center justify-end gap-2">
        <button type="button" className={TEXT_BUTTON} onClick={() => setPending(null)}>Отмена</button>
        <button type="button" className={PRIMARY} onClick={() => void execute(pending)}>Сменить субтитры</button>
       </div>
      </div>
     )}
     <div className="flex items-center justify-between gap-2">
      <button type="button" className={TEXT_BUTTON} disabled={idle} onClick={() => void chooseFile()}>Загрузить файл…</button>
      <button type="button" className={PRIMARY} onClick={onClose}>Закрыть</button>
     </div>
    </div>
   </div>
  </div>
 )
}
