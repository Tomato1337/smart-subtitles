import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { SessionState } from '@/common/types/ipc'
import { usePlayer, usePlaybackStore } from '@/modules/Player'
import { lastStartedBefore, type SubsSnapshot, useSubsStore } from '@/modules/Subtitles'

/** Cues per analysis batch; mirrors `annotate::BATCH` in the backend. */
const BATCH = 40

/** True when the batch starting at `first` is finished or written off (a failed batch is retried by hand). */
function batchDone(subs: SubsSnapshot, first: number): boolean {
 if (subs.failedBatches.has(first)) return true
 for (const idx of subs.annotations.keys()) if (idx >= first && idx < first + BATCH) return true
 return false
}

/**
 * Whether the two batches at the resume point are analyzed: the film can start right away,
 * the rest keeps being analyzed in the background.
 */
export function headReady(session: SessionState, subs: SubsSnapshot): boolean {
 const { cues } = subs
 if (cues.length === 0) return false
 const i = Math.max(lastStartedBefore(cues, session.resumeAt, subs.offset), 0)
 const b = Math.floor(i / BATCH) * BATCH
 return [b, b + BATCH].filter((f) => f < cues.length).every((f) => batchDone(subs, f))
}

type Props = {
 session: SessionState
 open: 'ask' | 'wait' | null
 /** Play the film once the dialog closes (the user asked for analysis and the head is ready). */
 resumeOnClose: boolean
 onOpenChange: (s: 'ask' | 'wait' | null) => void
}

/**
 * Consent dialog before the first analysis of a film: token estimate, optional price from the model,
 * "analyze" / "watch without analysis". Then a short wait screen until the resume point is analyzed.
 */
export function AnnotGate({ session, open, resumeOnClose, onOpenChange }: Props) {
 const p = usePlayer()
 const subs = useSubsStore()
 const playing = usePlaybackStore((s) => s.playing)
 const annot = subs.annot

 // The modal owns the film while it is up: the player's own autoplay is undone on every attempt.
 useEffect(() => {
  if (open !== null && playing) p.pause()
 }, [open, playing, p])

 const wasOpen = useRef<typeof open>(null)
 useEffect(() => {
  if (wasOpen.current !== null && open === null && resumeOnClose) p.play()
  wasOpen.current = open
 }, [open, resumeOnClose, p])

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

 const estimate = useQuery({
  queryKey: ['annotEstimate', session.mediaId, annot?.done, subs.cues.length],
  queryFn: () => api.annotEstimate(session.mediaId),
  enabled: open === 'ask',
 })
 // Which model the "remember" button would pin the consent to.
 const model = useQuery({ queryKey: ['annotModel'], queryFn: api.annotModel, enabled: open === 'ask' })
 const cost = useMutation({ mutationFn: () => api.annotCost(session.mediaId) })
 const [busy, setBusy] = useState(false)

 const decide = async (on: boolean, remember = false) => {
  setBusy(true)
  try {
   await api.annotSet(session.mediaId, on, remember)
   onOpenChange(on ? 'wait' : null)
  } catch (e) {
   notify('error', errorText(e))
  } finally {
   setBusy(false)
  }
 }

 const ready = headReady(session, subs)
 useEffect(() => {
  if (open !== 'wait') return
  if (ready || (annot && annot.done + annot.failed >= annot.total)) onOpenChange(null)
 }, [open, ready, annot, onOpenChange])

 const outlined = 'state-layer state-on-surface type-label-large relative rounded-full border border-[var(--md-sys-color-outline)] px-5 py-2'
 const filled = 'state-layer state-on-primary type-label-large relative rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)]'
 const e = estimate.data
 const c = cost.data

 if (open === null) return null

 return (
  <div className="fixed inset-0 z-[180] flex items-center justify-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_50%,transparent)]">
   <div
    ref={overlay}
    role="dialog"
    aria-modal="true"
    aria-labelledby="annot-gate-title"
    className="md-pop flex max-h-[85vh] w-[520px] max-w-[95vw] flex-col gap-4 overflow-y-auto bg-[var(--md-sys-color-surface-container-high)] p-6"
    style={{ borderRadius: 'var(--md-sys-shape-corner-extra-large)', userSelect: 'text' }}
   >
    {open === 'ask' ? (
     <>
      <h2 id="annot-gate-title" className="type-headline-small">Разбор диалогов</h2>
      {estimate.isPending && (
       <div className="flex items-center gap-4">
        <span className="md-spinner" aria-hidden="true" style={{ width: 28, height: 28, borderWidth: 3 }} />
        <span className="type-body-medium">Считаю объём…</span>
       </div>
      )}
      {estimate.isError && <p className="type-body-medium text-[var(--md-sys-color-error)]">{errorText(estimate.error)}</p>}
      {e && (
       <div className="flex flex-col gap-1">
        <p className="type-body-medium">Осталось разобрать {e.cues.toLocaleString('ru-RU')} реплик ({e.batches.toLocaleString('ru-RU')} запросов).</p>
        <p className="type-body-medium">Входные токены ≈ {e.inputTokens.toLocaleString('ru-RU')}, из них ≈ {e.cachedTokens.toLocaleString('ru-RU')} могут читаться из кэша провайдера.</p>
        <p className="type-body-medium">Выходные токены ≈ {e.outputTokens.toLocaleString('ru-RU')}.</p>
        {e.partial && <p className="type-body-medium">Субтитры ещё загружаются — оценка пересчитана на весь фильм.</p>}
        <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Оценка без запроса к модели, точность ±15%.</p>
        {model.data && <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Модель разбора: {model.data.key}</p>}
       </div>
      )}
      <div className="flex flex-col gap-2">
       <button
        type="button"
        disabled={!e || cost.isPending}
        onClick={() => cost.mutate()}
        className="state-layer state-on-surface type-label-large relative flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-[var(--md-sys-color-primary)] disabled:opacity-50"
       >
        {cost.isPending && <span className="md-spinner" aria-hidden="true" style={{ width: 16, height: 16, borderWidth: 2 }} />}
        Рассчитать стоимость
       </button>
       {cost.isError && <p className="type-body-medium text-[var(--md-sys-color-error)]">{errorText(cost.error)}</p>}
       {c && (
        <div className="flex flex-col gap-1">
         {c.usd !== null && <p className="type-title-medium">≈ ${c.usd.toFixed(2)}</p>}
         {c.inputPrice !== null && c.cachedPrice !== null && c.outputPrice !== null && (
          <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
           вход ${c.inputPrice} · кэш ${c.cachedPrice} · выход ${c.outputPrice} за 1M
          </p>
         )}
         {c.note && <p className="type-body-small">{c.note}</p>}
         {c.source === 'llm' && (
          <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
           Оценка модели {c.model}, может быть неточной
          </p>
         )}
        </div>
       )}
      </div>
      <div className="flex justify-end gap-2">
       <button type="button" data-autofocus disabled={busy} className={outlined} onClick={() => void decide(false)}>
        Смотреть без разбора
       </button>
       <button type="button" disabled={busy || !model.data} className={outlined} onClick={() => void decide(true, true)}>
        Запомнить для этой модели
       </button>
       <button type="button" disabled={busy} className={filled} onClick={() => void decide(true)}>
        Разобрать
       </button>
      </div>
     </>
    ) : (
     <>
      <h2 id="annot-gate-title" className="type-headline-small">Готовлю начало просмотра</h2>
      <div className="flex items-center gap-4">
       <span className="md-spinner" aria-hidden="true" />
       <span className="type-body-medium">
        Разобрано {annot?.done ?? 0} из {annot?.total ?? 0} частей. Остальное доразберётся в фоне.
       </span>
      </div>
      <div className="flex justify-end">
       <button type="button" data-autofocus className={outlined} onClick={() => onOpenChange(null)}>
        Пропустить
       </button>
      </div>
     </>
    )}
   </div>
  </div>
 )
}
