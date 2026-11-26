import { useMemo, useState, type CSSProperties } from 'react'
import { Virtuoso } from 'react-virtuoso'
import {
  Button,
  Dialog,
  IconButton,
  ListGroup,
  Presence,
  Segmented,
  ShapeBadge,
  StatusChip,
  TextField,
  toast,
} from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { KnownWord, UnaddedWord, VocabInfo, VocabularyStats } from '@/common/types/ipc'
import { formatCountRu } from '@/common/utilities/pluralRu'
import { useCardsStore } from '@/modules/Cards'
import { VocabBadges, useKnownWords, useSetKnownWord } from '@/modules/Vocab'
import { cefrWindowLabel, filterUnaddedWords, formatEpisodeTitle, formatFilmCountLabel, isUsefulWord, type UnaddedFilter } from '../lib/format'
import { CefrBarsChart, LegendDot, StackedBar } from './StatsCharts'

const SUCCESS_CHIP: CSSProperties = {
  '--m3e-status-chip-container': 'var(--app-success-container)',
  '--m3e-status-chip-content': 'var(--app-on-success-container)',
} as CSSProperties

const WARNING_CHIP: CSSProperties = {
  '--m3e-status-chip-container': 'var(--app-warning-container)',
  '--m3e-status-chip-content': 'var(--app-on-warning-container)',
} as CSSProperties

const BADGE_SUCCESS: CSSProperties = {
  '--m3e-badge-container': 'var(--app-success-container)',
  '--m3e-badge-content': 'var(--app-on-success-container)',
} as CSSProperties

const ANKI_BTN_STYLE: CSSProperties = {
  '--m3e-button-container': 'var(--app-anki-label-container)',
  '--m3e-button-content': 'var(--app-anki-on-label-container)',
} as CSSProperties

function toVocabInfo(w: UnaddedWord): VocabInfo {
  return {
    query: w.span,
    lemma: w.lemma,
    isPhrase: w.span.trim().includes(' '),
    found: true,
    tier: w.tier,
    cefr: w.cefr,
    cefrSource: null,
    aboveLevel: w.aboveLevel,
    ranks: { ngsl: null, ngslSpoken: null, bsl: null, subtitles: null },
    zipf: null,
    business: w.business,
    spoken: w.spoken,
    filmCount: 0,
    parts: [],
  }
}

export function KnownWordsList({
  items,
  emptyText,
  onRemove,
}: {
  items: readonly KnownWord[]
  emptyText: string
  onRemove: (item: KnownWord) => void
}) {
  const [measured, setMeasured] = useState<{ len: number; height: number } | null>(null)

  if (items.length === 0) {
    return (
      <div className="rounded-[20px] bg-[var(--md-sys-color-surface-container-low)] p-6 text-center">
        <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">{emptyText}</p>
      </div>
    )
  }

  const exactHeight = measured && measured.len === items.length ? measured.height : items.length * 72
  const heightExpr =
    items.length >= 8
      ? 'min(440px, 50vh)'
      : `min(440px, 50vh, ${Math.max(56, exactHeight)}px)`

  return (
    <Virtuoso
      className="stats-scroll rounded-[24px]"
      style={{ height: heightExpr }}
      data={items}
      initialItemCount={Math.min(12, items.length)}
      defaultItemHeight={58}
      computeItemKey={(_, item) => item.lemma}
      totalListHeightChanged={(height) => setMeasured({ len: items.length, height })}
      itemContent={(index, item) => (
        <div className={index < items.length - 1 ? 'pb-[2px]' : undefined}>
          <div className="flex items-center justify-between gap-3 rounded-[4px] bg-[var(--md-sys-color-surface-container)] px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="type-title-small type-emph wrap-anywhere">{item.display}</div>
              {item.display.toLowerCase() !== item.lemma && (
                <div className="type-body-small wrap-anywhere text-[var(--md-sys-color-on-surface-variant)]">
                  лемма: {item.lemma}
                </div>
              )}
            </div>
            <IconButton
              icon="close"
              label={`Убрать ${item.display}`}
              onClick={() => onRemove(item)}
            />
          </div>
        </div>
      )}
    />
  )
}

export function KnownWordsDialog({ onClose }: { onClose: () => void }) {
  const words = useKnownWords()
  const toggleKnown = useSetKnownWord()
  const [search, setSearch] = useState('')
  const [newWord, setNewWord] = useState('')

  const list = words.data ?? []
  const q = search.trim().toLowerCase()
  const filtered = useMemo(
    () => (q ? list.filter((w) => w.lemma.toLowerCase().includes(q) || w.display.toLowerCase().includes(q)) : list),
    [list, q],
  )

  const addWord = () => {
    const clean = newWord.trim()
    if (!clean || toggleKnown.isPending) return
    toggleKnown.mutate(
      { word: clean, known: true },
      {
        onSuccess: (res) => {
          setNewWord('')
          toast(`Добавлено в «Знаю»: ${res.display}`)
        },
        onError: (e) => notify('error', errorText(e)),
      },
    )
  }

  return (
    <Dialog
      onClose={onClose}
      dismissible
      aria-labelledby="known-words-title"
      className="max-h-[85vh] w-[560px] max-w-[96vw] overflow-hidden p-0"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 id="known-words-title" className="type-headline-small">
            Известные слова · {list.length}
          </h2>
          <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
            Исключаются из рекомендаций и повышают расчётное понимание фильмов.
          </p>
        </div>
        <IconButton icon="close" label="Закрыть" noTip onClick={onClose} />
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 px-6 pb-3">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              data-autofocus
              label="Добавить слово"
              placeholder="например, reluctant"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addWord()
                }
              }}
            />
          </div>
          <Button variant="tonal" size="sm" icon="add" disabled={!newWord.trim() || toggleKnown.isPending} onClick={addWord}>
            Добавить
          </Button>
        </div>
        {list.length > 6 && (
          <TextField
            label="Найти в списке"
            placeholder="Поиск слова..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>

      <div className="min-h-0 flex-auto px-6 pb-5">
        <KnownWordsList
          items={filtered}
          emptyText={list.length === 0 ? 'Пока нет слов, отмеченных кнопкой «Знаю».' : 'Совпадений не найдено.'}
          onRemove={(item) =>
            toggleKnown.mutate(
              { word: item.lemma, known: false },
              {
                onSuccess: () => toast(`Убрано из «Знаю»: ${item.display}`),
                onError: (e) => notify('error', errorText(e)),
              },
            )
          }
        />
      </div>
    </Dialog>
  )
}

export function VocabularyTab({
  data,
  learnerCefr,
  onRefreshAnki,
}: {
  data: VocabularyStats
  learnerCefr: string
  onRefreshAnki: () => void
}) {
  const [filter, setFilter] = useState<UnaddedFilter>('useful')
  const [knownOpen, setKnownOpen] = useState(false)
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  const toggleKnown = useSetKnownWord()

  const usefulCount = data.unadded.filter(isUsefulWord).length
  const repeatCount = data.unadded.filter((w) => w.clicks >= 2 || w.filmsCount >= 2).length
  const shownWords = filterUnaddedWords(data.unadded, filter)

  const spokenCovered = data.ngslSpoken.learned + data.ngslSpoken.learning + data.ngslSpoken.known
  const ngslCovered = data.ngsl.learned + data.ngsl.learning + data.ngsl.known
  const spokenPct =
    data.ngslSpoken.total > 0 && Number.isFinite(spokenCovered)
      ? Math.round((spokenCovered / data.ngslSpoken.total) * 100)
      : 0
  const ngslPct =
    data.ngsl.total > 0 && Number.isFinite(ngslCovered)
      ? Math.round((ngslCovered / data.ngsl.total) * 100)
      : 0
  const inWindowPct = data.inWindowPct !== null && Number.isFinite(data.inWindowPct) ? data.inWindowPct : null
  const hardCount = data.ankiMaturity.weak + data.ankiMaturity.leech

  const handleCreateCard = async (w: UnaddedWord) => {
    setCreatingKey(w.lemma)
    try {
      const job = await api.cardsJobCreate(w.mediaId, w.cueIdx, w.span, w.audioIndex, w.subOffset, 'review')
      const store = useCardsStore.getState()
      store.upsert(job)
      store.openEditor(await api.cardsJobEdit(job.id, true))
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setCreatingKey(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-6">
          <div>
            <h2 className="type-title-large type-emph">Покрытие ядра речи</h2>
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              Сколько базовой частотной лексики уже в Anki или отмечено «Знаю»
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="type-title-small type-emph">NGSL-Spoken · Разговорное ядро</span>
              <span className="type-label-large type-emph tabular-nums text-[var(--md-sys-color-primary)]">
                {spokenCovered} / {data.ngslSpoken.total} · {spokenPct}%
              </span>
            </div>
            <StackedBar
              height={14}
              radius={7}
              segments={[
                { value: data.ngslSpoken.learned, color: 'var(--app-success)', title: `Выучено: ${data.ngslSpoken.learned}` },
                { value: data.ngslSpoken.learning, color: 'var(--md-sys-color-primary)', title: `В работе: ${data.ngslSpoken.learning}` },
                { value: data.ngslSpoken.known, color: 'var(--md-sys-color-secondary)', title: `Знаю: ${data.ngslSpoken.known}` },
                { value: Math.max(0, data.ngslSpoken.total - spokenCovered), color: 'var(--md-sys-color-surface-container-highest)' },
              ]}
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="type-title-small type-emph">NGSL 1.2 · Повседневная база</span>
              <span className="type-label-large type-emph tabular-nums text-[var(--md-sys-color-primary)]">
                {ngslCovered} / {data.ngsl.total} · {ngslPct}%
              </span>
            </div>
            <StackedBar
              height={14}
              radius={7}
              segments={[
                { value: data.ngsl.learned, color: 'var(--app-success)', title: `Выучено: ${data.ngsl.learned}` },
                { value: data.ngsl.learning, color: 'var(--md-sys-color-primary)', title: `В работе: ${data.ngsl.learning}` },
                { value: data.ngsl.known, color: 'var(--md-sys-color-secondary)', title: `Знаю: ${data.ngsl.known}` },
                { value: Math.max(0, data.ngsl.total - ngslCovered), color: 'var(--md-sys-color-surface-container-highest)' },
              ]}
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <LegendDot color="var(--app-success)" label="Выучено" />
            <LegendDot color="var(--md-sys-color-primary)" label="В работе" />
            <LegendDot color="var(--md-sys-color-secondary)" label="Знаю" />
            <LegendDot color="var(--md-sys-color-surface-container-highest)" label="Ещё нет" ring />
          </div>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 rounded-[20px] bg-[var(--md-sys-color-surface-container-high)] px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <ShapeBadge shape="sunny" size={36} tone="neutral" icon="check" iconFill iconSize={18} style={BADGE_SUCCESS} />
              <div className="min-w-0">
                <div className="type-title-small type-emph">
                  Отмечено «Знаю»: {formatCountRu(data.knownCount, 'слово', 'слова', 'слов')}
                </div>
                <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                  Исключены из предложений и повышают % понимания
                </div>
              </div>
            </div>
            <Button variant="outlined" size="xs" onClick={() => setKnownOpen(true)}>
              Список
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-6">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="type-title-large type-emph">Карточки из фильмов (Anki)</h2>
              <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
                {formatCountRu(data.ankiMaturity.total, 'карточка', 'карточки', 'карточек')} · колода {data.ankiDeck}
              </p>
            </div>
            {inWindowPct !== null && (
              <StatusChip size="md" tone="primary">
                {inWindowPct}% в окне {cefrWindowLabel(learnerCefr)}
              </StatusChip>
            )}
          </div>

          {!data.ankiConnected && data.ankiMaturity.total === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[20px] bg-[var(--md-sys-color-surface-container-low)] p-6 text-center">
              <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
                Anki не отвечает. Откройте Anki с AnkiConnect, чтобы увидеть зрелость и CEFR карточек.
              </p>
              <Button variant="tonal" size="sm" icon="refresh" onClick={onRefreshAnki}>
                Проверить Anki
              </Button>
            </div>
          ) : (
            <>
              <StackedBar
                height={14}
                radius={7}
                segments={[
                  { value: data.ankiMaturity.learned, color: 'var(--app-success)' },
                  { value: data.ankiMaturity.young, color: 'var(--md-sys-color-primary)' },
                  { value: data.ankiMaturity.learning, color: 'var(--md-sys-color-secondary)' },
                  { value: data.ankiMaturity.newCount, color: 'var(--md-sys-color-outline)' },
                  { value: hardCount, color: 'var(--app-warning)' },
                ]}
              />

              <div className="flex flex-wrap gap-1.5">
                <StatusChip size="sm" tone="neutral" style={SUCCESS_CHIP}>
                  Выучено · {data.ankiMaturity.learned}
                </StatusChip>
                <StatusChip size="sm" tone="primary">Молодые · {data.ankiMaturity.young}</StatusChip>
                <StatusChip size="sm" tone="secondary">В работе · {data.ankiMaturity.learning}</StatusChip>
                <StatusChip size="sm" tone="neutral">Новые · {data.ankiMaturity.newCount}</StatusChip>
                <StatusChip size="sm" tone="neutral" style={WARNING_CHIP}>
                  Сложные · {hardCount}
                </StatusChip>
              </div>

              <div className="border-t border-[var(--md-sys-color-outline-variant)]/50 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="type-title-small type-emph">По уровням CEFR</span>
                  <span className="type-body-small text-[var(--md-sys-color-primary)]">
                    фокус на {cefrWindowLabel(learnerCefr)}
                  </span>
                </div>
                <CefrBarsChart counts={data.ankiCefr} learnerCefr={learnerCefr} />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="type-title-large type-emph">Кликал, но не добавил в Anki</h2>
              <StatusChip size="sm" tone="neutral">{data.unadded.length}</StatusChip>
            </div>
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              Отсортировано по частотности в речи и числу кликов; редкие слова приглушены внизу.
            </p>
          </div>
          <Segmented
            label="Фильтр слов"
            size="xs"
            value={filter}
            options={[
              { value: 'useful', label: `Полезные · ${usefulCount}` },
              { value: 'all', label: `Все · ${data.unadded.length}` },
              { value: 'repeat', label: `Повторные · ${repeatCount}` },
            ]}
            onChange={setFilter}
          />
        </div>

        {shownWords.length === 0 ? (
          <div className="rounded-[24px] bg-[var(--md-sys-color-surface-container)] p-6 text-center">
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              {data.unadded.length === 0
                ? 'Все объяснённые слова уже либо в Anki, либо в списке «Знаю».'
                : 'В этом фильтре пока нет слов — переключитесь на «Все».'}
            </p>
          </div>
        ) : (
          <ListGroup>
            {shownWords.map((w) => {
              const rare = !isUsefulWord(w)
              const busy = creatingKey === w.lemma
              return (
                <div
                  key={w.lemma}
                  className={`flex flex-wrap items-center justify-between gap-4 px-5 py-3 ${
                    rare
                      ? 'bg-[var(--md-sys-color-surface-container-low)]'
                      : 'bg-[var(--md-sys-color-surface-container)]'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className={`type-title-medium min-w-0 wrap-anywhere ${
                          rare ? 'text-[var(--md-sys-color-on-surface-variant)]' : 'type-emph'
                        }`}
                      >
                        {w.span}
                      </span>
                      {w.translation && (
                        <span className="type-body-medium min-w-0 wrap-anywhere text-[var(--md-sys-color-on-surface-variant)]">
                          · {w.translation}
                        </span>
                      )}
                      <VocabBadges vocab={toVocabInfo(w)} />
                      {w.filmsCount > 0 && (
                        <StatusChip size="sm" tone="neutral">
                          {formatFilmCountLabel(w.filmsCount)}
                        </StatusChip>
                      )}
                    </div>
                    <div className="type-body-small flex min-w-0 flex-wrap items-center gap-2 text-[var(--md-sys-color-on-surface-variant)]">
                      <span className="min-w-0 wrap-anywhere italic opacity-90">«{w.quote}»</span>
                      <span className="min-w-0 wrap-anywhere">
                        · {formatCountRu(w.clicks, 'клик', 'клика', 'кликов')} ·{' '}
                        {w.filmTitles.length > 0 ? w.filmTitles.join(', ') : formatEpisodeTitle(w.title, w.season, w.episode)}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant={rare ? 'text' : 'tonal'}
                      size="xs"
                      icon="add"
                      disabled={busy}
                      style={rare ? undefined : ANKI_BTN_STYLE}
                      onClick={() => void handleCreateCard(w)}
                    >
                      {busy ? 'Открываю…' : 'В Anki'}
                    </Button>
                    <Button
                      variant="outlined"
                      size="xs"
                      icon={rare ? 'close' : 'check'}
                      disabled={toggleKnown.isPending}
                      onClick={() =>
                        toggleKnown.mutate(
                          { word: w.lemma || w.span, known: true },
                          {
                            onSuccess: (res) => toast(`Отмечено «Знаю»: ${res.display}`),
                            onError: (e) => notify('error', errorText(e)),
                          },
                        )
                      }
                    >
                      {rare ? 'Пропустить' : 'Знаю'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </ListGroup>
        )}
      </section>

      <Presence>{knownOpen && <KnownWordsDialog onClose={() => setKnownOpen(false)} />}</Presence>
    </div>
  )
}
