import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { WordDraft } from '@/common/types/ipc'
import { toast } from '@/common/ui/toast'
import { useDebounced } from '@/common/utilities/useDebounced'
import { lookupSpan, useAnkiStore } from '@/modules/Anki'
import { useCardsStore } from '../store/cardsStore'
import { CardPreview } from './CardPreview'

const FIELDS: [keyof WordDraft, string][] = [
  ['word', 'Слово или фраза'],
  ['translation', 'Перевод'],
  ['word_type', 'Тип'],
  ['cloze_sentence', 'Cloze (с {{c1::…}})'],
  ['full_sentence', 'Предложение'],
  ['sentence_translation', 'Перевод предложения'],
  ['image_prompt', 'Картинка (промпт)'],
]

/** Same subject the backend uses when the draft has no prompt of its own. */
function imageSubject(d: WordDraft): string {
  return d.image_prompt.trim() || `A scene that shows the meaning of "${d.word}" as in: ${d.full_sentence}`
}

function Form({ mediaId, cueIdx, initial, onDone }: { mediaId: string; cueIdx: number; initial: WordDraft; onDone: () => void }) {
  const [d, setD] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const index = useAnkiStore((s) => s.index)
  const cards = useAnkiStore((s) => s.cards)
  const qc = useQueryClient()
  const dup = lookupSpan(d.word, index, cards)
  const config = useQuery({ queryKey: ['config'], queryFn: api.configGet })
  const debounced = useDebounced(d, 300)
  const preview = useQuery({
    queryKey: ['card-preview', mediaId, cueIdx, debounced],
    queryFn: () => api.cardsPreview(null, debounced, mediaId, cueIdx),
    retry: false,
  })
  // Nothing to generate with when the app's backend is «none» and tutor does not own the images.
  const canGenerate = (config.data?.images.backend ?? 'none') !== 'none'
    || (config.data?.tutor.enabled === true && config.data.tutor.useImageSettings)

  // The add runs in the background (clip, image, Anki); only a failure to queue keeps the dialog open.
  const add = async () => {
    if (!d.cloze_sentence.includes('{{c1::')) { notify('warn', 'В cloze должно быть {{c1::…}}'); return }
    setBusy(true)
    setQueueError(null)
    try {
      const id = await api.cardsCreateProposal(mediaId, cueIdx, [d])
      await api.cardsAdd(id, [0])
      void qc.invalidateQueries({ queryKey: ['agent', mediaId] })
      onDone()
    } catch (e) {
      const msg = errorText(e)
      setQueueError(msg)
      notify('error', msg)
      setBusy(false)
    }
  }

  const generate = async () => {
    setGenerating(true)
    try {
      await api.imagesGenerate(imageSubject(d), null)
      // The picture is cached now: the preview picks it up, and the add reuses the same file.
      void qc.invalidateQueries({ queryKey: ['card-preview'] })
    } catch (e) {
      toast(errorText(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-h-0 flex-col">
        <div className="flex flex-col gap-3 overflow-y-auto">
          {dup && (
            <div className="type-body-small rounded-[var(--md-sys-shape-corner-small)] px-3 py-2" style={{ background: 'var(--app-anki-label-container)', color: 'var(--app-anki-on-label-container)' }}>
              Уже есть в Anki: {dup.translation || dup.word}
            </div>
          )}
          {FIELDS.map(([k, label]) => (
            <label key={k} className="flex flex-col gap-1">
              <span className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">{label}</span>
              <textarea
                rows={k === 'cloze_sentence' || k === 'full_sentence' || k === 'image_prompt' ? 2 : 1}
                value={d[k]}
                onChange={(e) => setD({ ...d, [k]: e.target.value })}
                className="type-body-medium resize-none rounded-[var(--md-sys-shape-corner-small)] border border-[var(--md-sys-color-outline)] bg-transparent px-3 py-2 outline-none focus:border-[var(--md-sys-color-primary)]"
                style={{ userSelect: 'text' }}
              />
              {k === 'image_prompt' && canGenerate && (
                <button
                  type="button"
                  disabled={generating}
                  onClick={() => void generate()}
                  className="state-layer type-label-large relative mt-1 flex items-center gap-2 self-start rounded-full bg-[var(--md-sys-color-secondary-container)] px-4 py-1.5 text-[var(--md-sys-color-on-secondary-container)] disabled:opacity-50"
                >
                  {generating && <span className="md-spinner !size-4" />}
                  {generating ? 'Генерирую картинку…' : 'Сгенерировать картинку'}
                </button>
              )}
            </label>
          ))}
          {queueError && <p className="type-body-small text-[var(--md-sys-color-error)]">{queueError}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onDone} className="state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]">Отмена</button>
          <button type="button" disabled={busy} onClick={() => void add()} className="state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-6 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-50">
            {busy && <span className="md-spinner !size-4" />}
            {busy ? 'Добавляю…' : 'Добавить'}
          </button>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {preview.error ? (
          <p className="type-body-medium text-[var(--md-sys-color-error)]">{errorText(preview.error)}</p>
        ) : preview.data ? (
          <CardPreview preview={preview.data} />
        ) : (
          <div className="md-spinner m-6" />
        )}
      </div>
    </div>
  )
}

/** MD3 dialog: LLM-made flashcard draft the learner can edit before it goes to Anki. */
export function CardDraftModal({ mediaId }: { mediaId: string }) {
  const { draft, closeDraft } = useCardsStore()
  const q = useQuery({
    queryKey: ['draft', mediaId, draft?.cueIdx, draft?.span],
    queryFn: () => api.cardsDraft(mediaId, draft!.cueIdx, draft!.span),
    enabled: !!draft,
    gcTime: 0,
    staleTime: 0,
  })
  if (!draft) return null
  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_50%,transparent)]" onPointerDown={(e) => { if (e.target === e.currentTarget) closeDraft() }}>
      <div role="dialog" aria-label="Карточка Anki" className="md-pop flex max-h-[90vh] w-[1040px] max-w-[95vw] flex-col bg-[var(--md-sys-color-surface-container-high)] p-6" style={{ borderRadius: 'var(--md-sys-shape-corner-extra-large)', userSelect: 'text' }}>
        <h2 className="type-headline-small mb-4">Карточка в Anki</h2>
        {q.isLoading && <div className="flex items-center gap-3 py-8"><div className="md-spinner !size-8" /><span className="type-body-medium">Составляю карточку…</span></div>}
        {q.isError && (
          <>
            <p className="type-body-medium text-[var(--md-sys-color-error)]">{errorText(q.error)}</p>
            <div className="mt-4 flex justify-end"><button type="button" onClick={closeDraft} className="type-label-large rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]">Закрыть</button></div>
          </>
        )}
        {q.data && <Form key={`${draft.cueIdx}|${draft.span}`} mediaId={mediaId} cueIdx={draft.cueIdx} initial={q.data} onDone={closeDraft} />}
      </div>
    </div>
  )
}
