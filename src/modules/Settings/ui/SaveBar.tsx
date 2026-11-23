import { Button, Icon } from '@tomato1337/m3e-react'

/**
 * Floating action bar that appears when the draft differs from `config.json`.
 * Mounted inside `<Presence>` and exits cleanly via `.m3e-motion-rise`.
 */
export function SaveBar({
  count,
  restartRequired,
  saving,
  onDiscard,
  onSave,
}: {
  count: number
  restartRequired: boolean
  saving: boolean
  onDiscard: () => void
  onSave: () => void
}) {
  return (
    <div className="m3e-motion-rise pointer-events-none fixed inset-x-4 bottom-5 z-30 flex justify-center">
      <div
        data-app-savebar=""
        role="region"
        aria-label="Несохранённые изменения"
        className="pointer-events-auto flex w-full max-w-[760px] flex-wrap items-center gap-3 rounded-full bg-[var(--md-sys-color-inverse-surface)] py-2 pr-2 pl-5 text-[var(--md-sys-color-inverse-on-surface)] shadow-[var(--md-sys-elevation-level2)]"
      >
        <Icon name="edit_note" size={24} />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="type-title-small type-emph">Несохранённые изменения: {count}</span>
          <span className="type-body-medium opacity-70">
            · Ctrl+S{restartRequired ? ' · нужен перезапуск для порта' : ''}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="text"
            disabled={saving}
            onClick={onDiscard}
            style={{ color: 'var(--md-sys-color-inverse-primary)' }}
          >
            Отменить
          </Button>
          <Button
            variant="filled"
            icon="check"
            disabled={saving}
            onClick={onSave}
            style={{
              backgroundColor: 'var(--md-sys-color-inverse-primary)',
              color: 'var(--md-sys-color-inverse-surface)',
            }}
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  )
}
