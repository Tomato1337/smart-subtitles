import { useMemo, useState, type ReactNode } from 'react'
import { Segmented, Switch } from '@tomato1337/m3e-react'
import type { CardPreview as CardPreviewData } from '@/common/types/ipc'
import { renderCard } from '../lib/ankiTemplate'

export const CARD_PREVIEW_HEIGHT = 520

/** The note type's own palette (tutor's card.css): the frame around the card must match it, not the app. */
const CARD_BG = { light: '#f8f9fa', night: '#1a1a2e' }

const EXTRA_CSS = `
html, body { margin: 0; }
.card { padding: 16px; box-sizing: border-box; }
.ss-ph {
  margin: 12px auto;
  max-width: 320px;
  padding: 24px 12px;
  border: 2px dashed #b9bcc4;
  border-radius: 12px;
  color: #7a7f88;
  font-size: 14px;
}
.night_mode .ss-ph { border-color: #3a3f4a; color: #8a8f98; }
.ss-sound { font-size: 1.1em; }
img { max-width: 100%; height: auto; }
`

export type CardPreviewProps = {
  preview: CardPreviewData
  night?: boolean
  onNightChange?: (v: boolean) => void
  toolbarEnd?: ReactNode
  segmentedSize?: 'xs' | 'sm'
}

/** One card as Anki will show it: the note type's template and CSS, the draft's values. */
export function CardPreview({
  preview,
  night: controlledNight,
  onNightChange,
  toolbarEnd,
  segmentedSize = 'sm',
}: CardPreviewProps) {
  const [side, setSide] = useState<'front' | 'back'>('front')
  const [internalNight, setInternalNight] = useState(false)
  const isControlled = onNightChange !== undefined
  const night = controlledNight ?? internalNight
  const setNight = onNightChange ?? setInternalNight
  const front = useMemo(() => renderCard(preview.noteType.front, preview.values, 'front'), [preview])
  const back = useMemo(() => renderCard(preview.noteType.back, preview.values, 'back', front), [preview, front])
  const sideOptions = useMemo(
    () => [
      { value: 'front' as const, label: 'Лицо', icon: side === 'front' ? 'check' : undefined },
      { value: 'back' as const, label: 'Обратная сторона', icon: side === 'back' ? 'check' : undefined },
    ],
    [side],
  )
  const srcDoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'">` +
    `<style>${preview.noteType.css}${EXTRA_CSS}</style></head>` +
    `<body style="background:${night ? CARD_BG.night : CARD_BG.light};color:${night ? '#e6e1e5' : '#1a1a2e'};color-scheme:${night ? 'dark' : 'light'}">` +
    `<div class="card${night ? ' night_mode' : ''}">${side === 'front' ? front : back}</div></body></html>`

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          size={segmentedSize}
          value={side}
          options={sideOptions}
          onChange={setSide}
          label="Сторона карточки"
        />
        {isControlled ? toolbarEnd : <Switch label="Ночной режим" checked={night} onChange={setNight} />}
      </div>
      <iframe
        title="Предпросмотр карточки"
        sandbox=""
        srcDoc={srcDoc}
        height={CARD_PREVIEW_HEIGHT}
        className="w-full rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface)]"
      />
      <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
        {preview.noteType.name}
        {preview.noteType.exists ? '' : ' — в Anki этого типа ещё нет, показан встроенный шаблон'}
      </p>
    </div>
  )
}
