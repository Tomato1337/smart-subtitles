import { usePlaybackStore } from '@/modules/Player'
import { useSubsStore } from '@/modules/Subtitles'

/**
 * Thin line under the timeline: how far the embedded track has been read. It disappears once the
 * whole track is stored, and fades with the rest of the control bar.
 */
export function SubsLoadLine() {
 const embedded = useSubsStore((s) => s.embedded)
 const duration = usePlaybackStore((s) => s.duration)
 if (embedded?.phase !== 'loading') return null
 const pct = duration > 0 ? Math.min(100, (embedded.loadedUntil / duration) * 100) : 0
 return (
  <div
   role="progressbar"
   aria-label="Загрузка субтитров"
   aria-valuemin={0}
   aria-valuemax={embedded.totalCues}
   aria-valuenow={embedded.loadedCues}
   className="relative h-0.5 w-full rounded-full bg-[var(--md-sys-color-surface-container-highest)]"
  >
   <div
    className="absolute inset-y-0 left-0 rounded-full bg-[var(--md-sys-color-tertiary)]"
    style={{ width: `${pct}%` }}
   />
  </div>
 )
}
