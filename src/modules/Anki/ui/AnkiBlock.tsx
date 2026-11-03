import type { AnkiEntry } from '@/common/types/ipc'
import { STATUS_RU } from '../store/ankiStore'

/** "В Anki" summary of a matched card (shown for every status, including learned). */
export function AnkiBlock({ entry }: { entry: AnkiEntry }) {
  return (
    <div className="type-body-small rounded-[var(--md-sys-shape-corner-small)] px-3 py-2" style={{ background: 'var(--app-anki-label-container)', color: 'var(--app-anki-on-label-container)' }}>
      <span className="type-label-medium">В Anki:</span> {entry.word}{entry.translation ? ` → ${entry.translation}` : ''} · {STATUS_RU[entry.status]}
      {entry.interval > 0 ? ` · интервал ${entry.interval} дн.` : ''}
    </div>
  )
}
