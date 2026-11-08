import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Dialog, Presence, Spinner, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { CardJobEditor, CardPreview as CardPreviewData, WordDraft } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { lookupSpan, useAnkiStore } from '@/modules/Anki'
import { adoptImageDraft, editorView, textFieldRows } from '../lib/editor'
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

type Props = { editor: CardJobEditor }

function PreviewPane({ preview, error, loading }: { preview: CardPreviewData | null; error: string | null; loading: boolean }) {
  if (preview) return <CardPreview preview={preview} />
  if (error) return <p className="type-body-medium text-[var(--md-sys-color-error)]">{error}</p>
  if (loading) return <Spinner label="Загружаю предпросмотр" className="m-6" />
  return <p className="type-body-medium py-6 text-[var(--md-sys-color-on-surface-variant)]">Превью пока недоступно.</p>
}

function EditorDialog({ editor }: Props) {
  const closeEditor = useCardsStore((s) => s.closeEditor)
  const setEditor = useCardsStore((s) => s.setEditor)
  const upsert = useCardsStore((s) => s.upsert)
  const trackTask = useCardsStore((s) => s.trackTask)
  // The live row: events may advance its revision (image, save) while the dialog is open.
  const live = useCardsStore((s) => s.jobs[editor.job.id])
  const job = live && live.version >= editor.job.version ? live : editor.job
  const added = job.hasCommittedNote
  const [draft, setDraft] = useState<WordDraft | null>(editor.job.draft)
  const [fields, setFields] = useState<Record<string, string> | null>(editor.fieldValues)
  const [previewData, setPreviewData] = useState<CardPreviewData | null>(editor.preview)
  const baseline = useRef<Record<string, string> | null>(editor.baselineFields)
  const draftWasReady = useRef(editor.job.draft !== null)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = editorView(added, draft)

  // Drafts and fields that arrive later fill an empty form once; a dirty local form is never replaced.
  useEffect(() => {
    if (draft === null && job.draft) setDraft(job.draft)
  }, [draft, job.draft])
  useEffect(() => {
    if (fields === null && editor.fieldValues) setFields(editor.fieldValues)
  }, [fields, editor.fieldValues])
  useEffect(() => {
    if (baseline.current === null && editor.baselineFields) baseline.current = editor.baselineFields
  }, [editor.baselineFields])
  useEffect(() => {
    if (editor.preview) setPreviewData(editor.preview)
  }, [editor.preview])

  // The opening command returns no preview while the draft is still being made. Load the editor
  // snapshot exactly once when that draft appears; a progress event must never refresh a baseline.
  useEffect(() => {
    if (draftWasReady.current || !job.draft || added) return
    draftWasReady.current = true
    api
      .cardsJobEdit(job.id, false)
      .then((next) => {
        // The dialog may have been closed while the snapshot was loading: never reopen it.
        if (useCardsStore.getState().editorJobId !== job.id) return
        setEditor(next)
        if (next.preview) setPreviewData(next.preview)
        if (next.fieldValues) setFields((current) => current ?? next.fieldValues)
      })
      .catch((e) => {
        if (useCardsStore.getState().editorJobId === job.id) setError(errorText(e))
      })
  }, [added, job.draft, job.id, setEditor])

  const debouncedDraft = useDebounced(draft, 350)
  const debouncedFields = useDebounced(fields, 350)
  const preview = useQuery({
    queryKey: ['job-preview', job.id, job.revision, added, added ? debouncedFields : debouncedDraft],
    queryFn: () => api.cardsJobPreview(job.id, job.revision, debouncedDraft!, added ? debouncedFields : null),
    // Read-only, revision-bound and debounced: opening or focusing the dialog never mutates the job.
    enabled: !!debouncedDraft && (!added || !!debouncedFields),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const shownPreview = preview.data ?? previewData

  const index = useAnkiStore((s) => s.index)
  const cards = useAnkiStore((s) => s.cards)
  const dup = view === 'draft' && draft ? lookupSpan(draft.word, index, cards) : null

  const generate = async () => {
    if (!draft || generating || busy) return
    const prompt = draft.image_prompt
    const latest = useCardsStore.getState().jobs[job.id] ?? job
    setGenerating(true)
    setError(null)
    try {
      const next = await api.cardsJobImage(job.id, latest.revision, prompt)
      upsert(next.job)
      // Closing the dialog during generation must not reopen it or touch its local form.
      const open = useCardsStore.getState().editorJobId === job.id
      if (!open) return
      setEditor(next)
      // Adopt the returned revision and prompt but keep every other local edit.
      setDraft((current) => adoptImageDraft(current, next.job.draft, prompt))
      if (next.preview) setPreviewData(next.preview)
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setGenerating(false)
    }
  }

  const save = async () => {
    if (busy || generating) return
    if (!draft) {
      setError('Черновик ещё не готов')
      return
    }
    if (!draft.word.trim()) {
      setError('Слово не может быть пустым')
      return
    }
    if (!draft.cloze_sentence.includes('{{c1::')) {
      setError('В cloze должно быть {{c1::…}}')
      return
    }
    if (view === 'added' && !fields) {
      setError('Не удалось прочитать поля карточки. Откройте её снова.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const latest = useCardsStore.getState().jobs[job.id] ?? job
      const saved = await api.cardsJobSave(
        job.id,
        latest.revision,
        draft,
        view === 'added' ? fields : null,
        view === 'added' ? baseline.current : null,
      )
      upsert(saved)
      closeEditor()
      if (saved.state === 'added') {
        if (!useCardsStore.getState().task) {
          toast(`«${saved.word}» сохранено в Anki`, { icon: 'save' })
        }
      } else {
        // A queued save or a sent update keeps running; its toast follows the durable job.
        trackTask(saved)
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy || generating) return
    setBusy(true)
    setError(null)
    try {
      const done = await api.cardsJobDelete(job.id)
      upsert(done)
      closeEditor()
      trackTask(done)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (busy || generating) return
    setBusy(true)
    setError(null)
    try {
      const latest = useCardsStore.getState().jobs[job.id] ?? job
      const done = await api.cardsJobCancel(job.id, latest.revision)
      upsert(done)
      if (done.state === 'cancelled' || done.state === 'cancel_requested' || done.state === 'resolving' || done.state === 'deleted') {
        closeEditor()
        trackTask(done)
      } else {
        setError(done.error ?? 'Отмена ещё не подтверждена Anki')
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const rows = view === 'added' ? textFieldRows(shownPreview, fields) : []
  const mediaOnly = view === 'added' && !!fields && !!shownPreview && rows.length === 0

  return (
    <Dialog
      onClose={closeEditor}
      dismissible
      aria-labelledby="card-editor-title"
      className="max-h-[90vh] w-[1040px] max-w-[95vw]"
      style={{ userSelect: 'text' }}
    >
      <h2 id="card-editor-title" className="type-headline-small mb-1">{added ? 'Карточка в Anki' : 'Новая карточка'}</h2>
      <p className="type-body-small mb-4 text-[var(--md-sys-color-on-surface-variant)]">
        {job.title}{job.cueText ? ` · ${job.cueText.replace(/\s+/g, ' ').trim()}` : ''}
      </p>
      {view === 'loading' ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 py-8">
            <Spinner size={32} width={3} />
            <span className="type-body-medium">Составляю карточку…</span>
          </div>
          {job.error && <p className="type-body-small text-[var(--md-sys-color-error)]">{job.error}</p>}
          {error && <p className="type-body-small text-[var(--md-sys-color-error)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeEditor} className="state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]">Закрыть</button>
            <button type="button" disabled={busy} onClick={() => void cancel()} className="state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-error)] disabled:opacity-50">Отменить добавление</button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-h-0 flex-col">
            <div className="flex flex-col gap-3 overflow-y-auto">
              {view === 'added' ? (
                <>
                  {rows.length === 0 && (preview.isFetching ? (
                    <p className="type-body-medium">Загружаю поля карточки…</p>
                  ) : mediaOnly ? (
                    <p className="type-body-medium">В этой заметке нет текстовых полей для правки.</p>
                  ) : (
                    <p className="type-body-medium text-[var(--md-sys-color-error)]">
                      Не удалось загрузить поля карточки. Закройте и откройте её снова.
                    </p>
                  ))}
                  {rows.map(({ field, value }) => (
                    <label key={field} className="flex flex-col gap-1">
                      <span className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">{field}</span>
                      <textarea
                        rows={field.toLowerCase().includes('cloze') || field.toLowerCase().includes('sentence') ? 2 : 1}
                        value={value}
                        onChange={(e) => setFields((current) => (current ? { ...current, [field]: e.target.value } : current))}
                        className="type-body-medium resize-none rounded-[var(--md-sys-shape-corner-small)] border border-[var(--md-sys-color-outline)] bg-transparent px-3 py-2 outline-hidden focus:border-[var(--md-sys-color-primary)] focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                      />
                    </label>
                  ))}
                  <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                    Медиа-поля показаны в предпросмотре и не редактируются.
                  </p>
                  <label className="flex flex-col gap-1">
                    <span className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">Картинка (промпт)</span>
                    <textarea
                      rows={2}
                      value={draft?.image_prompt ?? ''}
                      disabled={!draft}
                      onChange={(e) => setDraft((current) => (current ? { ...current, image_prompt: e.target.value } : current))}
                      className="type-body-medium resize-none rounded-[var(--md-sys-shape-corner-small)] border border-[var(--md-sys-color-outline)] bg-transparent px-3 py-2 outline-hidden focus:border-[var(--md-sys-color-primary)] focus:ring-1 focus:ring-[var(--md-sys-color-primary)] disabled:opacity-50"
                    />
                    <button
                      type="button"
                      disabled={generating || busy || !draft}
                      onClick={() => void generate()}
                      className="state-layer type-label-large relative mt-1 flex items-center gap-2 self-start rounded-full bg-[var(--md-sys-color-secondary-container)] px-4 py-1.5 text-[var(--md-sys-color-on-secondary-container)] disabled:opacity-50"
                    >
                      {generating && <Spinner size={16} width={2} />}
                      {generating ? 'Генерирую картинку…' : 'Сгенерировать картинку'}
                    </button>
                  </label>
                </>
              ) : (
                <>
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
                        value={draft?.[k] ?? ''}
                        onChange={(e) => setDraft((current) => (current ? { ...current, [k]: e.target.value } : current))}
                        className="type-body-medium resize-none rounded-[var(--md-sys-shape-corner-small)] border border-[var(--md-sys-color-outline)] bg-transparent px-3 py-2 outline-hidden focus:border-[var(--md-sys-color-primary)] focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                      />
                      {k === 'image_prompt' && (
                        <button
                          type="button"
                          disabled={generating || busy || !draft}
                          onClick={() => void generate()}
                          className="state-layer type-label-large relative mt-1 flex items-center gap-2 self-start rounded-full bg-[var(--md-sys-color-secondary-container)] px-4 py-1.5 text-[var(--md-sys-color-on-secondary-container)] disabled:opacity-50"
                        >
                          {generating && <Spinner size={16} width={2} />}
                          {generating ? 'Генерирую картинку…' : 'Сгенерировать картинку'}
                        </button>
                      )}
                    </label>
                  ))}
                </>
              )}
              {job.error && <p className="type-body-small text-[var(--md-sys-color-error)]">{job.error}</p>}
              {error && <p className="type-body-small text-[var(--md-sys-color-error)]">{error}</p>}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={closeEditor} className="state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]">Закрыть</button>
              {view === 'added' ? (
                <button type="button" disabled={busy || generating} onClick={() => void remove()} className="state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-error)] disabled:opacity-50">Удалить из Anki</button>
              ) : (
                <button type="button" disabled={busy || generating} onClick={() => void cancel()} className="state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-error)] disabled:opacity-50">Отменить добавление</button>
              )}
              <button type="button" disabled={busy || generating || !draft || (view === 'added' && !fields)} onClick={() => void save()} className="state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-6 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-50">
                {busy && <Spinner size={16} width={2} />}
                {view === 'added' ? 'Сохранить изменения' : 'Сохранить и добавить'}
              </button>
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto">
            <PreviewPane
              preview={shownPreview}
              error={preview.error ? errorText(preview.error) : null}
              loading={preview.isFetching}
            />
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** MD3 dialog for one durable card job: edit the draft before the add, or the actual fields after it. */
export function CardDraftModal() {
  const editor = useCardsStore((s) => s.editor)
  return <Presence>{editor && <EditorDialog key={editor.job.id} editor={editor} />}</Presence>
}
