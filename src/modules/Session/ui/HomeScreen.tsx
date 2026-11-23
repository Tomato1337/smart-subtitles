import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button, Icon, IconButton, Presence, ShapeBadge, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText, type RecentMedia } from '@/common/api/tauri'
import { CardsActivityButton } from '@/modules/Cards'
import { NotificationHeaderButton } from '@/modules/Notifications'
import {
  formatRemainingMinutes,
  getSettingsAttentionLevel,
  greetingForHour,
  isMediaCompleted,
  pickDroppedVideoPath,
  pickHomeAttention,
  VIDEO_EXTENSIONS,
  type SettingsSection,
} from '../lib/homeHelpers'
import { formatTime } from '@/common/utilities/time'
import { useSessionStore } from '../store/sessionStore'
import { ContinueCard, OpeningCard, WelcomeCard } from './HeroCards'
import { RecentSection, type RecentViewMode } from './RecentSection'

const RECENT_VIEW_KEY = 'smartsubs.recentView'
const LAMPA_DISMISSED_KEY = 'smartsubs.dismissedLampaBanner'

function loadViewMode(): RecentViewMode {
  try {
    return localStorage.getItem(RECENT_VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function loadLampaDismissed(): boolean {
  try {
    return localStorage.getItem(LAMPA_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function HomeScreen({ onOpenWizard = () => {} }: { onOpenWizard?: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const loading = useSessionStore((s) => s.loading)
  const [view, setView] = useState<RecentViewMode>(loadViewMode)
  const [dragging, setDragging] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [lampaDismissed, setLampaDismissed] = useState(loadLampaDismissed)

  const recent = useQuery({ queryKey: ['recent'], queryFn: api.mediaRecent })
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setupStatus, staleTime: 30_000 })
  const deps = useQuery({ queryKey: ['deps'], queryFn: api.depsCheck, staleTime: Infinity })
  const anki = useQuery({ queryKey: ['anki-status'], queryFn: api.ankiStatus, staleTime: 30_000 })
  const systemInfo = useQuery({ queryKey: ['system-info'], queryFn: api.systemInfo, staleTime: 30_000 })

  const recentItems = recent.data ?? []
  const latest = recentItems[0]

  const navigateSettings = useCallback(
    (section?: SettingsSection) => {
      void navigate({
        to: '/settings',
        search: section ? { section } : undefined,
      })
    },
    [navigate],
  )

  const changeView = (next: RecentViewMode) => {
    setView(next)
    try {
      localStorage.setItem(RECENT_VIEW_KEY, next)
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }

  const dismissLampa = () => {
    setLampaDismissed(true)
    try {
      localStorage.setItem(LAMPA_DISMISSED_KEY, '1')
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }

  // TorrServer can take minutes on a dead torrent: closing the session cancels the probe and the load.
  const cancelOpen = () => {
    void api.sessionClose()
    useSessionStore.getState().setLoading(null)
  }

  const openPath = useCallback(
    async (path: string) => {
      try {
        await api.sessionOpenFile(path)
      } catch (e) {
        notify('error', errorText(e))
      }
      void qc.invalidateQueries({ queryKey: ['recent'] })
    },
    [qc],
  )

  const pickFile = async () => {
    if (!('__TAURI_INTERNALS__' in window)) {
      toast('Выбор файла доступен в приложении Smart Subtitles')
      return
    }
    try {
      const path = await open({ multiple: false, filters: [{ name: 'Видео', extensions: [...VIDEO_EXTENSIONS] }] })
      if (typeof path !== 'string') return
      await openPath(path)
    } catch (e) {
      notify('error', errorText(e))
    }
  }

  const reopen = (mediaId: string, fromStart?: boolean) => {
    setReopening(true)
    api
      .sessionReopen(mediaId, fromStart)
      .catch((e) => notify('error', errorText(e)))
      .finally(() => setReopening(false))
  }

  const resetAndReopen = (mediaId: string) => {
    api
      .mediaResetAnnot(mediaId)
      .then(() => api.sessionReopen(mediaId))
      .catch((e) => notify('error', errorText(e)))
  }

  // Tauri native drag-and-drop; strictly guarded so plain Chromium / Vite runs never fail.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let alive = true
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!alive) return
        const payload = event.payload
        if (payload.type === 'enter') {
          setDragging(pickDroppedVideoPath(payload.paths) !== null)
        } else if (payload.type === 'leave') {
          setDragging(false)
        } else if (payload.type === 'drop') {
          setDragging(false)
          const match = pickDroppedVideoPath(payload.paths)
          if (match) {
            void openPath(match)
          } else if (payload.paths.length > 0) {
            toast('Поддерживаются видеофайлы: mkv, mp4, avi, webm, mov')
          }
        }
      })
      .then((fn) => {
        if (alive) unlisten = fn
        else fn()
      })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [openPath])

  /**
   * Removes a film from the list at once and offers «Отменить»: the backend only hides the row
   * (`media.hidden`), so undo and reopening the film bring it back with its analysis and position.
   * Focus moves to the same control of the neighbouring row, otherwise it would fall to <body>.
   */
  const forget = (m: RecentMedia, from: HTMLElement) => {
    const li = from.closest('li')
    const next = li?.nextElementSibling ?? li?.previousElementSibling
    next?.querySelector<HTMLElement>(from.hasAttribute('data-forget') ? '[data-forget]' : '[data-reopen]')?.focus()
    qc.setQueryData<RecentMedia[]>(['recent'], (list) => list?.filter((x) => x.mediaId !== m.mediaId))
    const refresh = () => void qc.invalidateQueries({ queryKey: ['recent'] })
    const failed = (e: unknown) => {
      notify('error', errorText(e))
      refresh()
    }
    const hiding = api.mediaSetHidden(m.mediaId, true).then(refresh, failed)
    toast(`Удалено из недавних: «${m.title}»`, {
      durationMs: 6000,
      // After `hiding`: two invokes are not ordered, and the undo must be the last write.
      actions: [{ label: 'Отменить', run: () => { void hiding.then(() => api.mediaSetHidden(m.mediaId, false)).then(refresh, failed) } }],
    })
  }

  const settingsAttention = getSettingsAttentionLevel({
    deps: deps.data,
    setup: setup.data,
    anki: anki.data,
  })

  const banner = loading
    ? null
    : pickHomeAttention({
        deps: deps.data,
        setup: setup.data,
        anki: anki.data,
        systemInfo: systemInfo.data,
        hasRecent: recentItems.length > 0,
        lampaDismissed,
      })

  const showDropZone = !!loading || recentItems.length > 0 || recent.isError

  const renderSubtitle = () => {
    if (loading) {
      return loading.kind === 'lampa'
        ? 'Открываю фильм из Lampa. Можно отменить, если раздача не отвечает.'
        : 'Открываю видеофайл. Можно отменить, если подготовка затянулась.'
    }
    if (latest) {
      const greeting = greetingForHour(new Date().getHours())
      const completed = isMediaCompleted(latest.lastPosition, latest.duration)
      const tail = completed
        ? 'просмотрен — можно пересмотреть сначала.'
        : latest.lastPosition > 0 && latest.duration && latest.duration > latest.lastPosition
          ? `ждёт на ${formatTime(latest.lastPosition)} — осталось ${formatRemainingMinutes(latest.duration - latest.lastPosition)}.`
          : latest.lastPosition > 0
            ? `ждёт на ${formatTime(latest.lastPosition)}.`
            : 'готов к просмотру.'
      return (
        <>
          {greeting}{' '}
          <strong className="font-semibold text-[var(--md-sys-color-on-surface)]">«{latest.title}»</strong> {tail}
        </>
      )
    }
    return 'Английский по фильмам: двуязычные субтитры, разбор выражений и карточки Anki с клипами.'
  }

  const bannerStyles =
    banner?.tone === 'error'
      ? 'bg-[var(--md-sys-color-error-container)] text-[var(--md-sys-color-on-error-container)]'
      : banner?.tone === 'warning'
        ? 'bg-[var(--app-warning-container)] text-[var(--app-on-warning-container)]'
        : 'bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)]'

  return (
    <main className="mx-auto w-full max-w-[1088px] px-6 pt-10 pb-16">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="type-hero min-w-0 flex-1 truncate">Smart Subtitles</h1>

          <div className="flex shrink-0 items-center gap-2">
            <CardsActivityButton variant="home" />
            <NotificationHeaderButton />
            <span className="relative inline-flex shrink-0">
              <IconButton
                icon="settings"
                label={settingsAttention ? 'Настройки — требуется внимание' : 'Настройки'}
                variant="secondary"
                size="lg"
                tipPos="bottom"
                pressRadius="18px"
                onClick={() => navigateSettings()}
                style={{
                  '--m3e-icon-button-size': '56px',
                  '--m3e-icon-button-radius': '28px',
                } as CSSProperties}
              />
              {settingsAttention && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0.5 right-0.5 size-3 rounded-full ring-2 ring-[var(--md-sys-color-surface)]"
                  style={{
                    background: settingsAttention === 'error' ? 'var(--md-sys-color-error)' : 'var(--app-warning)',
                  }}
                />
              )}
            </span>
          </div>
        </div>

        <p className="type-body-large mt-2 text-[var(--md-sys-color-on-surface-variant)]">{renderSubtitle()}</p>
      </header>

      <div className="mt-7 flex flex-col gap-3">
        {loading ? (
          <OpeningCard key={loading.startedAt} loading={loading} onCancel={cancelOpen} />
        ) : recent.isPending && !recent.data ? (
          <div
            aria-hidden="true"
            className="h-[268px] animate-pulse rounded-[32px] bg-[var(--md-sys-color-surface-container)]"
          />
        ) : recent.isError ? (
          <section className="flex flex-wrap items-center justify-between gap-4 rounded-[32px] bg-[var(--md-sys-color-surface-container)] p-7">
            <div>
              <h2 className="type-title-large type-emph text-[var(--md-sys-color-on-surface)]">
                Не удалось загрузить недавние фильмы
              </h2>
              <p className="type-body-medium mt-1 text-[var(--md-sys-color-on-surface-variant)]">
                {errorText(recent.error)}
              </p>
            </div>
            <Button variant="tonal" size="sm" icon="refresh" onClick={() => void recent.refetch()}>
              Повторить
            </Button>
          </section>
        ) : latest ? (
          <ContinueCard
            item={latest}
            busy={reopening}
            onContinue={() => reopen(latest.mediaId)}
            onStartOver={() => reopen(latest.mediaId, true)}
          />
        ) : (
          <WelcomeCard
            setup={setup.data}
            dragging={dragging}
            onOpenWizard={onOpenWizard}
            onPickFile={() => void pickFile()}
            onNavigateSettings={(section) => navigateSettings(section)}
          />
        )}

        {showDropZone && (
          <div
            className={`flex flex-wrap items-center gap-4 rounded-[28px] border-2 border-dashed p-5 transition-colors sm:flex-nowrap ${
              dragging
                ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-surface-container)]'
                : 'border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)]'
            }`}
          >
            <ShapeBadge shape="cookie9" size={56} tone="primary" icon="folder_open" iconFill iconSize={28} />
            <div className="min-w-0 flex-1">
              <div className="type-title-medium type-emph text-[var(--md-sys-color-on-surface)]">Открыть файл</div>
              <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
                {dragging
                  ? 'Отпустите видеофайл, чтобы начать просмотр'
                  : 'или перетащите видео в окно · mkv, mp4, avi, webm, mov'}
              </p>
            </div>
            <Button variant="filled" size="sm" icon="upload_file" onClick={() => void pickFile()}>
              Выбрать
            </Button>
          </div>
        )}

        <Presence>
          {banner && (
            <div
              role="status"
              className={`m3e-motion-pop flex flex-wrap items-center gap-4 rounded-3xl py-2.5 pr-2.5 pl-5 sm:rounded-full ${bannerStyles}`}
            >
              <Icon name={banner.icon} size={24} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="type-title-small type-emph">{banner.title}</div>
                <div className="type-body-small opacity-90">{banner.body}</div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {banner.canRecheck && (
                  <Button
                    variant="text"
                    size="sm"
                    icon="refresh"
                    disabled={anki.isFetching}
                    onClick={() => void anki.refetch()}
                    style={{ '--m3e-button-content': 'currentColor' } as CSSProperties}
                  >
                    Проверить
                  </Button>
                )}
                <Button
                  variant="text"
                  size="sm"
                  icon="tune"
                  onClick={() => navigateSettings(banner.section)}
                  style={{ '--m3e-button-content': 'currentColor' } as CSSProperties}
                >
                  {banner.actionLabel}
                </Button>
                {banner.canDismiss && (
                  <IconButton icon="close" label="Скрыть подсказку" size="md" onClick={dismissLampa} />
                )}
              </div>
            </div>
          )}
        </Presence>
      </div>

      <RecentSection
        items={recentItems}
        isPending={recent.isPending}
        busy={!!loading || reopening}
        view={view}
        onChangeView={changeView}
        onOpen={(mediaId) => reopen(mediaId)}
        onForget={forget}
        onResetAnnot={resetAndReopen}
      />
    </main>
  )
}
