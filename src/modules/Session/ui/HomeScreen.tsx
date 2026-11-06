import { useQuery, useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { Icon, IconButton, shapeClip, toast, WavyProgress, WavySpinner } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText, type RecentMedia } from '@/common/api/tauri'
import { Cover } from '@/common/ui/Cover'
import { formatTime } from '@/common/utilities/time'
import { useSessionStore } from '../store/sessionStore'

/** Analysis badge of one recent film; `off` is a button, so a film can be analyzed after a refusal. */
function AnnotBadge({ m }: { m: RecentMedia }) {
  // `role="img"` + `aria-label`: the icons carry the state, so screen readers need the text, not the glyph.
  const badge = (clip: string | undefined, background: string, color: string, icon: string, label: string, fill = false, extra = '') => (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`absolute -bottom-1.5 -right-2.5 z-[1] grid size-[30px] cursor-default place-items-center ${extra}`}
      style={{ clipPath: clip, background, color }}
    >
      <Icon name={icon} size={18} fill={fill} />
    </span>
  )
  switch (m.annot) {
    case 'done':
      return badge(shapeClip.sunny, 'var(--md-sys-color-primary-container)', 'var(--md-sys-color-on-primary-container)', 'check', 'Диалоги разобраны', true)
    case 'new':
      return badge(shapeClip.clover4, 'var(--md-sys-color-tertiary-container)', 'var(--md-sys-color-on-tertiary-container)', 'pending', 'Разбор не запускался')
    case 'partial':
      return badge(shapeClip.clover4, 'var(--md-sys-color-secondary-container)', 'var(--md-sys-color-on-secondary-container)', 'hourglass_top', `Разобрано ${m.annotDone} из ${m.annotTotal}`)
    case 'failed':
      return badge(undefined, 'var(--md-sys-color-error-container)', 'var(--md-sys-color-on-error-container)', 'error', `Часть диалогов не разобрана: ${m.annotTotal - m.annotDone}`, true, 'rounded-full')
    case 'off':
      return (
        <IconButton
          icon="block"
          label="Разбор выключен. Нажмите, чтобы разобрать"
          tipPos="left"
          variant="tonal"
          size="sm"
          radius="15px"
          className="!absolute -bottom-1.5 -right-2.5 z-[1] !size-[30px] shadow-[0_0_0_3px_var(--md-sys-color-surface-container)]"
          onClick={() => {
            api.mediaResetAnnot(m.mediaId)
              .then(() => api.sessionReopen(m.mediaId))
              .catch((e) => notify('error', errorText(e)))
          }}
        />
      )
    default:
      return null
  }
}

export function HomeScreen() {
  const qc = useQueryClient()
  const loading = useSessionStore((s) => s.loading)
  const recent = useQuery({ queryKey: ['recent'], queryFn: api.mediaRecent })

  // TorrServer can take minutes on a dead torrent: closing the session cancels the probe and the load.
  const cancelOpen = () => {
    void api.sessionClose()
    useSessionStore.getState().setLoading(null)
  }

  const pickFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: 'Видео', extensions: ['mkv', 'mp4', 'avi', 'webm', 'mov'] }] })
    if (typeof path !== 'string') return
    try { await api.sessionOpenFile(path) } catch (e) { notify('error', errorText(e)) }
    void qc.invalidateQueries({ queryKey: ['recent'] })
  }

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
    const failed = (e: unknown) => { notify('error', errorText(e)); refresh() }
    const hiding = api.mediaSetHidden(m.mediaId, true).then(refresh, failed)
    toast(`Удалено из недавних: «${m.title}»`, {
      durationMs: 6000,
      // After `hiding`: two invokes are not ordered, and the undo must be the last write.
      action: { label: 'Отменить', run: () => { void hiding.then(() => api.mediaSetHidden(m.mediaId, false)).then(refresh, failed) } },
    })
  }

  return (
    <div className="mx-auto flex h-full max-w-[880px] flex-col px-6 pb-6 pt-10">
      <h1 className="type-hero">Smart Subtitles</h1>
      {loading ? (
        <div role="status" className="mt-6 flex min-h-20 items-center gap-4 rounded-[var(--md-sys-shape-corner-extra-large)] bg-[var(--md-sys-color-surface-container)] py-4 pl-6 pr-4">
          <WavySpinner label="Открываю" />
          <div className="type-body-large grow text-[1.125rem]">Открываю «{loading}»…</div>
          <button
            type="button"
            onClick={cancelOpen}
            className="state-layer state-on-surface type-label-large relative h-10 shrink-0 rounded-full px-4 font-semibold text-[var(--md-sys-color-primary)]"
          >
            Отменить
          </button>
        </div>
      ) : (
        <div className="mt-6 flex items-center gap-6">
          <button
            type="button"
            onClick={pickFile}
            className="m3e-morph state-layer state-on-surface type-title-large type-emph relative flex h-20 items-center gap-3 rounded-[var(--md-sys-shape-corner-large-increased)] bg-[var(--md-sys-color-primary-container)] pl-6 pr-10 text-[var(--md-sys-color-on-primary-container)] active:rounded-[var(--md-sys-shape-corner-extra-large-increased)]"
          >
            <Icon name="folder_open" size={32} fill /> Открыть файл
          </button>
          <p className="max-w-[28ch] text-[var(--md-sys-color-on-surface-variant)]">Или выберите фильм в Lampa → «Smart Subtitles».</p>
        </div>
      )}
      <h2 className="type-title-large type-emph mt-10 mb-3">Недавние</h2>
      {recent.data?.length === 0 ? (
        <p className="type-body-large rounded-[var(--md-sys-shape-corner-extra-large)] bg-[var(--md-sys-color-surface-container-low)] p-6 text-[var(--md-sys-color-on-surface-variant)]">Пока пусто</p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {recent.data?.map((m) => (
            // The title button's ::after covers the whole row, so the poster opens the film too;
            // the badges and the remove button sit above it (z-index) and keep their own clicks.
            <li key={m.mediaId} className="relative grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-4 rounded-[var(--md-sys-shape-corner-extra-small)] bg-[var(--md-sys-color-surface-container)] py-2 pl-2 pr-3 transition-colors first:rounded-t-[var(--md-sys-shape-corner-extra-large)] last:rounded-b-[var(--md-sys-shape-corner-extra-large)] hover:bg-[var(--md-sys-color-surface-container-high)]">
              <span className="relative block h-[84px] w-14">
                <Cover src={m.posterUrl} title={m.title} className="size-full" />
                <AnnotBadge m={m} />
              </span>
              <button
                type="button"
                data-reopen
                aria-keyshortcuts="Delete"
                disabled={!!loading}
                onClick={() => api.sessionReopen(m.mediaId).catch((e) => notify('error', errorText(e)))}
                onKeyDown={(e) => { if (e.key === 'Delete') forget(m, e.currentTarget) }}
                className="flex min-h-16 min-w-0 items-center justify-between gap-4 rounded-[var(--md-sys-shape-corner-large)] py-2 text-left after:absolute after:inset-0 after:rounded-[inherit] disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="type-title-medium block truncate font-semibold">
                    {m.title}{m.season !== null && m.episode !== null ? ` · S${m.season}E${m.episode}` : ''}
                  </span>
                  {m.originalTitle && <span className="type-body-medium block truncate text-[var(--md-sys-color-on-surface-variant)]">{m.originalTitle}</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 type-label-large font-semibold tabular-nums text-[var(--md-sys-color-primary)]">
                  {formatTime(m.lastPosition)}{m.duration ? ` / ${formatTime(m.duration)}` : ''}
                  {m.duration ? <WavyProgress className="h-3 w-32" value={m.lastPosition / m.duration} amp={2} len={14} stroke={3} animated={false} /> : null}
                </span>
              </button>
              <IconButton icon="close" label="Удалить из недавних" tipPos="left" data-forget className="z-[1]" onClick={(e) => forget(m, e.currentTarget)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
