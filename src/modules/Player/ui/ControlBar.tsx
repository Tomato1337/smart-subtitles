import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconButton, Slider, WavyProgress } from '@tomato1337/m3e-react'
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

/** Remaining minutes text, hidden when duration is unknown/zero or playback has reached the end. */
export function remainingMinutesLabel(absTime: number, duration: number, rate: number): string | null {
  if (!Number.isFinite(duration) || !Number.isFinite(absTime) || !Number.isFinite(rate) || duration <= 0 || rate <= 0) {
    return null
  }
  const left = duration - absTime
  if (left <= 0) return null
  return `осталось ${Math.max(1, Math.round(left / 60 / rate))} мин`
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
  const validDur = Number.isFinite(duration) && duration > 0 ? duration : 0
  const validTime = Number.isFinite(absTime) && absTime > 0 ? absTime : 0
  const validBuf = Number.isFinite(bufferedEnd) && bufferedEnd > 0 ? bufferedEnd : 0
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    if (r.width <= 0 || validDur <= 0) return { x: 0, t: 0 }
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return { x: f * r.width, t: f * validDur }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 30 : 5
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      p.seek(Math.max(0, validTime - step))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      p.seek(validDur > 0 ? Math.min(validDur, validTime + step) : validTime + step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      e.stopPropagation()
      p.seek(0)
    } else if (e.key === 'End' && validDur > 0) {
      e.preventDefault()
      e.stopPropagation()
      p.seek(validDur)
    }
  }
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Позиция"
      data-tour="seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(validDur)}
      aria-valuenow={Math.round(validTime)}
      aria-valuetext={formatTime(validTime)}
      className="relative h-8 w-full cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-sys-color-primary)]"
      onKeyDown={onKeyDown}
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
        value={validDur > 0 ? validTime / validDur : 0}
        buffer={validDur > 0 ? validBuf / validDur : 0}
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
      <Slider
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        label="Уровень громкости"
        onChange={p.setVolume}
        className="dock-volume-slider"
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
  const remLabel = remainingMinutesLabel(absTime, duration, rate)
  return (
    // No backdrop-filter: over a playing <video> WebKitGTK re-blurs every frame and repaints the
    // dock's hover transitions with it, which shows as flicker. A near-opaque surface looks the same.
    <div className="dock-surface rounded-[var(--md-sys-shape-corner-extra-large-increased)] bg-[color-mix(in_srgb,var(--md-sys-color-surface-container-high)_94%,transparent)]">
      <ProgressBar />
      {belowProgress}
      <div className="type-label-medium mt-0.5 flex justify-between gap-2 font-semibold text-[var(--md-sys-color-on-surface-variant)] tabular-nums">
        <span>{formatTime(absTime)} / {formatTime(duration)}</span>
        {remLabel && <span>{remLabel}</span>}
      </div>
      <div className="dock-controls mt-1">
        <div className="flex min-w-0 items-center gap-1">{leftSlot}<Volume /></div>
        <div data-tour="transport" className="flex shrink-0 items-center gap-2">
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
        <div className="flex min-w-0 items-center justify-end gap-1">{rightSlot}</div>
      </div>
    </div>
  )
}
