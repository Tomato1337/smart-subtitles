import { useQuery, useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { api, errorText } from '@/common/api/tauri'
import { Icon } from '@/common/ui/Icon'
import { toast } from '@/common/ui/toast'
import { formatTime } from '@/common/utilities/time'
import { useSessionStore } from '../store/sessionStore'

export function HomeScreen() {
  const qc = useQueryClient()
  const loading = useSessionStore((s) => s.loading)
  const recent = useQuery({ queryKey: ['recent'], queryFn: api.mediaRecent })

  const pickFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: 'Видео', extensions: ['mkv', 'mp4', 'avi', 'webm', 'mov'] }] })
    if (typeof path !== 'string') return
    try { await api.sessionOpenFile(path) } catch (e) { toast(errorText(e)) }
    void qc.invalidateQueries({ queryKey: ['recent'] })
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 p-8">
      <h1 className="type-headline-medium">Smart Subtitles</h1>
      {loading ? (
        <div className="flex items-center gap-4 rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container)] p-6">
          <div className="md-spinner" />
          <div className="type-title-medium">Открываю «{loading}»…</div>
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
      <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {recent.data?.map((m) => (
          <li key={m.mediaId}>
            <button
              type="button"
              disabled={!!loading}
              onClick={() => api.sessionReopen(m.mediaId).catch((e) => toast(errorText(e)))}
              className="state-layer state-on-surface relative flex w-full items-center justify-between rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-low)] px-4 py-3 text-left"
            >
              <span>
                <span className="type-body-large block">
                  {m.title}{m.season !== null && m.episode !== null ? ` · S${m.season}E${m.episode}` : ''}
                </span>
                {m.originalTitle && <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{m.originalTitle}</span>}
              </span>
              <span className="type-label-small text-[var(--md-sys-color-primary)]">
                {formatTime(m.lastPosition)}{m.duration ? ` / ${formatTime(m.duration)}` : ''}
              </span>
            </button>
          </li>
        ))}
        {recent.data?.length === 0 && <li className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">Пока пусто</li>}
      </ul>
    </div>
  )
}
