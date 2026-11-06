import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { IconButton, WavyProgress } from '@tomato1337/m3e-react'
import { formatTime } from '@/common/utilities/time'
import { usePlayer } from '../usePlayerController'
import { usePlaybackStore } from '../store/playback'

type Props = {
  onPrevCue: () => void
  onNextCue: () => void
  leftSlot?: ReactNode
  rightSlot?: ReactNode
  /** Extra line right under the timeline, e.g. the embedded-subtitles load bar. */
  belowProgress?: ReactNode
}

function ProgressBar() {
  const p = usePlayer()
  const absTime = usePlaybackStore((s) => s.absTime)
  const duration = usePlaybackStore((s) => s.duration)
  const bufferedEnd = usePlaybackStore((s) => s.bufferedEnd)
  const playing = usePlaybackStore((s) => s.playing)
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [drag, setDrag] = useState(false)
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return { x: f * r.width, t: f * duration }
  }
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Позиция"
      data-tour="seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(absTime)}
      className="relative h-8 w-full cursor-pointer"
      onPointerMove={(e) => {
        const a = at(e.clientX)
        setHover(a)
        if (drag) p.seekDebounced(a.t)
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(true)
        p.seekDebounced(at(e.clientX).t)
      }}
      onPointerUp={() => setDrag(false)}
    >
      <WavyProgress
        className="absolute inset-0"
        value={duration > 0 ? absTime / duration : 0}
        buffer={duration > 0 ? bufferedEnd / duration : 0}
        amp={4}
        len={30}
        stroke={6}
        thumb
        animated={playing}
      />
      {hover && (
        <div
          className="type-label-small pointer-events-none absolute -top-8 -translate-x-1/2 rounded bg-[var(--md-sys-color-inverse-surface)] px-2 py-0.5 text-[var(--md-sys-color-inverse-on-surface)]"
          style={{ left: hover.x }}
        >
          {formatTime(hover.t)}
        </div>
      )}
    </div>
  )
}

function Volume() {
  const p = usePlayer()
  const volume = usePlaybackStore((s) => s.volume)
  const muted = usePlaybackStore((s) => s.muted)
  return (
    <div data-tour="volume" className="flex items-center">
      <IconButton
        icon={muted || volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'}
        label="Громкость"
        onClick={p.toggleMute}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        aria-label="Уровень громкости"
        onChange={(e) => p.setVolume(+e.target.value)}
        className="m3-range"
        style={{ '--fill': `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
      />
    </div>
  )
}

export function ControlBar({ onPrevCue, onNextCue, leftSlot, rightSlot, belowProgress }: Props) {
  const p = usePlayer()
  const absTime = usePlaybackStore((s) => s.absTime)
  const duration = usePlaybackStore((s) => s.duration)
  const playing = usePlaybackStore((s) => s.playing)
  const rate = usePlaybackStore((s) => s.rate)
  const label = playing ? 'Пауза' : 'Воспроизвести'
  const left = Math.max(0, duration - absTime)
  return (
    // No backdrop-filter: over a playing <video> WebKitGTK re-blurs every frame and repaints the
    // dock's hover transitions with it, which shows as flicker. A near-opaque surface looks the same.
    <div className="rounded-[var(--md-sys-shape-corner-extra-large-increased)] bg-[color-mix(in_srgb,var(--md-sys-color-surface-container-high)_94%,transparent)] px-6 pb-3 pt-2">
      <ProgressBar />
      {belowProgress}
      <div className="type-label-medium mt-0.5 flex justify-between font-semibold text-[var(--md-sys-color-on-surface-variant)] tabular-nums">
        <span>{formatTime(absTime)} / {formatTime(duration)}</span>
        <span>осталось {Math.max(1, Math.round(left / 60 / rate))} мин</span>
      </div>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
        <div className="flex items-center gap-1">{leftSlot}<Volume /></div>
        <div data-tour="transport" className="flex items-center gap-2">
          <IconButton icon="skip_previous" fill variant="secondary" size="lg" label="Предыдущая реплика" onClick={onPrevCue} />
          <IconButton
            icon={playing ? 'pause' : 'play_arrow'}
            fill
            variant="filled"
            size="xl"
            label={label}
            radius={playing ? 'var(--md-sys-shape-corner-large)' : '28px'}
            pressRadius="var(--md-sys-shape-corner-medium)"
            onClick={p.togglePlay}
          />
          <IconButton icon="skip_next" fill variant="secondary" size="lg" label="Следующая реплика" onClick={onNextCue} />
        </div>
        <div className="flex items-center justify-end gap-1">{rightSlot}</div>
      </div>
    </div>
  )
}
