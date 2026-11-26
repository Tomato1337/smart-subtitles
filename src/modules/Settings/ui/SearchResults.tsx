import { useMemo } from 'react'
import { Button, Icon, Kbd, ListGroup } from '@tomato1337/m3e-react'
import { formatCountRu } from '@/common/utilities/pluralRu'
import { HOTKEY_ACTIONS } from '@/modules/Hotkeys'
import { hotkeyIndexItems, searchSettings, type SettingsIndexItem, type SettingsStatusContext } from '../lib/settingsIndex'
import type { NavSection } from '../lib/sections'
import { AppStatusChip } from './SettingsPrimitives'

export function SearchResults({
  query,
  statusCtx,
  onSelect,
  onClear,
}: {
  query: string
  statusCtx: SettingsStatusContext
  onSelect: (section: NavSection, focusId: string) => void
  onClear: () => void
}) {
  const hotkeyItems = useMemo(() => hotkeyIndexItems(HOTKEY_ACTIONS), [])
  const results = useMemo(() => searchSettings(query, hotkeyItems), [query, hotkeyItems])

  const grouped = useMemo(() => {
    const map = new Map<NavSection, { groupLabel: string; sectionLabel: string; items: SettingsIndexItem[] }>()
    for (const entry of results) {
      const existing = map.get(entry.section)
      if (existing) existing.items.push(entry)
      else map.set(entry.section, { groupLabel: entry.groupLabel, sectionLabel: entry.sectionLabel, items: [entry] })
    }
    return [...map.entries()]
  }, [results])

  const trimmed = query.trim()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="type-headline-small type-emph min-w-0 wrap-anywhere">
          {results.length > 0
            ? `«${trimmed}» — ${formatCountRu(results.length, 'настройка', 'настройки', 'настроек')} в ${formatCountRu(grouped.length, 'разделе', 'разделах', 'разделах')}`
            : `По запросу «${trimmed}» ничего не найдено`}
        </h2>
        <div className="flex items-center gap-2">
          <Kbd size="sm">Ctrl+K</Kbd>
          <Button variant="text" size="xs" onClick={onClear}>
            Сбросить
          </Button>
        </div>
      </div>

      {results.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-[24px] bg-[var(--md-sys-color-surface-container-low)] p-6">
          <p className="type-body-large text-[var(--md-sys-color-on-surface-variant)]">
            Попробуйте другое слово или путь конфига — например <code className="font-mono">anki.quickAdd</code>,{' '}
            <code className="font-mono">ключ</code>, <code className="font-mono">vaapi</code> или{' '}
            <code className="font-mono">диалоги</code>.
          </p>
          <Button variant="tonal" onClick={onClear}>
            Вернуться к настройкам
          </Button>
        </div>
      ) : (
        grouped.map(([section, group], gi) => (
          <section key={section} className="flex flex-col gap-2.5">
            <div>
              <h3 className="type-title-large type-emph">{group.sectionLabel}</h3>
              <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
                {group.groupLabel} › {group.sectionLabel}
              </p>
            </div>
            <ListGroup>
              {group.items.map((item, ii) => {
                const status = item.getStatus?.(statusCtx)
                const firstHit = gi === 0 && ii === 0
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.section, item.id)}
                    className={`state-layer state-on-surface relative flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors ${
                      firstHit
                        ? 'bg-[var(--md-sys-color-surface-container-high)] ring-2 ring-[var(--md-sys-color-primary)] ring-inset'
                        : 'bg-[var(--md-sys-color-surface-container)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="type-title-medium type-emph wrap-anywhere">{item.title}</span>
                        {item.configKey && (
                          <code className="type-label-small rounded-[var(--md-sys-shape-corner-extra-small)] bg-[var(--md-sys-color-surface-container-highest)] px-1.5 py-0.5 font-mono text-[var(--md-sys-color-on-surface-variant)]">
                            {item.configKey}
                          </code>
                        )}
                      </div>
                      <span className="type-body-medium wrap-anywhere text-[var(--md-sys-color-on-surface-variant)]">
                        {item.description}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {status && (
                        <AppStatusChip tone={status.tone} size="md" icon={status.icon}>
                          {status.label}
                        </AppStatusChip>
                      )}
                      <Icon name="chevron_right" size={20} className="text-[var(--md-sys-color-on-surface-variant)]" />
                    </div>
                  </button>
                )
              })}
            </ListGroup>
          </section>
        ))
      )}

      <div className="flex items-center gap-3 rounded-[20px] bg-[var(--md-sys-color-surface-container-low)] p-4 text-[var(--md-sys-color-on-surface-variant)]">
        <Icon name="lightbulb" size={22} className="shrink-0 text-[var(--md-sys-color-primary)]" />
        <span className="type-body-medium">
          Поиск идёт по названиям, описаниям и путям конфига — например <code className="font-mono">anki.quickAdd</code>.
        </span>
      </div>
    </div>
  )
}
