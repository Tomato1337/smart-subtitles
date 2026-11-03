import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { AnkiCard, AnkiLabelMode, Chunk, ChunkKind, Cue } from '@/common/types/ipc'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { ankiTokenDecor, isLabelVisible, labelText, STATUS_RU } from '@/modules/Anki'
import { PatternChip, patternById } from '@/modules/Patterns'
import { chunkUnderline, CueText, kindColor, tokenize, type SpanPick } from '@/modules/Subtitles'
import { PATTERN_UNDERLINE } from './CueLine'

const SEEN_KEY = 'smartsubs.guideSeen'

/** True until the guide has been opened once. */
export const guideUnseen = () => !localStorage.getItem(SEEN_KEY)

type Layer = ChunkKind | 'pattern' | 'anki'

/** Demo cue: layers are given as exact substrings of `text`, like the annotator returns them. */
type Sample = {
  text: string
  ru: string
  chunks: { text: string; kind: ChunkKind; ru: string }[]
  patterns: { id: string; text: string }[]
  anki: { text: string; translation: string; status: AnkiCard['status'] }[]
}

const SAMPLES: Sample[] = [
  {
    text: "I'm gonna figure it out, no big deal.",
    ru: 'Я разберусь, ничего страшного.',
    chunks: [
      { text: 'gonna', kind: 'reduction', ru: 'собираюсь (= going to)' },
      { text: 'figure it out', kind: 'phrasal_verb', ru: 'разобраться' },
      { text: 'no big deal', kind: 'idiom', ru: 'ничего страшного' },
    ],
    patterns: [],
    anki: [],
  },
  {
    text: "If I'd known, I wouldn't have bailed on you, bro.",
    ru: 'Знал бы я — не бросил бы тебя, братан.',
    chunks: [
      { text: 'bailed on', kind: 'phrasal_verb', ru: 'бросил, кинул' },
      { text: 'bro', kind: 'slang', ru: 'братан' },
    ],
    patterns: [{ id: 'THIRD_COND', text: "If I'd known, I wouldn't have bailed on you" }],
    anki: [{ text: 'bailed on', translation: 'бросить, подвести', status: 'young' }],
  },
  {
    text: "Honestly, I'm excited, but we have to make a decision.",
    ru: 'Честно, я в восторге, но нам надо принять решение.',
    chunks: [{ text: 'make a decision', kind: 'collocation', ru: 'принять решение' }],
    patterns: [{ id: 'MUST_HAVE_TO', text: 'have to make' }],
    anki: [{ text: 'excited', translation: 'взволнованный; в восторге', status: 'learning' }],
  },
  {
    text: 'Hardly had he left when she called.',
    ru: 'Едва он ушёл, как она позвонила.',
    chunks: [{ text: 'Hardly had he left when', kind: 'grammar', ru: 'едва… как (инверсия)' }],
    patterns: [],
    anki: [],
  },
]

type Range = { from: number; to: number }
type Built = {
  cue: Cue
  ru: string
  chunks: Chunk[]
  patterns: (Range & { id: string })[]
  anki: (Range & { translation: string; status: AnkiCard['status'] })[]
}

function at(text: string, sub: string): Range {
  const from = text.indexOf(sub)
  if (from < 0) throw new Error(`guide sample: «${sub}» not in «${text}»`)
  return { from, to: from + sub.length }
}

function build(s: Sample, idx: number): Built {
  return {
    cue: { idx: -1 - idx, start: 0, end: 3, text: s.text, ru: null },
    ru: s.ru,
    chunks: s.chunks.map((c) => { const r = at(s.text, c.text); return { ...c, startChar: r.from, endChar: r.to } }),
    patterns: s.patterns.map((p) => ({ id: p.id, ...at(s.text, p.text) })),
    anki: s.anki.map((a) => ({ translation: a.translation, status: a.status, ...at(s.text, a.text) })),
  }
}

const inside = (t: { start: number; end: number }, r: Range) => t.start >= r.from && t.end <= r.to
const overlaps = (a: Range, b: Range) => a.from < b.to && b.from < a.to

const LEGEND: { layer: Layer; title: string; read: string; style: CSSProperties; sample: string }[] = [
  {
    layer: 'idiom', title: 'Идиома', sample: 'no big deal', style: chunkUnderline('idiom'),
    read: 'Смысл не складывается из слов. Переводи всю подчёркнутую часть целиком, а не по словам.'
  },
  {
    layer: 'phrasal_verb', title: 'Фразовый глагол', sample: 'bailed on', style: chunkUnderline('phrasal_verb'),
    read: 'Глагол + частица. Частица меняет смысл: bail — «выпрыгнуть», bail on — «бросить, подвести».'
  },
  {
    layer: 'collocation', title: 'Устойчивое сочетание', sample: 'make a decision', style: chunkUnderline('collocation'),
    read: 'Слова, которые носители ставят вместе: make a decision, а не do a decision. Учи парой.'
  },
  {
    layer: 'slang', title: 'Сленг', sample: 'bro', style: chunkUnderline('slang'),
    read: 'Разговорное слово, в письме и на работе звучит неуместно. Перевод сохраняет тот же регистр.'
  },
  {
    layer: 'reduction', title: 'Редукция', sample: 'gonna', style: chunkUnderline('reduction'),
    read: 'Так слово звучит в быстрой речи: gonna = going to, wanna = want to. Помогает расслышать фразу.'
  },
  {
    layer: 'grammar', title: 'Трудная грамматика', sample: 'Hardly had he left', style: chunkUnderline('grammar'),
    read: 'Сплошная жёлтая линия: сложная конструкция в этой фразе. По клику — перевод именно этого места.'
  },
  {
    layer: 'pattern', title: 'Тема грамматики', sample: 'have to', style: PATTERN_UNDERLINE,
    read: 'Двойная жёлтая линия и бейдж над фразой: тема из каталога, приложение считает, сколько раз она встретилась. Клик по бейджу открывает карточку темы. Двойная линия рисуется только на словах вне цветных подчёркиваний. Если отметить тему как «Знаю», бейдж пропадёт.'
  },
  {
    layer: 'anki', title: 'Слово из твоей колоды', sample: 'excited', style: ankiTokenDecor().style,
    read: 'Пунктир: слово совпало с карточкой Anki в любой форме (excited, excite, excites). Плашка над первым словом показывает перевод из карточки. Какие карточки подсвечивать, выбирается в настройках.'
  },
]

const KIND_TITLE = Object.fromEntries(LEGEND.map((l) => [l.layer, l.title])) as Record<Layer, string>

const ANKI_MODES: { mode: AnkiLabelMode; label: string }[] = [
  { mode: 'fresh', label: 'Только новые' },
  { mode: 'unlearned', label: 'Все невыученные' },
  { mode: 'off', label: 'Выключены' },
]

type Pick = { sample: number; range: Range; text: string }

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="type-label-medium rounded-[var(--md-sys-shape-corner-extra-small)] bg-[var(--md-sys-color-surface-container-highest)] px-1.5 py-0.5">{children}</kbd>
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`state-layer state-on-surface type-label-large relative rounded-full px-3 py-1 ${active ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]' : 'border border-[var(--md-sys-color-outline)]'}`}
    >
      {children}
    </button>
  )
}

/** Interactive legend for subtitle highlighting: live sample cues, a layer inspector and the reading rules. */
export function HighlightGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const samples = useMemo(() => SAMPLES.map(build), [])
  const [hoverLayer, setHoverLayer] = useState<Layer | null>(null)
  const [pinnedLayer, setPinnedLayer] = useState<Layer | null>(null)
  const [pick, setPick] = useState<Pick | null>(null)
  const [showPatterns, setShowPatterns] = useState(true)
  const [ankiMode, setAnkiMode] = useState<AnkiLabelMode>('unlearned')
  const [karaoke, setKaraoke] = useState(0.4)
  const [playing, setPlaying] = useState(false)
  const spot = hoverLayer ?? pinnedLayer

  useEffect(() => { if (open) localStorage.setItem(SEEN_KEY, '1') }, [open])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setKaraoke((k) => (k >= 1 ? 0 : Math.min(1, k + 0.02))), 60)
    return () => clearInterval(t)
  }, [playing])

  if (!open) return null

  const layersOf = (b: Built, t: { start: number; end: number }): Set<Layer> => {
    const out = new Set<Layer>()
    const chunk = b.chunks.find((c) => inside(t, { from: c.startChar, to: c.endChar }))
    if (chunk) out.add(chunk.kind)
    else if (showPatterns && b.patterns.some((p) => inside(t, p))) out.add('pattern')
    if (b.anki.some((a) => inside(t, a) && isLabelVisible(ankiMode, a.status))) out.add('anki')
    return out
  }

  const renderSample = (b: Built, si: number, karaokeValue?: number) => {
    const visibleAnki = b.anki.filter((a) => isLabelVisible(ankiMode, a.status))
    const tokens = tokenize(b.cue.text)
    const firstWord = new Map(visibleAnki.map((a) => [tokens.findIndex((t) => t.isWord && inside(t, a)), labelText(a.translation)]))
    const selected = pick?.sample === si ? pick.range : null
    const decorate = (t: { start: number; end: number }, i: number) => {
      const layers = layersOf(b, t)
      const anki = layers.has('anki') ? ankiTokenDecor(firstWord.get(i)) : undefined
      const style: CSSProperties = {
        ...anki?.style,
        ...(layers.has('pattern') && PATTERN_UNDERLINE),
        ...(spot && !layers.has(spot) && { opacity: 0.25 }),
        ...(selected && inside(t, selected) && { background: 'color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent)' }),
      }
      return { style, label: anki?.label }
    }
    const onPick = (p: SpanPick) => {
      const range = { from: tokens[p.tokenStart].start, to: tokens[p.tokenEnd].end }
      const chunk = p.tokenStart === p.tokenEnd ? b.chunks.find((c) => inside(tokens[p.tokenStart], { from: c.startChar, to: c.endChar })) : undefined
      setPick({ sample: si, range: chunk ? { from: chunk.startChar, to: chunk.endChar } : range, text: p.span })
    }
    return (
      <span className={visibleAnki.length > 0 ? 'block pt-5' : undefined}>
        <CueText cue={b.cue} chunks={b.chunks} karaoke={karaokeValue} onPick={onPick} decorate={decorate} />
      </span>
    )
  }

  const inspector = () => {
    if (!pick) {
      return <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">Нажми на любое слово в примере или протяни мышью по нескольким словам — здесь появится разбор всех слоёв подсветки.</p>
    }
    const b = samples[pick.sample]
    const rows: ReactNode[] = []
    for (const c of b.chunks) {
      if (!overlaps(pick.range, { from: c.startChar, to: c.endChar })) continue
      rows.push(
        <li key={`c${c.startChar}`} className="flex gap-3">
          <span className="mt-2 size-3 shrink-0 rounded-full" style={{ background: kindColor(c.kind) }} />
          <span><b>{KIND_TITLE[c.kind]}</b> «{c.text}» — {c.ru}</span>
        </li>,
      )
    }
    for (const p of b.patterns) {
      if (!overlaps(pick.range, p)) continue
      const pat = patternById(p.id)
      if (!pat) continue
      rows.push(
        <li key={`p${p.id}`} className="flex gap-3">
          <span className="mt-2 size-3 shrink-0 rounded-full" style={{ background: 'var(--app-kind-grammar)' }} />
          <span>
            <b>Тема грамматики</b> {pat.label} · {pat.formula} · {pat.level}
            {!showPatterns && <span className="text-[var(--md-sys-color-on-surface-variant)]"> (сейчас скрыта: «Конструкции» выключены)</span>}
          </span>
        </li>,
      )
    }
    for (const a of b.anki) {
      if (!overlaps(pick.range, a)) continue
      const vis = isLabelVisible(ankiMode, a.status)
      rows.push(
        <li key={`a${a.from}`} className="flex gap-3">
          <span className="mt-2 size-3 shrink-0 rounded-full" style={{ background: 'var(--app-anki-label)' }} />
          <span>
            <b>Карточка Anki</b> «{b.cue.text.slice(a.from, a.to)}» — {a.translation}, статус «{STATUS_RU[a.status]}»
            {!vis && <span className="text-[var(--md-sys-color-on-surface-variant)]"> — в этом режиме подписей не видна</span>}
          </span>
        </li>,
      )
    }
    return (
      <div className="flex flex-col gap-2">
        <div className="type-title-medium">«{b.cue.text.slice(pick.range.from, pick.range.to)}»</div>
        {rows.length > 0 ? (
          <ul className="type-body-medium flex flex-col gap-1.5">{rows}</ul>
        ) : (
          <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">Без подсветки: обычное слово твоего уровня. В фильме клик всё равно откроет перевод и разбор.</p>
        )}
        <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">В фильме такой клик ставит видео на паузу и открывает окно: перевод в контексте, озвучка, «Все значения», кнопки «В Anki» и «Спросить».</p>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[190] flex items-center justify-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_55%,transparent)]" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-label="Как читать подсветку" className="md-pop flex max-h-[90vh] w-[1040px] max-w-[96vw] flex-col bg-[var(--md-sys-color-surface-container-high)]" style={{ borderRadius: 'var(--md-sys-shape-corner-extra-large)' }}>
        <div className="flex items-center justify-between px-6 pb-2 pt-5">
          <div>
            <h2 className="type-headline-small">Как читать подсветку</h2>
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">Цвет линии говорит, что это за выражение. Тип линии говорит, откуда разметка: сплошная от разбора фразы, двойная от каталога грамматики, пунктир от твоей колоды Anki.</p>
          </div>
          <IconButton icon="close" label="Закрыть" onClick={onClose} />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px] gap-6 overflow-y-auto px-6 pb-6">
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-5 rounded-[var(--md-sys-shape-corner-large)] bg-black px-6 py-6 text-center">
              {samples.map((b, si) => {
                const pats = showPatterns ? b.patterns.map((p) => patternById(p.id)).filter((p) => !!p) : []
                return (
                  <div key={si}>
                    {pats.length > 0 && (
                      <div className="mb-2 flex flex-wrap justify-center gap-2">
                        {pats.map((p) => (
                          <PatternChip key={p.id} onClick={() => setPinnedLayer((l) => (l === 'pattern' ? null : 'pattern'))}>{p.label} · {p.formula}</PatternChip>
                        ))}
                      </div>
                    )}
                    <div className="type-headline-medium text-[var(--md-sys-color-on-surface)]">{renderSample(b, si)}</div>
                    <div className="type-body-large mt-1 text-[var(--md-sys-color-on-surface-variant)]">{b.ru}</div>
                  </div>
                )
              })}
            </div>

            <div className="rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container)] p-4">
              <div className="type-label-large mb-2 text-[var(--md-sys-color-primary)]">Разбор</div>
              {inspector()}
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="type-label-large w-32">Конструкции <Kbd>P</Kbd></span>
                <Chip active={showPatterns} onClick={() => setShowPatterns((v) => !v)}>{showPatterns ? 'Вкл' : 'Выкл'}</Chip>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="type-label-large w-32">Подписи Anki</span>
                {ANKI_MODES.map((m) => <Chip key={m.mode} active={ankiMode === m.mode} onClick={() => setAnkiMode(m.mode)}>{m.label}</Chip>)}
              </div>
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">«Только новые» подписывает карточки new и learning, «Все невыученные» добавляет young, трудные и пиявки. В примере bailed on имеет статус «молодое», поэтому в режиме «Только новые» подпись пропадает.</p>
            </div>

            <div className="rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container)] p-4">
              <div className="type-label-large mb-2 text-[var(--md-sys-color-primary)]">Уже произнесённое</div>
              <p className="type-body-medium mb-3">Слова загораются по мере того, как их произносят, остальные приглушены. Так подсвечиваются и субтитры на видео, и активная реплика в «Диалогах». В режиме «Скрывать субтитры» текст появляется только по <Kbd>A</Kbd>: фильм отмотается на 5 секунд и покажет фразу.</p>
              <div className="rounded-[var(--md-sys-shape-corner-medium)] bg-black px-4 py-3 text-center">
                <div className="type-title-large">{renderSample(samples[1], 1, karaoke)}</div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <IconButton icon={playing ? 'pause' : 'play_arrow'} label={playing ? 'Пауза' : 'Проиграть'} onClick={() => setPlaying((v) => !v)} />
                <input type="range" min={0} max={1} step={0.01} value={karaoke} onChange={(e) => { setPlaying(false); setKaraoke(Number(e.target.value)) }} className="flex-1 accent-[var(--md-sys-color-primary)]" aria-label="Сколько фразы уже произнесено" />
              </div>
            </div>
          </section>

          <aside className="flex flex-col gap-1">
            <div className="type-label-large px-3 pb-1 text-[var(--md-sys-color-on-surface-variant)]">Наведи на пункт, чтобы выделить его в примере. Клик закрепляет выделение.</div>
            {LEGEND.map((l) => {
              const active = spot === l.layer
              return (
                <button
                  key={l.layer}
                  type="button"
                  onMouseEnter={() => setHoverLayer(l.layer)}
                  onMouseLeave={() => setHoverLayer(null)}
                  onFocus={() => setHoverLayer(l.layer)}
                  onBlur={() => setHoverLayer(null)}
                  onClick={() => setPinnedLayer((p) => (p === l.layer ? null : l.layer))}
                  aria-pressed={pinnedLayer === l.layer}
                  className={`state-layer state-on-surface relative flex flex-col gap-1 rounded-[var(--md-sys-shape-corner-medium)] px-3 py-2 text-left ${active ? 'bg-[var(--md-sys-color-surface-container-highest)]' : ''}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="type-title-small">{l.title}</span>
                    <span className="type-title-medium" style={l.style}>{l.sample}</span>
                  </span>
                  <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{l.read}</span>
                </button>
              )
            })}

            <div className="mt-3 flex flex-col gap-2 rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container)] p-4">
              <div className="type-label-large text-[var(--md-sys-color-primary)]">Как читать вместе</div>
              <ul className="type-body-small flex list-disc flex-col gap-1.5 pl-4">
                <li>Слои накладываются. Пунктир Anki лежит под цветной линией: в bailed on это фразовый глагол, и он же есть в твоей колоде.</li>
                <li>Цветная линия важнее двойной. В «have to make» двойная линия стоит только под have to, потому что make входит в make a decision.</li>
                <li>Подсвечено не всё подряд: только многословные выражения и слова выше твоего уровня, не больше 4 на реплику.</li>
                <li>При наведении на слово подсвечивается всё выражение. Клик по одному слову берёт его целиком.</li>
              </ul>
            </div>

            <div className="mt-3 flex flex-col gap-2 rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container)] p-4">
              <div className="type-label-large text-[var(--md-sys-color-primary)]">Действия в фильме</div>
              <ul className="type-body-small flex flex-col gap-1.5">
                <li><Icon name="mouse" size={16} /> Клик по слову: пауза и разбор. Протянуть мышью: разбор своего куска фразы.</li>
                <li><Icon name="menu" size={16} /> В «Диалогах» наведение сразу показывает перевод. Полоса под активной репликой показывает, сколько она ещё будет в фокусе.</li>
                <li><Kbd>P</Kbd> конструкции, <Kbd>E</Kbd> / <Kbd>T</Kbd> английский и русский текст, <Kbd>S</Kbd> диалоги, <Kbd>R</Kbd> повтор, <Kbd>←</Kbd> <Kbd>→</Kbd> соседняя реплика, <Kbd>H</Kbd> эта справка, <Kbd>C</Kbd> чат с агентом.</li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
