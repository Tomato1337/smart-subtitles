import { useQuery, useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { notify } from '@/common/api/notify'
import { api, errorText, type RecentMedia } from '@/common/api/tauri'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { formatTime } from '@/common/utilities/time'
import { useSessionStore } from '../store/sessionStore'

const BADGE = 'flex size-10 items-center justify-center'

/** Analysis badge of one recent film; `off` is a button, so a film can be analyzed after a refusal. */
function AnnotBadge({ m }: { m: RecentMedia }) {
  // `role="img"` + `aria-label`: the icons carry the state, so screen readers need the text, not the glyph.
  const badge = (icon: string, label: string, color: string) => (
    <span className={BADGE} role="img" aria-label={label} title={label} style={{ color }}>
      <Icon name={icon} size={20} />
    </span>
  )
  switch (m.annot) {
    case 'new':
      return badge('pending', 'Разбор не запускался', 'var(--md-sys-color-on-surface-variant)')
    case 'partial':
      return badge('hourglass_top', `Разобрано ${m.annotDone} из ${m.annotTotal}`, 'var(--md-sys-color-primary)')
    case 'done':
      return badge('check_circle', 'Диалоги разобраны', 'var(--md-sys-color-primary)')
    case 'failed':
      return badge('error', `Часть диалогов не разобрана: ${m.annotTotal - m.annotDone}`, 'var(--md-sys-color-error)')
    case 'off':
      return (
        <IconButton
          icon="block"
          label="Разбор выключен. Нажмите, чтобы разобрать"
          tipPos="left"
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
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 p-8">
      <h1 className="type-headline-medium">Smart Subtitles</h1>
      {loading ? (
        <div className="flex items-center gap-4 rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container)] p-6">
          <div className="md-spinner" />
          <div className="type-title-medium grow">Открываю «{loading}»…</div>
          <button
            type="button"
            onClick={cancelOpen}
            className="state-layer state-on-surface type-label-large relative shrink-0 rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]"
          >
            Отменить
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pickFile}
          className="state-layer state-on-primary type-label-large relative flex w-fit items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-6 py-2.5 text-[var(--md-sys-color-on-primary)]"
        >
          <Icon name="folder_open" size={20} /> Открыть файл
        </button>
      )}
      <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">Или выберите фильм в Lampa → «Smart Subtitles».</p>
      <h2 className="type-title-medium">Недавние</h2>
      <ul className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto">
        {recent.data?.map((m) => (
          <li key={m.mediaId} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!!loading}
              onClick={() => api.sessionReopen(m.mediaId).catch((e) => notify('error', errorText(e)))}
              className="state-layer state-on-surface relative flex min-w-0 flex-1 items-center justify-between gap-3 rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-low)] px-4 py-3 text-left"
            >
              <span className="min-w-0">
                <span className="type-body-large block truncate">
                  {m.title}{m.season !== null && m.episode !== null ? ` · S${m.season}E${m.episode}` : ''}
                </span>
                {m.originalTitle && <span className="type-body-small block truncate text-[var(--md-sys-color-on-surface-variant)]">{m.originalTitle}</span>}
              </span>
              <span className="type-label-small shrink-0 text-[var(--md-sys-color-primary)]">
                {formatTime(m.lastPosition)}{m.duration ? ` / ${formatTime(m.duration)}` : ''}
              </span>
            </button>
            <AnnotBadge m={m} />
          </li>
        ))}
        {recent.data?.length === 0 && <li className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">Пока пусто</li>}
      </ul>
    </div>
  )
}
