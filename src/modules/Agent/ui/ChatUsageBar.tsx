import { useQuery } from '@tanstack/react-query'
import { Icon } from '@tomato1337/m3e-react'
import { api } from '@/common/api/tauri'
import { formatTokens, formatUsd } from '@/common/utilities/tokens'
import { agentUsageKey } from '../useAgent'

/**
 * Footer of the film chat: the current model and effort, how full its context window was on the
 * last request, the running in/out totals of the whole thread, and what it has cost so far.
 */
export function ChatUsageBar({ mediaId }: { mediaId: string }) {
 const query = useQuery({ queryKey: agentUsageKey(mediaId), queryFn: () => api.agentUsage(mediaId) })
 const u = query.data
 if (!u) return null

 const pct = u.contextWindow ? Math.min(100, (u.contextTokens / u.contextWindow) * 100) : null
 return (
  <div className="type-label-medium flex items-center gap-3 px-4 pb-3 text-[var(--md-sys-color-on-surface-variant)]">
   <Icon name="psychology" size={16} />
   <span className="min-w-0 truncate" title={u.model}>{u.modelName}</span>
   {u.effort !== 'off' && (
    <span className="shrink-0 rounded-full bg-[var(--md-sys-color-secondary-container)] px-2 text-[var(--md-sys-color-on-secondary-container)]">
     {u.effort}
    </span>
   )}
   {u.inputTokens > 0 && (
    <>
     {u.contextWindow !== null && pct !== null ? (
      <span className="flex shrink-0 items-center gap-1.5" title="Контекст последнего запроса">
       <span className="h-1 w-16 rounded-full bg-[var(--md-sys-color-surface-container-highest)]">
        <span className="block h-1 rounded-full bg-[var(--md-sys-color-primary)]" style={{ width: `${pct}%` }} />
       </span>
       {`${formatTokens(u.contextTokens)} / ${formatTokens(u.contextWindow)} · ${Math.round(pct)}%`}
      </span>
     ) : (
      <span className="shrink-0" title="Контекст последнего запроса">{formatTokens(u.contextTokens)}</span>
     )}
     <span className="shrink-0" title="Всего в чате фильма: вход / выход">
      {`↑${formatTokens(u.inputTokens)} ↓${formatTokens(u.outputTokens)}`}
     </span>
     {u.usd !== null && (
      <span className="shrink-0" title="Стоимость чата фильма">
       {`${u.usdPartial ? '≥ ' : ''}${formatUsd(u.usd)}`}
      </span>
     )}
    </>
   )}
  </div>
 )
}
