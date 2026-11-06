import { useState, type CSSProperties, type ReactNode } from 'react'
import { IconButton, Menu, MenuItem, useTipAnchor } from '@tomato1337/m3e-react'
import type { SessionState } from '@/common/types/ipc'
import { Cover } from '@/common/ui/Cover'
import { usePlayer } from '../usePlayerController'
import { usePlaybackStore } from '../store/playback'
import { TorrentSignalLine } from './TorrentSignalLine'

type Props = {
  session: SessionState
  onBack: () => void
  onOpenEpisode: (index: number) => void
  /** Extra buttons at the far right (agent chat). */
  rightSlot?: ReactNode
}

/** Dark overlay colours for buttons floating on the video. */
const OVER_VIDEO = { '--m3e-icon-button-tonal-container': 'color-mix(in srgb, var(--md-sys-color-surface-container-highest) 80%, transparent)' } as CSSProperties

export function TopBar({ session, onBack, onOpenEpisode, rightSlot }: Props) {
  const p = usePlayer()
  const rate = usePlaybackStore((s) => s.rate)
  const rateTip = useTipAnchor()
  const [episodes, setEpisodes] = useState(false)
  const idx = session.playlistIndex
  const hasList = session.playlist.length > 0 && idx !== null
  const hasNext = hasList && idx + 1 < session.playlist.length
  const seasonLine = session.season !== null && session.episode !== null ? `Сезон ${session.season}, серия ${session.episode}` : null
  const meta = [
    session.originalTitle && session.originalTitle !== session.title ? session.originalTitle : null,
    seasonLine,
    session.episodeTitle,
  ].filter(Boolean).join(' · ')
  return (
    <div className="flex items-start gap-3 px-4 pb-10 pt-4" style={{ ...OVER_VIDEO, background: 'linear-gradient(to bottom, color-mix(in srgb, var(--md-sys-color-scrim) 80%, transparent), transparent)' }}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <IconButton icon="arrow_back" label="Закрыть" data-tour="close" variant="tonal" size="lg" tipPos="bottom-start" onClick={onBack} />
        <Cover src={session.posterUrl} title={session.title} className="h-[66px] w-11 shadow-[0_2px_10px_rgb(0_0_0/0.5)]" />
        <div className="min-w-0">
          <h1 className="type-headline-medium type-emph truncate text-[var(--app-on-video)]">{session.title}</h1>
          {meta && (
            <p className="type-body-medium truncate text-[color-mix(in_srgb,var(--app-on-video)_75%,transparent)]">{meta}</p>
          )}
          {session.torrent && (
            <div className="mt-1">
              <TorrentSignalLine sessionId={session.sessionId} enabled />
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-1 items-center justify-end gap-2">
        {hasList && (
          <div className="relative">
            <IconButton icon="format_list_bulleted" label="Эпизоды" data-tour="episodes" aria-haspopup="menu" aria-expanded={episodes} variant="tonal" size="lg" tipPos="bottom" onClick={() => setEpisodes((v) => !v)} />
            <Menu open={episodes} onClose={() => setEpisodes(false)} align="end">
              {session.playlist.map((it, i) => (
                <MenuItem key={i} label={it.title || `Файл ${i + 1}`} selected={i === idx} onClick={() => { setEpisodes(false); onOpenEpisode(i) }} />
              ))}
            </Menu>
          </div>
        )}
        {hasNext && <IconButton icon="skip_next" label="Следующая серия" data-tour="next-episode" variant="tonal" size="lg" tipPos="bottom" onClick={() => onOpenEpisode(idx + 1)} />}
        <div data-tour="rate" role="group" aria-label="Скорость" className="flex items-center gap-0.5">
          <IconButton icon="fast_rewind" label="Медленнее" variant="tonal" size="lg" tipPos="bottom" radius="24px var(--md-sys-shape-corner-extra-small) var(--md-sys-shape-corner-extra-small) 24px" pressRadius="24px" onClick={() => p.setRate(rate - 0.05)} />
          {/* The kit's icon-button parts (host for the tooltip, surface and state layer) with text instead of a glyph. */}
          <button
            type="button"
            aria-label={`Скорость ${rate.toFixed(2)}×, сбросить до 1×`}
            data-tip="Сбросить до 1×"
            data-tip-pos="bottom"
            data-variant="secondary"
            data-size="lg"
            onClick={() => p.setRate(1)}
            className="m3e-icon-button type-label-large font-semibold tabular-nums"
            style={{
              '--m3e-icon-button-width': '64px',
              '--m3e-icon-button-radius': 'var(--md-sys-shape-corner-extra-small)',
              ...rateTip,
            } as CSSProperties}
          >
            <span aria-hidden="true" data-part="surface" />
            <span aria-hidden="true" data-part="state" />
            <span data-part="icon">{rate.toFixed(2)}×</span>
          </button>
          <IconButton icon="fast_forward" label="Быстрее" variant="tonal" size="lg" tipPos="bottom" radius="var(--md-sys-shape-corner-extra-small) 24px 24px var(--md-sys-shape-corner-extra-small)" pressRadius="24px" onClick={() => p.setRate(rate + 0.05)} />
        </div>
        {rightSlot && <div className="flex items-center gap-2">{rightSlot}</div>}
      </div>
    </div>
  )
}
