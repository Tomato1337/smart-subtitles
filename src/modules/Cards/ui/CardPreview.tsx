import { useMemo, useState } from 'react'
import { Segmented } from '@/common/ui/Segmented'
import { Switch } from '@/common/ui/Switch'
import type { CardPreview as CardPreviewData } from '@/common/types/ipc'
import { renderCard } from '../lib/ankiTemplate'

/** The note type's own palette (tutor's card.css): the frame around the card must match it, not the app. */
const CARD_BG = { light: '#f8f9fa', night: '#1a1a2e' }

const EXTRA_CSS = `
html, body { margin: 0; min-height: 100%; }
.card { min-height: 100vh; box-sizing: border-box; }
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

const SIDES = [
  { value: 'front', label: 'Лицо' },
  { value: 'back', label: 'Обратная сторона' },
] as const

/** One card as Anki will show it: the note type's template and CSS, the draft's values. */
export function CardPreview({ preview }: { preview: CardPreviewData }) {
  const [side, setSide] = useState<'front' | 'back'>('front')
  const [night, setNight] = useState(false)
  const front = useMemo(() => renderCard(preview.noteType.front, preview.values, 'front'), [preview])
  const back = useMemo(() => renderCard(preview.noteType.back, preview.values, 'back', front), [preview, front])
  const srcDoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'">` +
    `<style>${preview.noteType.css}${EXTRA_CSS}</style></head>` +
    `<body style="background:${night ? CARD_BG.night : CARD_BG.light}">` +
    `<div class="card${night ? ' night_mode' : ''}">${side === 'front' ? front : back}</div></body></html>`

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={side} options={SIDES} onChange={setSide} label="Сторона карточки" />
        <Switch label="Ночной режим" checked={night} onChange={setNight} />
      </div>
      <iframe
        title="Предпросмотр карточки"
        sandbox=""
        srcDoc={srcDoc}
        className="h-[520px] w-full rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface)]"
      />
      <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
        {preview.noteType.name}
        {preview.noteType.exists ? '' : ' — в Anki этого типа ещё нет, показан встроенный шаблон'}
      </p>
    </div>
  )
}
