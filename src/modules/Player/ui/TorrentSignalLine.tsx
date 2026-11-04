import { useQuery } from '@tanstack/react-query'
import { api } from '@/common/api/tauri'
import { formatMbps } from '@/common/utilities/bitrate'
import { signalDots, type SignalDot } from '../lib/torrentSignal'

const DOT_COLOR: Record<SignalDot, string> = {
 bad: 'var(--md-sys-color-error)',
 weak: 'var(--app-warning)',
 good: 'var(--app-kind-collocation)',
 on: 'var(--app-on-video)',
 off: 'color-mix(in srgb, var(--app-on-video) 18%, transparent)',
}

/**
 * Peers, connected seeders, download speed and the five-dot buffer signal of a TorrServer stream.
 * Polls every two seconds, like Lampa's player info; non-torrent sources render nothing.
 */
export function TorrentSignalLine({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
 const q = useQuery({
  queryKey: ['torrent-health', sessionId],
  queryFn: () => api.mediaTorrentHealth(sessionId),
  enabled,
  retry: false,
  staleTime: 0,
  refetchInterval: 2000,
 })
 const h = q.data
 if (!enabled || !h) return null

 const speed = formatMbps(h.downloadSpeed)
 const buffer = h.bufferPercent === null ? null : Math.round(h.bufferPercent)
 const details = `${h.activePeers} из ${h.totalPeers} пиров, ${h.connectedSeeders} подкл. (сидов), ${speed} Мбит/с`
 const label = buffer === null ? `Торрент: ${details}` : `Торрент: буфер ${buffer}%, ${details}`

 return (
  <div
   role="group"
   aria-label={label}
   title={label}
   data-tour="torrent"
   className="type-label-small flex flex-wrap items-center gap-x-2 gap-y-1 text-[color-mix(in_srgb,var(--app-on-video)_75%,transparent)]"
  >
   <span aria-hidden="true" className="flex items-center gap-1">
    {signalDots(h.bufferPercent).map((dot, i) => (
     <span key={i} className="size-2 rounded-full" style={{ backgroundColor: DOT_COLOR[dot] }} />
    ))}
   </span>
   <span className="tabular-nums">{h.activePeers} / {h.totalPeers}</span>
   <span aria-hidden="true" className="text-[color-mix(in_srgb,var(--app-on-video)_45%,transparent)]">•</span>
   <span className="tabular-nums">{h.connectedSeeders} подкл.</span>
   <span aria-hidden="true" className="text-[color-mix(in_srgb,var(--app-on-video)_45%,transparent)]">•</span>
   <span className="tabular-nums">{speed} Мбит/с</span>
  </div>
 )
}
