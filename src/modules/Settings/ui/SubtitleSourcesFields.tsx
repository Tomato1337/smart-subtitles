import type { SubtitleSource } from '@/common/types/ipc'
import { IconButton } from '@/common/ui/IconButton'
import { Switch } from '@/common/ui/Switch'

const SOURCES: [SubtitleSource, string, string][] = [
 ['torrserver', 'TorrServer', 'Файлы субтитров внутри раздачи'],
 ['sidecar', 'Субтитры из Lampa', 'Файлы, которые Lampa передала вместе с видео'],
 ['embedded', 'Встроенные в видео', 'Дорожка внутри видео; из TorrServer докачиваются части файла, с диска читается сразу'],
 ['opensubtitles', 'OpenSubtitles', 'Поиск по фильму; скачивание тратит дневной лимит'],
]

const INFO = new Map(SOURCES.map(([id, title, hint]) => [id, { title, hint }]))

/**
 * Order of the automatic subtitle search: the enabled sources in their order, then every other
 * source below with its switch off. The first enabled source that finds anything wins.
 */
export function SubtitleSourcesFields({ sources, onChange }: { sources: SubtitleSource[]; onChange: (s: SubtitleSource[]) => void }) {
 const rows: SubtitleSource[] = [
  ...sources.filter((id) => INFO.has(id)),
  ...SOURCES.map(([id]) => id).filter((id) => !sources.includes(id)),
 ]

 const move = (id: SubtitleSource, step: number) => {
  const from = sources.indexOf(id)
  const to = from + step
  if (from < 0 || to < 0 || to >= sources.length) {
   return
  }
  const next = [...sources]
   ;[next[from], next[to]] = [next[to], next[from]]
  onChange(next)
 }

 return (
  <div className="flex flex-col gap-2">
   {rows.map((id) => {
    const pos = sources.indexOf(id)
    const on = pos >= 0
    const { title, hint } = INFO.get(id) ?? { title: id, hint: '' }
    return (
     <div
      key={id}
      className={`flex items-center gap-2 rounded-[var(--md-sys-shape-corner-small)] px-3 py-2 ${on ? 'bg-[var(--md-sys-color-secondary-container)]' : 'bg-[var(--md-sys-color-surface-container-high)]'}`}
     >
      <span className="type-label-large w-4 shrink-0 text-center text-[var(--md-sys-color-on-surface-variant)]">{on ? pos + 1 : ''}</span>
      <span className="flex min-w-0 flex-1 flex-col">
       <span className="type-body-medium">{title}</span>
       <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{hint}</span>
      </span>
      <IconButton
       icon="arrow_upward"
       label={`${title}: выше`}
       tipPos="left"
       disabled={!on || pos === 0}
       onClick={() => move(id, -1)}
       className="size-8 disabled:opacity-30"
      />
      <IconButton
       icon="arrow_downward"
       label={`${title}: ниже`}
       tipPos="left"
       disabled={!on || pos === sources.length - 1}
       onClick={() => move(id, 1)}
       className="size-8 disabled:opacity-30"
      />
      <Switch
       ariaLabel={title}
       checked={on}
       onChange={(v) => onChange(v ? [...sources, id] : sources.filter((s) => s !== id))}
      />
     </div>
    )
   })}
   {sources.length === 0 && (
    <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Автопоиск выключен: субтитры можно выбрать в плеере</p>
   )}
  </div>
 )
}
