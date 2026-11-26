import { useState, type RefObject } from 'react'
import { Icon, IconButton, Kbd, TextField } from '@tomato1337/m3e-react'
import type { SystemInfo } from '@/common/types/ipc'
import { NAV_GROUPS, SECTION_META, type NavSection, type SettingsSection } from '../lib/sections'

export type NavAlert = { kind: 'count'; count: number } | { kind: 'warning' }

export function SettingsNav({
  active,
  query,
  onQueryChange,
  onSelectSection,
  onSubmitSearch,
  alerts,
  changedBySection,
  systemInfo,
  searchInputRef,
}: {
  active: SettingsSection
  query: string
  onQueryChange: (q: string) => void
  onSelectSection: (section: SettingsSection) => void
  onSubmitSearch?: () => void
  alerts: Partial<Record<NavSection, NavAlert>>
  changedBySection: Partial<Record<NavSection, number>>
  systemInfo?: SystemInfo
  searchInputRef: RefObject<HTMLInputElement | null>
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const searching = query.trim().length > 0

  const activeMeta =
    active === 'overview'
      ? { icon: 'dashboard', label: 'Обзор' }
      : { icon: SECTION_META[active].icon, label: SECTION_META[active].label }

  let totalAlertCount = 0
  let hasWarningAlert = false
  for (const alert of Object.values(alerts)) {
    if (alert?.kind === 'count') totalAlertCount += alert.count
    else if (alert?.kind === 'warning') hasWarningAlert = true
  }

  const pickSection = (id: SettingsSection) => {
    setMobileOpen(false)
    onSelectSection(id)
  }

  const renderItem = (id: SettingsSection, icon: string, label: string) => {
    const selected = !searching && active === id
    const alert = id === 'overview' ? undefined : alerts[id]
    const dirtyCount = id === 'overview' ? 0 : (changedBySection[id] ?? 0)
    return (
      <button
        key={id}
        type="button"
        aria-current={selected ? 'page' : undefined}
        onClick={() => pickSection(id)}
        className={`state-layer state-on-surface relative flex min-h-11 w-full items-center gap-3 rounded-full py-2 pr-3 pl-4 text-left transition-colors ${
          selected
            ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
            : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)]'
        }`}
      >
        <Icon name={icon} size={22} fill={selected} />
        <span className={`type-label-large min-w-0 flex-1 truncate ${selected ? 'type-emph' : ''}`}>{label}</span>
        {dirtyCount > 0 && (
          <span
            aria-label={`Несохранённых изменений: ${dirtyCount}`}
            title={`Несохранённых изменений: ${dirtyCount}`}
            className="size-2 shrink-0 rounded-full bg-[var(--md-sys-color-primary)]"
          />
        )}
        {alert?.kind === 'warning' && (
          <span aria-label="Требует внимания" className="size-2 shrink-0 rounded-full bg-[var(--app-warning)]" />
        )}
        {alert?.kind === 'count' && (
          <span className="type-label-small flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--md-sys-color-error)] px-1.5 text-[var(--md-sys-color-on-error)]">
            {alert.count}
          </span>
        )}
      </button>
    )
  }

  return (
    <aside
      aria-label="Разделы настроек"
      className="stats-scroll w-full shrink-0 rounded-[28px] bg-[var(--md-sys-color-surface-container-low)] p-3 md:sticky md:top-[84px] md:max-h-[calc(100vh-108px)] md:w-[248px] md:self-start md:overflow-y-auto xl:w-[264px] 2xl:w-[280px]"
    >
      <div className="flex flex-wrap items-center gap-2 md:block">
        <button
          type="button"
          aria-expanded={mobileOpen}
          aria-controls="settings-nav-drawer"
          onClick={() => setMobileOpen((v) => !v)}
          className="state-layer state-on-surface relative flex min-h-10 shrink-0 items-center gap-2 rounded-full bg-[var(--md-sys-color-secondary-container)] px-3.5 py-2 text-[var(--md-sys-color-on-secondary-container)] md:hidden"
        >
          <Icon name={activeMeta.icon} size={20} fill />
          <span className="type-label-large type-emph max-w-[160px] truncate">{activeMeta.label}</span>
          {totalAlertCount > 0 && (
            <span className="type-label-small flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--md-sys-color-error)] px-1.5 text-[var(--md-sys-color-on-error)]">
              {totalAlertCount}
            </span>
          )}
          {totalAlertCount === 0 && hasWarningAlert && (
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--app-warning)]" />
          )}
          <Icon name={mobileOpen ? 'expand_less' : 'expand_more'} size={20} />
        </button>

        <div className="min-w-[160px] flex-1 md:mb-2">
          <TextField
            ref={searchInputRef}
            variant="pill"
            aria-label="Найти настройку"
            placeholder="Найти настройку"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                onQueryChange('')
              } else if (e.key === 'Enter' && query.trim()) {
                e.preventDefault()
                setMobileOpen(false)
                onSubmitSearch?.()
              }
            }}
            className={!query ? '[--m3e-input-trailing-pad:14px] xl:[--m3e-input-trailing-pad:68px]' : undefined}
            leading={<Icon name="search" size={20} />}
            trailing={
              query ? (
                <IconButton icon="close" label="Очистить поиск" size="sm" onClick={() => onQueryChange('')} />
              ) : (
                <span className="pointer-events-none hidden pr-1.5 xl:inline-flex">
                  <Kbd size="sm">Ctrl+K</Kbd>
                </span>
              )
            }
          />
        </div>
      </div>

      <div id="settings-nav-drawer" className={mobileOpen ? 'mt-2 block' : 'hidden md:block'}>
        <nav className="flex flex-col gap-0.5">
          {renderItem('overview', 'dashboard', 'Обзор')}

          {NAV_GROUPS.map((grp) => (
            <div key={grp.group} className="mt-2 flex flex-col gap-0.5">
              <span className="type-label-medium type-emph px-4 py-1 text-[var(--md-sys-color-primary)]">
                {grp.group}
              </span>
              {grp.items.map((id) => {
                const meta = SECTION_META[id]
                return renderItem(id, meta.icon, meta.label)
              })}
            </div>
          ))}
        </nav>

        <div className="my-2 h-px bg-[var(--md-sys-color-outline-variant)]" />

        <div className="type-body-small flex flex-col gap-0.5 px-4 pb-1 text-[var(--md-sys-color-on-surface-variant)]">
          <span className="truncate">
            {systemInfo?.version ? `Smart Subtitles ${systemInfo.version}` : 'Smart Subtitles'}
          </span>
          <span className="truncate font-mono text-[11px]">{systemInfo?.configDir ?? '~/.config/smart-subtitle'}</span>
        </div>
      </div>
    </aside>
  )
}
