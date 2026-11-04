import { usePlaybackStore } from '@/modules/Player'
import { analyzedSpans } from '../lib/analysisLine'
import { useSubsStore } from '../store/subsStore'

/**
 * Thin line above the subtitles load line: the stretches of the film whose dialog analysis is
 * already done. Batches finish out of order, so it is a set of ranges, and it disappears once
 * the whole film is analyzed — like the progress chip, which it makes precise.
 */
export function AnalysisLine() {
 const cues = useSubsStore((s) => s.cues)
 const annotations = useSubsStore((s) => s.annotations)
 const annot = useSubsStore((s) => s.annot)
 const embedded = useSubsStore((s) => s.embedded)
 const duration = usePlaybackStore((s) => s.duration)
 if (!annot || annot.consent !== 'on' || cues.length === 0 || duration <= 0) return null
 // While the subtitles are still being read out of the file, `total` covers only the cues stored
 // so far: "everything is done" then means the read part, not the film.
 const growing = embedded?.phase === 'loading' || embedded?.phase === 'confirm'
 if (!growing && annot.done + annot.failed >= annot.total) return null
 const spans = analyzedSpans(cues, annotations.keys())
 return (
  <div
   role="progressbar"
   aria-label="Разбор диалогов"
   aria-valuemin={0}
   aria-valuemax={annot.total}
   aria-valuenow={annot.done}
   aria-valuetext={`Разобрано ${annot.done} из ${annot.total}`}
   className="relative h-0.5 w-full overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container-highest)]"
  >
   {spans.map((s) => (
    <div
     key={s.from}
     className="absolute inset-y-0 bg-[var(--md-sys-color-secondary)]"
     // A single analyzed batch can be a fraction of a percent wide: keep it visible.
     style={{
      left: `${Math.min(100, (s.from / duration) * 100)}%`,
      width: `${Math.max(0.3, ((s.to - s.from) / duration) * 100)}%`,
     }}
    />
   ))}
  </div>
 )
}
