import { useRef, useState, type ReactNode } from 'react'
import { IconButton } from '@/common/ui/IconButton'
import { formatTime } from '@/common/utilities/time'
import { usePlayer } from '../usePlayerController'
import { usePlaybackStore } from '../store/playback'

type Props = {
  onPrevCue: () => void
  onNextCue: () => void
  leftSlot?: ReactNode
  rightSlot?: ReactNode
}

function ProgressBar() {
  const p = usePlayer()
  const { absTime, duration, bufferedEnd } = usePlaybackStore()
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [drag, setDrag] = useState(false)
  const pct = (t: number) => (duration > 0 ? Math.min(100, (t / duration) * 100) : 0)
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
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(absTime)}
      className="group relative h-4 w-full cursor-pointer py-1.5"
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
      <div className="relative h-1 w-full rounded-full bg-[var(--md-sys-color-surface-container-highest)] transition-[height] group-hover:h-1.5">
        <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--md-sys-color-outline-variant)]" style={{ width: `${pct(bufferedEnd)}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--md-sys-color-primary)]" style={{ width: `${pct(absTime)}%` }} />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--md-sys-color-primary)]"
          style={{ left: `${pct(absTime)}%` }}
        />
      </div>
      {hover && (
        <div
          className="type-label-small pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-[var(--md-sys-color-inverse-surface)] px-2 py-0.5 text-[var(--md-sys-color-inverse-on-surface)]"
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
  const { volume, muted } = usePlaybackStore()
  return (
    <div className="group flex items-center">
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
        className="w-0 accent-[var(--md-sys-color-primary)] transition-all group-hover:w-24"
      />
    </div>
  )
}

export function ControlBar({ onPrevCue, onNextCue, leftSlot, rightSlot }: Props) {
  const p = usePlayer()
  const { absTime, duration, playing, rate } = usePlaybackStore()
  const left = Math.max(0, duration - absTime)
  return (
    <div className="px-4 pb-3 pt-10" style={{ background: 'linear-gradient(to top, color-mix(in srgb, var(--md-sys-color-scrim) 80%, transparent), transparent)' }}>
      <ProgressBar />
      <div className="type-label-medium mt-1 flex justify-between text-[var(--md-sys-color-on-surface)]">
        <span>{formatTime(absTime)} / {formatTime(duration)}</span>
        <span>осталось {Math.max(1, Math.round(left / 60 / rate))} мин</span>
      </div>
      <div className="mt-1 grid grid-cols-3 items-center">
        <div className="flex items-center gap-1">{leftSlot}<Volume /></div>
        <div className="flex items-center justify-center gap-3">
          <IconButton icon="arrow_back" label="Предыдущая реплика" onClick={onPrevCue} />
          <IconButton variant="filled" icon={playing ? 'pause' : 'play_arrow'} label={playing ? 'Пауза' : 'Воспроизвести'} onClick={p.togglePlay} />
          <IconButton icon="arrow_forward" label="Следующая реплика" onClick={onNextCue} />
        </div>
        <div className="flex items-center justify-end gap-1">{rightSlot}</div>
      </div>
    </div>
  )
}
