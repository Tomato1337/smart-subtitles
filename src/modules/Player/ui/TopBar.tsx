import { useState, type ReactNode } from 'react'
import type { SessionState } from '@/common/types/ipc'
import { IconButton } from '@/common/ui/IconButton'
import { Menu, MenuItem } from '@/common/ui/Menu'
import { usePlayer } from '../usePlayerController'
import { usePlaybackStore } from '../store/playback'

type Props = {
  session: SessionState
  onBack: () => void
  onOpenEpisode: (index: number) => void
  /** Extra buttons at the far right (agent chat). */
  rightSlot?: ReactNode
}

export function TopBar({ session, onBack, onOpenEpisode, rightSlot }: Props) {
  const p = usePlayer()
  const rate = usePlaybackStore((s) => s.rate)
  const [episodes, setEpisodes] = useState(false)
  const idx = session.playlistIndex
  const hasList = session.playlist.length > 0 && idx !== null
  const hasNext = hasList && idx + 1 < session.playlist.length
  return (
    <div className="flex items-start justify-between px-4 pb-10 pt-3" style={{ background: 'linear-gradient(to bottom, color-mix(in srgb, var(--md-sys-color-scrim) 80%, transparent), transparent)' }}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <IconButton icon="arrow_back" label="Закрыть" onClick={onBack} />
        <div className="min-w-0">
          <div className="type-title-medium truncate">{session.title}</div>
          {session.originalTitle && session.originalTitle !== session.title && (
            <div className="type-body-small truncate text-[var(--md-sys-color-on-surface-variant)]">{session.originalTitle}</div>
          )}
        </div>
      </div>
      <div className="flex-1 text-center">
        {session.season !== null && session.episode !== null && (
          <>
            <div className="type-title-small">Сезон {session.season}, серия {session.episode}</div>
            {session.episodeTitle && <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{session.episodeTitle}</div>}
          </>
        )}
      </div>
      <div className="flex flex-1 items-center justify-end gap-1">
        {hasList && (
          <div className="relative">
            <IconButton icon="format_list_bulleted" label="Эпизоды" data-menu-trigger onClick={() => setEpisodes((v) => !v)} />
            <Menu open={episodes} onClose={() => setEpisodes(false)} align="right">
              {session.playlist.map((it, i) => (
                <MenuItem key={i} label={it.title || `Файл ${i + 1}`} selected={i === idx} onClick={() => { setEpisodes(false); onOpenEpisode(i) }} />
              ))}
            </Menu>
          </div>
        )}
        {hasNext && <IconButton icon="skip_next" label="Следующая серия" onClick={() => onOpenEpisode(idx + 1)} />}
        <div className="ml-2 flex items-center">
          <IconButton icon="fast_rewind" label="Медленнее" onClick={() => p.setRate(rate - 0.05)} />
          <span className="type-label-large w-10 text-center tabular-nums">{rate.toFixed(2)}</span>
          <IconButton icon="fast_forward" label="Быстрее" onClick={() => p.setRate(rate + 0.05)} />
        </div>
        {rightSlot && <div className="ml-2 flex items-center">{rightSlot}</div>}
      </div>
    </div>
  )
}
