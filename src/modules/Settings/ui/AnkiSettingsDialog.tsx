import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { Chip, Dialog, IconButton, Spinner, Switch, toast } from '@tomato1337/m3e-react'
import { api, errorText, onEvent } from '@/common/api/tauri'
import type { AppConfig, CardSource } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { autoSource, CardPreview, SOURCE_LABELS } from '@/modules/Cards'
import { Field, Text, inputClass } from './SettingsPanel'
import { ImageFields } from './ImageFields'

const BUILTIN = 'Smart Subtitles — Vocab'
/** Tutor's own note type: picked automatically when the add-on is switched on. */
const TUTOR_NOTE_TYPE = 'EF Tutor — Vocab'

const PRIMARY =
  'state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-40'
const TONAL =
  'state-layer type-label-large relative shrink-0 rounded-full bg-[var(--md-sys-color-secondary-container)] px-4 py-1.5 text-[var(--md-sys-color-on-secondary-container)] disabled:opacity-40'
const TEXT_BUTTON = 'state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]'
const HINT = 'type-body-small text-[var(--md-sys-color-on-surface-variant)]'

type Apply = <S extends keyof AppConfig>(section: S, patch: Partial<AppConfig[S]>) => void

/** A titled block of the left column. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container-low)] p-4">
      <h3 className="type-title-small">{title}</h3>
      {children}
    </section>
  )
}

export type AnkiSettingsDialogProps = {
  /** The settings panel's draft: the dialog edits it, so there is one save path. */
  cfg: AppConfig
  set: Apply
  onSave: () => void
  dirty: boolean
  saving: boolean
  onClose: () => void
}

/**
 * Every Anki setting in one place: connection, deck, note type, field mapping, tags, audio, the
 * known-words index, images and the optional tutor. The card preview on the right follows the draft.
 */
export function AnkiSettingsDialog({ cfg, set, onSave, dirty, saving, onClose }: AnkiSettingsDialogProps) {
  const qc = useQueryClient()
  const catalog = useQuery({ queryKey: ['anki-catalog'], queryFn: api.ankiCatalog, retry: false, staleTime: 30_000 })
  const noteType = useQuery({
    queryKey: ['anki-note-type', cfg.anki.noteType],
    queryFn: () => api.ankiNoteType(cfg.anki.noteType),
    retry: false,
  })
  const models = useQuery({ queryKey: ['anki-index-models'], queryFn: api.ankiIndexModels })
  const debounced = useDebounced(cfg.anki, 300)
  const preview = useQuery({
    queryKey: ['card-preview', debounced],
    queryFn: () => api.cardsPreview(debounced, null, null, null),
    retry: false,
  })
  const deps = useQuery({ queryKey: ['deps'], queryFn: api.depsCheck, staleTime: Infinity })
  const uvMissing = deps.data?.deps.some((d) => d.id === 'uv' && !d.found) ?? false

  // The index models come from the last Anki refresh, which runs after every saved deck change.
  useEffect(() => {
    const un = onEvent('anki:index', () => { void qc.invalidateQueries({ queryKey: ['anki-index-models'] }) })
    return () => { void un.then((f) => f()) }
  }, [qc])

  const allDecks = cfg.anki.indexDecks.includes('*')
  const deckList = catalog.data?.decks ?? []
  const typeList = catalog.data?.noteTypes ?? []
  const fields = noteType.data?.fields ?? []
  const tutorOwnsImages = cfg.tutor.enabled && cfg.tutor.useImageSettings

  // Mirrors the field rows: a saved source wins over the name guess.
  const clipFieldMapped = fields.some((f) => ((cfg.anki.fields[f] ?? autoSource(f) ?? '') as CardSource) === 'clip')
  const setField = (field: string, source: CardSource) =>
    set('anki', { fields: { ...cfg.anki.fields, [field]: source } })
  const resetFields = () => {
    const next = { ...cfg.anki.fields }
    for (const f of fields) delete next[f]
    set('anki', { fields: next })
  }
  const setIndexField = (model: string, patch: { word?: string; translation?: string }) => {
    const current = cfg.anki.indexFields[model] ?? { word: '', translation: '' }
    set('anki', { indexFields: { ...cfg.anki.indexFields, [model]: { ...current, ...patch } } })
  }
  const toggleDeck = (name: string, on: boolean) => {
    const rest = cfg.anki.indexDecks.filter((d) => d !== '*')
    set('anki', { indexDecks: on ? [...rest, name] : rest.filter((d) => d !== name) })
  }
  const setTutorEnabled = (enabled: boolean) => {
    set('tutor', { enabled })
    const hasTutorType = typeList.some((t) => t.name === TUTOR_NOTE_TYPE)
    if (enabled && hasTutorType && cfg.anki.noteType !== TUTOR_NOTE_TYPE) {
      set('anki', { noteType: TUTOR_NOTE_TYPE })
      toast(`Тип заметки переключён на ${TUTOR_NOTE_TYPE}`)
    }
  }

  return (
    <Dialog onClose={onClose} dismissible aria-labelledby="anki-settings-title" className="max-h-[92vh] w-[1100px] max-w-[96vw] p-0">
      <div className="flex items-center justify-between px-6 pt-5 pb-2">
        <h2 id="anki-settings-title" className="type-headline-small">Anki и карточки</h2>
        <IconButton icon="close" label="Закрыть" onClick={onClose} />
      </div>

      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden px-6 pb-4 lg:grid-cols-[minmax(0,1fr)_460px]">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <Group title="Подключение">
            <Field label="Адрес AnkiConnect">
              <Text value={cfg.anki.url} onChange={(url) => set('anki', { url })} placeholder="http://127.0.0.1:8765" />
            </Field>
            <div className="flex items-center gap-2">
              <span className={`type-body-small ${catalog.error ? 'text-[var(--md-sys-color-error)]' : HINT}`}>
                {catalog.isFetching
                  ? 'Спрашиваю Anki…'
                  : catalog.error
                    ? errorText(catalog.error)
                    : `Anki отвечает: колод ${catalog.data?.decks.length ?? 0}, типов заметок ${catalog.data?.noteTypes.length ?? 0}`}
              </span>
              <button type="button" className={`${TONAL} ml-auto`} onClick={() => void catalog.refetch()}>Обновить</button>
            </div>
          </Group>

          <Group title="Колода и тип заметки">
            <Field label="Колода" hint="Новая колода будет создана при первой карточке">
              <input
                list="anki-decks"
                value={cfg.anki.deck}
                onChange={(e) => set('anki', { deck: e.target.value })}
                className={inputClass}
                spellCheck={false}
              />
              <datalist id="anki-decks">
                {deckList.map((d) => (
                  <option key={d.name} value={d.name}>{`${d.cards} карточек`}</option>
                ))}
              </datalist>
            </Field>
            <Field label="Тип заметки">
              <select className={inputClass} value={cfg.anki.noteType} onChange={(e) => set('anki', { noteType: e.target.value })}>
                <option value={BUILTIN}>{`${BUILTIN} (встроенный)`}</option>
                {typeList.filter((t) => t.name !== BUILTIN).map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
                {!!cfg.anki.noteType && cfg.anki.noteType !== BUILTIN && !typeList.some((t) => t.name === cfg.anki.noteType) && (
                  <option value={cfg.anki.noteType}>{cfg.anki.noteType}</option>
                )}
              </select>
            </Field>
          </Group>

          <Group title="Поля карточки">
            {noteType.isPending && <Spinner label="Загружаю поля" size={20} width={2} />}
            {noteType.error && <p className={HINT}>{errorText(noteType.error)}</p>}
            {fields.map((f) => {
              const value = (cfg.anki.fields[f] ?? autoSource(f) ?? '') as CardSource
              return (
                <div key={f} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                  <span className="type-body-medium truncate" title={f}>{f}</span>
                  <select className={inputClass} value={value} onChange={(e) => setField(f, e.target.value as CardSource)}>
                    {SOURCE_LABELS.map(([id, label]) => (
                      <option key={id || 'none'} value={id}>{label}</option>
                    ))}
                    {!!value && !SOURCE_LABELS.some(([id]) => id === value) && <option value={value}>{value}</option>}
                  </select>
                </div>
              )
            })}
            {fields.length > 0 && (
              <div>
                <button type="button" className={TONAL} onClick={resetFields}>Сбросить к авто</button>
              </div>
            )}
          </Group>

          <Group title="Теги">
            <Field label="Теги карточки" hint="{film} — название фильма">
              <Text value={cfg.anki.tags} onChange={(tags) => set('anki', { tags })} />
            </Field>
          </Group>

          <Group title="Видео">
            <Switch
              label="Клип из фильма в карточке"
              checked={cfg.anki.clip}
              onChange={(clip) => set('anki', { clip })}
            />
            <p className={HINT}>
              Выключено — клип не вырезается, поля «Клип», «Текст клипа» и «Источник клипа» остаются пустыми.
            </p>
            {cfg.anki.clip && !clipFieldMapped && (
              <p className={HINT}>Ни одно поле не получает клип — выберите «Клип из фильма» в разделе «Поля карточки».</p>
            )}
          </Group>

          <Group title="Озвучка">
            <Switch label="Озвучка слова (edge-tts)" checked={cfg.anki.tts} onChange={(tts) => set('anki', { tts })} />
            <Field label="Голос">
              <Text value={cfg.anki.ttsVoice} onChange={(ttsVoice) => set('anki', { ttsVoice })} placeholder="en-US-GuyNeural" />
            </Field>
            <Field label="Озвучка предложения">
              <select
                className={inputClass}
                value={cfg.anki.sentenceAudio}
                onChange={(e) => set('anki', { sentenceAudio: e.target.value as AppConfig['anki']['sentenceAudio'] })}
              >
                <option value="none">Нет</option>
                <option value="clip">Из клипа</option>
                <option value="tts">Синтез</option>
              </select>
            </Field>
            {cfg.anki.sentenceAudio === 'clip' && !cfg.anki.clip && (
              <p className="type-body-small text-[var(--md-sys-color-error)]">Видео выключено — звук предложения из клипа недоступен</p>
            )}
            {uvMissing && <p className={HINT}>Нужен uv: без него озвучка не создаётся</p>}
            <Switch label="Синхронизировать с AnkiWeb после добавления" checked={cfg.anki.syncAfterAdd} onChange={(syncAfterAdd) => set('anki', { syncAfterAdd })} />
          </Group>

          <Group title="Известные слова">
            <Switch label="Все колоды" checked={allDecks} onChange={(on) => set('anki', { indexDecks: on ? ['*'] : [] })} />
            {!allDecks && (
              <>
                {deckList.length === 0 ? (
                  <p className={HINT}>Список колод появится, когда Anki ответит</p>
                ) : (
                  <div className="flex max-h-52 flex-wrap gap-2 overflow-y-auto">
                    {deckList.map((d) => (
                      <Chip
                        key={d.name}
                        label={`${d.name} · ${d.cards}`}
                        selected={cfg.anki.indexDecks.includes(d.name)}
                        onClick={() => toggleDeck(d.name, !cfg.anki.indexDecks.includes(d.name))}
                      />
                    ))}
                  </div>
                )}
                {cfg.anki.indexDecks.length === 0 && <p className={HINT}>Ничего не выбрано — читается только колода «{cfg.anki.deck}»</p>}
              </>
            )}
            {(models.data ?? []).map((m) => (
              <div key={m.noteType} className="flex flex-col gap-1 border-t border-[var(--md-sys-color-outline-variant)] pt-2">
                <span className="type-label-large">{`${m.noteType} · ${m.cards}`}</span>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  <select
                    className={inputClass}
                    value={cfg.anki.indexFields[m.noteType]?.word ?? m.wordField}
                    onChange={(e) => setIndexField(m.noteType, { word: e.target.value })}
                  >
                    {m.fields.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <select
                    className={inputClass}
                    value={cfg.anki.indexFields[m.noteType]?.translation ?? m.translationField}
                    onChange={(e) => setIndexField(m.noteType, { translation: e.target.value })}
                  >
                    <option value="">без перевода</option>
                    {m.fields.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>
            ))}
            {(models.data ?? []).length === 0 && <p className={HINT}>Типы заметок появятся после первого чтения Anki</p>}
          </Group>

          <Group title="Картинки">
            <ImageFields images={cfg.images} disabled={tutorOwnsImages} onChange={(patch) => set('images', patch)} />
          </Group>

          <Group title="Tutor (необязательно)">
            <Switch label="Использовать tutor" checked={cfg.tutor.enabled} onChange={setTutorEnabled} />
            <Field label="Папка tutor">
              <Text value={cfg.tutor.root} onChange={(root) => set('tutor', { root })} />
            </Field>
            <Field label="Адрес Tutor API">
              <Text value={cfg.tutor.apiUrl} onChange={(apiUrl) => set('tutor', { apiUrl })} />
            </Field>
            <Switch
              label="Брать настройки картинок из tutor"
              checked={cfg.tutor.useImageSettings}
              onChange={(useImageSettings) => set('tutor', { useImageSettings })}
            />
          </Group>
        </div>

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          {preview.error ? (
            <p className="type-body-medium text-[var(--md-sys-color-error)]">{errorText(preview.error)}</p>
          ) : preview.data ? (
            <CardPreview preview={preview.data} />
          ) : (
            <Spinner label="Загружаю предпросмотр" className="m-6" />
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--md-sys-color-outline-variant)] px-6 py-4">
        <button type="button" className={TEXT_BUTTON} onClick={onClose}>Закрыть</button>
        <button type="button" className={PRIMARY} disabled={!dirty || saving} onClick={onSave}>
          Сохранить
        </button>
      </div>
    </Dialog>
  )
}
