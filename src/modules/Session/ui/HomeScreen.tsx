import { useQuery, useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { notify } from '@/common/api/notify'
import { api, errorText, type RecentMedia } from '@/common/api/tauri'
import { Cover } from '@/common/ui/Cover'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { shapeClip } from '@/common/ui/shapes'
import { WavyProgress } from '@/common/ui/WavyProgress'
import { WavySpinner } from '@/common/ui/WavySpinner'
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
      className={`absolute -bottom-1.5 -right-2.5 grid size-[30px] cursor-default place-items-center ${extra}`}
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
          className="!absolute -bottom-1.5 -right-2.5 !size-[30px] shadow-[0_0_0_3px_var(--md-sys-color-surface-container)]"
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
            className="morph state-layer state-on-surface type-title-large type-emph relative flex h-20 items-center gap-3 rounded-[var(--md-sys-shape-corner-large-increased)] bg-[var(--md-sys-color-primary-container)] pl-6 pr-10 text-[var(--md-sys-color-on-primary-container)] active:rounded-[var(--md-sys-shape-corner-extra-large-increased)]"
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
            <li key={m.mediaId} className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-4 rounded-[var(--md-sys-shape-corner-extra-small)] bg-[var(--md-sys-color-surface-container)] py-2 pl-2 pr-1 transition-colors first:rounded-t-[var(--md-sys-shape-corner-extra-large)] last:rounded-b-[var(--md-sys-shape-corner-extra-large)] hover:bg-[var(--md-sys-color-surface-container-high)]">
              <span className="relative block h-[84px] w-14">
                <Cover src={m.posterUrl} title={m.title} className="size-full" />
                <AnnotBadge m={m} />
              </span>
              <button
                type="button"
                disabled={!!loading}
                onClick={() => api.sessionReopen(m.mediaId).catch((e) => notify('error', errorText(e)))}
                className="flex min-h-16 min-w-0 items-center justify-between gap-4 rounded-[var(--md-sys-shape-corner-large)] py-2 pr-4 text-left disabled:opacity-60"
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
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
