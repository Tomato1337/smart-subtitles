import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Button, Dialog, Icon, IconButton, Presence, Spinner, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig } from '@/common/types/ipc'
import { HOTKEY_ACTIONS } from '@/modules/Hotkeys'
import { NotificationHeaderButton } from '@/modules/Notifications'
import { SECTION_META, type NavSection, type SettingsSection } from '../lib/sections'
import { diffConfig, reconcileDraftAfterSave } from '../lib/settingsDiff'
import { hotkeyIndexItems, searchSettings } from '../lib/settingsIndex'
import { AnkiSection } from './AnkiSection'
import { CardPreviewDock } from './CardPreviewDock'
import { ImagesSection } from './ImagesSection'
import { KeysSection } from './KeysSection'
import { LampaSection } from './LampaSection'
import { LevelSection } from './LevelSection'
import { llmReady } from './LlmFields'
import { MediaSection } from './MediaSection'
import { ModelsSection } from './ModelsSection'
import { OverviewSection } from './OverviewSection'
import { SaveBar } from './SaveBar'
import { SearchResults } from './SearchResults'
import { SettingsNav, type NavAlert } from './SettingsNav'
import type { ApplyConfig } from './SettingsPrimitives'
import { SetupWizard } from './SetupWizard'
import { SubsSection } from './SubsSection'
import { SystemSection } from './SystemSection'

export type SettingsHubProps = {
  section: SettingsSection
  focus?: string
  onNavigateSection: (section: SettingsSection, focus?: string) => void
  onBack: () => void
  scrollContainerRef?: RefObject<HTMLDivElement | null>
}

/**
 * Full-page Settings Hub: sticky top bar, sticky left navigation with live Ctrl+K search,
 * 9 grouped sections plus Overview, sticky live Anki CardPreview dock, and floating SaveBar.
 */
export function SettingsHub({ section, focus, onNavigateSection, onBack, scrollContainerRef }: SettingsHubProps) {
  const qc = useQueryClient()
  const configQuery = useQuery({ queryKey: ['config'], queryFn: api.configGet })
  const providersQuery = useQuery({ queryKey: ['llm-providers'], queryFn: api.llmProviders })
  const systemQuery = useQuery({ queryKey: ['system-info'], queryFn: api.systemInfo })
  const ankiQuery = useQuery({ queryKey: ['anki-status'], queryFn: api.ankiStatus, retry: false, staleTime: 15_000 })
  const depsQuery = useQuery({ queryKey: ['deps'], queryFn: api.depsCheck, staleTime: Infinity })
  const monthlyQuery = useQuery({
    queryKey: ['llm-monthly-usage', 30],
    queryFn: () => api.llmMonthlyUsage(30),
    staleTime: 60_000,
  })

  const saved = configQuery.data
  const [draft, setDraft] = useState<AppConfig | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const [query, setQuery] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const activeDraft = draft ?? saved
  const diff = useMemo(
    () => (activeDraft && saved ? diffConfig(activeDraft, saved) : { dirty: false, count: 0, changedKeys: new Set<string>(), changedBySection: {}, restartRequired: false }),
    [activeDraft, saved],
  )

  const dirtyRef = useRef(diff.dirty)
  dirtyRef.current = diff.dirty

  const shouldBlockFn = useCallback<ShouldBlockFn>(({ next }) => {
    return dirtyRef.current && next.pathname !== '/settings'
  }, [])
  const enableBeforeUnload = useCallback(() => dirtyRef.current, [])

  const blocker = useBlocker({
    shouldBlockFn,
    withResolver: true,
    enableBeforeUnload,
  })

  useEffect(() => {
    if (blocker.status === 'blocked' && !diff.dirty) {
      blocker.proceed?.()
    }
  }, [blocker, diff.dirty])

  const save = useMutation({
    mutationFn: (cfgToSave: AppConfig) => api.configSave(cfgToSave),
    onSuccess: (restart, cfgToSave) => {
      const nextDraft = reconcileDraftAfterSave(draftRef.current, cfgToSave)
      dirtyRef.current = nextDraft !== null
      qc.setQueryData(['config'], cfgToSave)
      setDraft((cur) => reconcileDraftAfterSave(cur, cfgToSave))
      toast(restart ? 'Сохранено. Новый порт заработает после перезапуска приложения' : 'Настройки сохранены')
      void qc.invalidateQueries({ queryKey: ['config'] })
      void qc.invalidateQueries({ queryKey: ['llm-providers'] })
      void qc.invalidateQueries({ queryKey: ['setup'] })
      void qc.invalidateQueries({ queryKey: ['system-info'] })
      void qc.invalidateQueries({ queryKey: ['anki-status'] })
    },
    onError: (e) => notify('error', errorText(e)),
  })

  const set: ApplyConfig = useCallback(
    (sec, patch) => {
      setDraft((cur) => {
        const base = cur ?? saved
        if (!base) return cur
        return { ...base, [sec]: { ...base[sec], ...patch } }
      })
    },
    [saved],
  )

  const discard = useCallback(() => {
    dirtyRef.current = false
    setDraft(null)
  }, [])

  const handleBack = useCallback(() => {
    if (diff.dirty) setLeaveConfirmOpen(true)
    else onBack()
  }, [diff.dirty, onBack])

  // Global shortcuts inside Settings Hub: Ctrl+K focuses search, Ctrl+S saves dirty draft.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.code === 'KeyK') {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      } else if (e.code === 'KeyS') {
        e.preventDefault()
        if (diff.dirty && !save.isPending && activeDraft) {
          save.mutate(activeDraft)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [diff.dirty, save, activeDraft])

  // Scroll to top when entering search from empty so results start cleanly at the top.
  const wasSearchingRef = useRef(false)
  useEffect(() => {
    const isSearching = query.trim().length > 0
    if (!wasSearchingRef.current && isSearching) {
      scrollContainerRef?.current?.scrollTo({ top: 0 })
    }
    wasSearchingRef.current = isSearching
  }, [query, scrollContainerRef])

  // Scroll to anchored setting when `?focus=` changes, without re-scrolling on draft edits.
  const ready = Boolean(activeDraft)
  const lastScrolledRef = useRef<string | null>(null)
  const prevQueryRef = useRef(query)
  useEffect(() => {
    const queryChanged = prevQueryRef.current !== query
    prevQueryRef.current = query
    if (queryChanged) lastScrolledRef.current = null
    if (!focus) {
      lastScrolledRef.current = null
      return
    }
    if (query.trim() || !ready) return
    const key = `${section}:${focus}`
    if (lastScrolledRef.current === key) return
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focus)}"]`)
      if (!el) return
      lastScrolledRef.current = key
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
    })
    return () => cancelAnimationFrame(raf)
  }, [section, focus, query, ready])

  const alerts = useMemo<Partial<Record<NavSection, NavAlert>>>(() => {
    const out: Partial<Record<NavSection, NavAlert>> = {}
    if (!activeDraft) return out
    if (!llmReady(activeDraft.llm, providersQuery.data)) out.models = { kind: 'count', count: 1 }
    if (!activeDraft.opensubtitles.apiKey.trim()) out.subs = { kind: 'warning' }
    if (ankiQuery.data && (!ankiQuery.data.ok || ankiQuery.data.queuedCards > 0)) out.anki = { kind: 'warning' }
    if (activeDraft.lampa.origins.length === 0) out.lampa = { kind: 'warning' }
    const missingReqDeps = depsQuery.data?.deps.filter((d) => d.importance === 'required' && !d.found).length ?? 0
    if (missingReqDeps > 0) out.system = { kind: 'count', count: missingReqDeps }
    return out
  }, [activeDraft, providersQuery.data, ankiQuery.data, depsQuery.data])

  const searching = query.trim().length > 0
  const showPreview = !searching && (section === 'anki' || section === 'media' || section === 'images')
  const leaveDialogOpen = leaveConfirmOpen || (blocker.status === 'blocked' && diff.dirty)

  const selectSection = (next: SettingsSection, nextFocus?: string) => {
    setQuery('')
    if (!nextFocus && next === section) {
      scrollContainerRef?.current?.scrollTo({ top: 0 })
    }
    onNavigateSection(next, nextFocus)
  }

  const submitFirstSearch = () => {
    const first = searchSettings(query, hotkeyIndexItems(HOTKEY_ACTIONS))[0]
    if (first) selectSection(first.section, first.id)
  }

  const breadcrumb = !searching && section !== 'overview' ? SECTION_META[section].label : null

  return (
    <div className="min-h-full bg-[var(--md-sys-color-surface)] text-[var(--md-sys-color-on-surface)]">
      <header
        data-app-topbar=""
        className="sticky top-0 z-20 border-b border-[var(--md-sys-color-outline-variant)]/50 bg-[color-mix(in_srgb,var(--md-sys-color-surface)_92%,transparent)] backdrop-blur-md"
      >
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-6 py-3.5">
          <IconButton icon="arrow_back" label="Назад" variant="tonal" size="lg" onClick={handleBack} />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="type-headline-medium type-emph">Настройки</h1>
            {breadcrumb && (
              <>
                <Icon name="chevron_right" size={22} className="shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
                <span className="type-headline-small truncate text-[var(--md-sys-color-on-surface-variant)]">
                  {breadcrumb}
                </span>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="tonal" size="sm" icon="auto_fix_high" onClick={() => setWizardOpen(true)}>
              Мастер настройки
            </Button>
            <NotificationHeaderButton size="md" />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-6 pt-5 pb-32">
        {configQuery.error ? (
          <div className="rounded-[24px] bg-[var(--md-sys-color-error-container)] p-6 text-[var(--md-sys-color-on-error-container)]">
            <p className="type-title-medium type-emph">Не удалось загрузить настройки</p>
            <p className="type-body-medium mt-1">{errorText(configQuery.error)}</p>
          </div>
        ) : !activeDraft ? (
          <div className="flex justify-center py-20">
            <Spinner label="Загружаю настройки" />
          </div>
        ) : (
          <div
            className={`grid grid-cols-1 gap-6 ${
              showPreview
                ? 'md:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)_400px] 2xl:grid-cols-[280px_minmax(0,1fr)_440px]'
                : 'md:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)] 2xl:grid-cols-[280px_minmax(0,1fr)]'
            }`}
          >
            <SettingsNav
              active={section}
              query={query}
              onQueryChange={setQuery}
              onSelectSection={(sec) => selectSection(sec)}
              onSubmitSearch={submitFirstSearch}
              alerts={alerts}
              changedBySection={diff.changedBySection}
              systemInfo={systemQuery.data}
              searchInputRef={searchInputRef}
            />

            <main className={showPreview ? 'min-w-0' : 'min-w-0 max-w-[920px]'}>
              {searching ? (
                <SearchResults
                  query={query}
                  statusCtx={{
                    cfg: activeDraft,
                    providers: providersQuery.data,
                    ankiStatus: ankiQuery.data,
                    systemInfo: systemQuery.data,
                    deps: depsQuery.data,
                  }}
                  onSelect={(sec, id) => selectSection(sec, id)}
                  onClear={() => setQuery('')}
                />
              ) : section === 'overview' ? (
                <OverviewSection
                  cfg={activeDraft}
                  providers={providersQuery.data}
                  ankiStatus={ankiQuery.data}
                  ankiChecking={ankiQuery.isFetching}
                  onCheckAnki={() => void ankiQuery.refetch()}
                  systemInfo={systemQuery.data}
                  deps={depsQuery.data}
                  monthlyUsage={monthlyQuery.data}
                  onJump={(sec, id) => selectSection(sec, id)}
                />
              ) : section === 'models' ? (
                <ModelsSection
                  cfg={activeDraft}
                  providers={providersQuery.data}
                  set={set}
                  changedKeys={diff.changedKeys}
                  focusId={focus}
                />
              ) : section === 'level' ? (
                <LevelSection cfg={activeDraft} set={set} changedKeys={diff.changedKeys} focusId={focus} />
              ) : section === 'subs' ? (
                <SubsSection cfg={activeDraft} set={set} changedKeys={diff.changedKeys} focusId={focus} />
              ) : section === 'anki' ? (
                <AnkiSection
                  cfg={activeDraft}
                  set={set}
                  ankiStatus={ankiQuery.data}
                  ankiChecking={ankiQuery.isFetching}
                  onCheckAnki={() => void ankiQuery.refetch()}
                  changedKeys={diff.changedKeys}
                  focusId={focus}
                />
              ) : section === 'media' ? (
                <MediaSection
                  cfg={activeDraft}
                  set={set}
                  deps={depsQuery.data}
                  changedKeys={diff.changedKeys}
                  focusId={focus}
                  onJump={(sec, id) => selectSection(sec, id)}
                />
              ) : section === 'images' ? (
                <ImagesSection
                  cfg={activeDraft}
                  set={set}
                  changedKeys={diff.changedKeys}
                  focusId={focus}
                  onJump={(sec, id) => selectSection(sec, id)}
                />
              ) : section === 'lampa' ? (
                <LampaSection
                  cfg={activeDraft}
                  set={set}
                  systemInfo={systemQuery.data}
                  changedKeys={diff.changedKeys}
                  focusId={focus}
                />
              ) : section === 'keys' ? (
                <KeysSection focusId={focus} />
              ) : (
                <SystemSection
                  cfg={activeDraft}
                  set={set}
                  systemInfo={systemQuery.data}
                  deps={depsQuery.data}
                  changedKeys={diff.changedKeys}
                  focusId={focus}
                  onOpenWizard={() => setWizardOpen(true)}
                />
              )}
            </main>

            {showPreview && (
              <div className="min-w-0 md:col-start-2 xl:col-start-3">
                <CardPreviewDock cfg={activeDraft} />
              </div>
            )}
          </div>
        )}
      </div>

      <Presence>
        {diff.dirty && activeDraft && (
          <SaveBar
            count={diff.count}
            restartRequired={diff.restartRequired}
            saving={save.isPending}
            onDiscard={discard}
            onSave={() => save.mutate(activeDraft)}
          />
        )}
      </Presence>

      <Presence>{wizardOpen && <SetupWizard onClose={() => setWizardOpen(false)} />}</Presence>

      <Presence>
        {leaveDialogOpen && (
          <Dialog
            onClose={() => {
              if (save.isPending) return
              setLeaveConfirmOpen(false)
              if (blocker.status === 'blocked') blocker.reset?.()
            }}
            dismissible={!save.isPending}
            aria-labelledby="leave-settings-title"
            className="w-[460px] max-w-[94vw]"
          >
            <h2 id="leave-settings-title" className="type-headline-small">
              Несохранённые изменения
            </h2>
            <p className="type-body-medium mt-2 text-[var(--md-sys-color-on-surface-variant)]">
              Изменено настроек: {diff.count}. Сохранить перед выходом?
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="text"
                disabled={save.isPending}
                onClick={() => {
                  discard()
                  setLeaveConfirmOpen(false)
                  if (blocker.status === 'blocked') blocker.proceed?.()
                  else onBack()
                }}
              >
                Выйти без сохранения
              </Button>
              <Button
                variant="tonal"
                data-autofocus
                disabled={save.isPending}
                onClick={() => {
                  setLeaveConfirmOpen(false)
                  if (blocker.status === 'blocked') blocker.reset?.()
                }}
              >
                Остаться
              </Button>
              {activeDraft && (
                <Button
                  variant="filled"
                  disabled={save.isPending}
                  onClick={() => {
                    save.mutate(activeDraft, {
                      onSuccess: () => {
                        setLeaveConfirmOpen(false)
                        if (blocker.status === 'blocked') blocker.proceed?.()
                        else onBack()
                      },
                    })
                  }}
                >
                  {save.isPending ? 'Сохраняю…' : 'Сохранить'}
                </Button>
              )}
            </div>
          </Dialog>
        )}
      </Presence>
    </div>
  )
}
