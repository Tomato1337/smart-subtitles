import { usePlayer } from '../usePlayerController'
import { usePlaybackStore } from '../store/playback'
import { Icon } from '@/common/ui/Icon'

export function VideoSurface() {
  const p = usePlayer()
  const buffering = usePlaybackStore((s) => s.buffering)
  const playing = usePlaybackStore((s) => s.playing)
  return (
    <div className="absolute inset-0 bg-black" onClick={p.togglePlay}>
      <video ref={p.videoRef} className="size-full object-contain" playsInline />
      {buffering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="md-spinner" role="progressbar" aria-label="Загрузка" />
        </div>
      )}
      {!playing && !buffering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex size-20 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_60%,transparent)] text-[var(--md-sys-color-on-surface)]">
            <Icon name="play_arrow" size={48} fill />
          </span>
        </div>
      )}
    </div>
  )
}
