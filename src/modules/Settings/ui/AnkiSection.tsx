import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, type CSSProperties } from 'react'
import { Button, Chip, Icon, Select, Spinner, Switch, TextField, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText, onEvent } from '@/common/api/tauri'
import type { AnkiConnectionStatus, AppConfig, CardSource } from '@/common/types/ipc'
import { autoSource, SOURCE_LABELS } from '@/modules/Cards'
import { SECTION_META } from '../lib/sections'
import { SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'

const BUILTIN = 'Smart Subtitles — Vocab'

export function AnkiSection({
  cfg,
  set,
  ankiStatus,
  ankiChecking,
  onCheckAnki,
  changedKeys,
  focusId,
}: {
  cfg: AppConfig
  set: ApplyConfig
  ankiStatus?: AnkiConnectionStatus
  ankiChecking: boolean
  onCheckAnki: () => void
  changedKeys: Set<string>
  focusId?: string
}) {
  const meta = SECTION_META.anki
  const qc = useQueryClient()
  const catalog = useQuery({ queryKey: ['anki-catalog'], queryFn: api.ankiCatalog, retry: false, staleTime: 30_000 })
  const noteType = useQuery({
    queryKey: ['anki-note-type', cfg.anki.noteType],
    queryFn: () => api.ankiNoteType(cfg.anki.noteType),
    retry: false,
  })
  const models = useQuery({ queryKey: ['anki-index-models'], queryFn: api.ankiIndexModels })

  // The index models come from the last Anki refresh, which runs after every saved deck change.
  useEffect(() => {
    const un = onEvent('anki:index', () => {
      void qc.invalidateQueries({ queryKey: ['anki-index-models'] })
    })
    return () => {
      void un.then((f) => f())
    }
  }, [qc])

  const allDecks = cfg.anki.indexDecks.includes('*')
  const deckList = catalog.data?.decks ?? []
  const typeList = catalog.data?.noteTypes ?? []
  const fields = noteType.data?.fields ?? []

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

  const refreshAll = () => {
    onCheckAnki()
    void catalog.refetch()
    void noteType.refetch()
  }

  const refreshIndex = () => {
    api
      .ankiRefresh()
      .then(() => {
        toast('Индекс известных слов обновлён')
        onCheckAnki()
        void models.refetch()
      })
      .catch((e) => notify('error', errorText(e)))
  }

  const indexUpdatedText = ankiStatus?.indexUpdatedAt
    ? new Date(ankiStatus.indexUpdatedAt * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title={meta.label}
        subtitle={meta.subtitle}
        icon={meta.icon}
        shape={meta.shape}
        tone={ankiStatus && !ankiStatus.ok ? 'warning' : meta.tone}
      />

      {ankiStatus && !ankiStatus.ok && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-3xl py-2.5 pr-2.5 pl-5 sm:rounded-full"
          style={{
            backgroundColor: 'var(--app-warning-container)',
            color: 'var(--app-on-warning-container)',
          }}
        >
          <Icon name="sync_problem" size={24} />
          <span className="type-body-medium min-w-0 flex-1">
            Anki не отвечает на {cfg.anki.url}
            {ankiStatus.queuedCards > 0 ? ` — ${ankiStatus.queuedCards} карточек ждут в очереди.` : '.'}
          </span>
          <Button
            variant="text"
            icon="refresh"
            disabled={ankiChecking}
            onClick={refreshAll}
            style={{
              color: 'var(--app-on-warning-container)',
              '--m3e-button-content': 'currentColor',
            } as CSSProperties}
          >
            {ankiChecking ? 'Проверяю…' : 'Проверить'}
          </Button>
        </div>
      )}

      <SettingGroup
        title="Подключение"
        action={
          <Button variant="tonal" size="xs" icon="refresh" onClick={refreshAll}>
            Обновить
          </Button>
        }
      >
        <SettingRow
          focusId="anki.url"
          highlighted={focusId === 'anki.url'}
          changed={changedKeys.has('anki.url')}
          configKey="anki.url"
          label="Адрес AnkiConnect"
          sub={
            catalog.isFetching
              ? 'Спрашиваю Anki…'
              : catalog.error
                ? errorText(catalog.error)
                : `Anki отвечает: колод ${deckList.length}, типов заметок ${typeList.length}`
          }
          control={
            <div className="w-full sm:w-[240px]">
              <TextField
                aria-label="Адрес AnkiConnect"
                variant="outlined"
                value={cfg.anki.url}
                placeholder="http://127.0.0.1:8765"
                spellCheck={false}
                onChange={(e) => set('anki', { url: e.target.value })}
              />
            </div>
          }
        />

        <SettingRow
          focusId="anki.syncAfterAdd"
          highlighted={focusId === 'anki.syncAfterAdd'}
          changed={changedKeys.has('anki.syncAfterAdd')}
          configKey="anki.syncAfterAdd"
          label="Синхронизировать с AnkiWeb"
          sub="После добавления — карточки сразу появятся на телефоне."
          control={
            <Switch
              ariaLabel="Синхронизировать с AnkiWeb"
              checked={cfg.anki.syncAfterAdd}
              onChange={(syncAfterAdd) => set('anki', { syncAfterAdd })}
            />
          }
        />
      </SettingGroup>

      <SettingGroup title="Колода и тип заметки">
        <SettingRow
          focusId="anki.deck"
          highlighted={focusId === 'anki.deck'}
          changed={changedKeys.has('anki.deck')}
          configKey="anki.deck"
          label="Колода"
          sub="Новая колода создаётся при первой карточке."
          control={
            <div className="w-full sm:w-[260px]">
              <TextField
                aria-label="Колода Anki"
                variant="outlined"
                list="anki-decks-list"
                value={cfg.anki.deck}
                spellCheck={false}
                onChange={(e) => set('anki', { deck: e.target.value })}
              />
              <datalist id="anki-decks-list">
                {deckList.map((d) => (
                  <option key={d.name} value={d.name}>
                    {`${d.cards} карточек`}
                  </option>
                ))}
              </datalist>
            </div>
          }
        />

        <SettingRow
          focusId="anki.noteType"
          highlighted={focusId === 'anki.noteType'}
          changed={changedKeys.has('anki.noteType')}
          configKey="anki.noteType"
          label="Тип заметки"
          sub="Встроенный тип приложение создаёт и дополняет само."
          below={
            <Select
              aria-label="Тип заметки Anki"
              variant="outlined"
              value={cfg.anki.noteType}
              onChange={(e) => set('anki', { noteType: e.target.value })}
            >
              <option value={BUILTIN}>{`${BUILTIN} (встроенный)`}</option>
              {typeList
                .filter((t) => t.name !== BUILTIN)
                .map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              {!!cfg.anki.noteType &&
                cfg.anki.noteType !== BUILTIN &&
                !typeList.some((t) => t.name === cfg.anki.noteType) && (
                  <option value={cfg.anki.noteType}>{cfg.anki.noteType}</option>
                )}
            </Select>
          }
        />

        <SettingRow
          focusId="anki.tags"
          highlighted={focusId === 'anki.tags'}
          changed={changedKeys.has('anki.tags')}
          configKey="anki.tags"
          label="Теги"
          sub="{film} — название фильма"
          below={
            <TextField
              aria-label="Теги карточки Anki"
              variant="outlined"
              value={cfg.anki.tags}
              spellCheck={false}
              onChange={(e) => set('anki', { tags: e.target.value })}
            />
          }
        />
      </SettingGroup>

      <SettingGroup
        title="Поля карточки"
        subtitle="Что приложение пишет в каждое поле заметки."
        action={
          fields.length > 0 ? (
            <Button variant="tonal" size="xs" icon="restart_alt" onClick={resetFields}>
              Сбросить к авто
            </Button>
          ) : undefined
        }
      >
        <SettingRow
          focusId="anki.fields"
          highlighted={focusId === 'anki.fields'}
          changed={changedKeys.has('anki.fields')}
          configKey="anki.fields"
          label={`${cfg.anki.noteType} · ${fields.length} полей`}
          below={
            noteType.isPending ? (
              <Spinner label="Загружаю поля" size={20} width={2} />
            ) : noteType.error ? (
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                {errorText(noteType.error)}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {fields.map((f) => {
                  const value = (cfg.anki.fields[f] ?? autoSource(f) ?? '') as CardSource
                  return (
                    <div
                      key={f}
                      className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[176px_20px_minmax(0,1fr)]"
                    >
                      <span className="type-title-small type-emph truncate" title={f}>
                        {f}
                      </span>
                      <Icon
                        name="arrow_back"
                        size={18}
                        className="hidden text-[var(--md-sys-color-on-surface-variant)] sm:inline-flex"
                      />
                      <Select
                        aria-label={`Источник для поля ${f}`}
                        variant="outlined"
                        value={value}
                        onChange={(e) => setField(f, e.target.value as CardSource)}
                      >
                        {SOURCE_LABELS.map(([id, label]) => (
                          <option key={id || 'none'} value={id}>
                            {label}
                          </option>
                        ))}
                        {!!value && !SOURCE_LABELS.some(([id]) => id === value) && (
                          <option value={value}>{value}</option>
                        )}
                      </Select>
                    </div>
                  )
                })}
              </div>
            )
          }
        />
      </SettingGroup>

      <SettingGroup
        title="Известные слова"
        subtitle="Слова из этих колод не подсвечиваются как новые."
        action={
          <Button variant="text" size="xs" icon="sync" onClick={refreshIndex}>
            Перечитать индекс
          </Button>
        }
      >
        <SettingRow
          focusId="anki.indexDecks"
          highlighted={focusId === 'anki.indexDecks'}
          changed={changedKeys.has('anki.indexDecks')}
          configKey="anki.indexDecks"
          label="Все колоды"
          sub={
            ankiStatus
              ? `${ankiStatus.indexCount} слов в индексе${indexUpdatedText ? ` · обновлён в ${indexUpdatedText}` : ''}`
              : 'Чтение словаря из Anki'
          }
          control={
            <Switch
              ariaLabel="Все колоды"
              checked={allDecks}
              onChange={(on) => set('anki', { indexDecks: on ? ['*'] : [] })}
            />
          }
          below={
            !allDecks ? (
              <div className="flex flex-col gap-2">
                {deckList.length === 0 ? (
                  <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                    Список колод появится, когда Anki ответит
                  </p>
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
                {cfg.anki.indexDecks.length === 0 && (
                  <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                    Ничего не выбрано — читается только колода «{cfg.anki.deck}»
                  </p>
                )}
              </div>
            ) : undefined
          }
        />

        <SettingRow
          focusId="anki.indexFields"
          highlighted={focusId === 'anki.indexFields'}
          changed={changedKeys.has('anki.indexFields')}
          configKey="anki.indexFields"
          label="Поля типов заметок"
          sub="Какие поля читать в индекс известных слов."
          below={
            (models.data ?? []).length === 0 ? (
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                Типы заметок появятся после первого чтения Anki
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {(models.data ?? []).map((m) => (
                  <div key={m.noteType} className="flex flex-col gap-2">
                    <span className="type-title-small type-emph">{`${m.noteType} · ${m.cards}`}</span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Select
                        label="Поле слова"
                        variant="outlined"
                        value={cfg.anki.indexFields[m.noteType]?.word ?? m.wordField}
                        onChange={(e) => setIndexField(m.noteType, { word: e.target.value })}
                      >
                        {m.fields.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label="Поле перевода"
                        variant="outlined"
                        value={cfg.anki.indexFields[m.noteType]?.translation ?? m.translationField}
                        onChange={(e) => setIndexField(m.noteType, { translation: e.target.value })}
                      >
                        <option value="">без перевода</option>
                        {m.fields.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        />
      </SettingGroup>
    </div>
  )
}
