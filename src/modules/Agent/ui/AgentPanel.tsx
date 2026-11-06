import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { Icon, IconButton, shapeClip } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { ChatMessage } from '@/common/types/ipc'
import { formatTime } from '@/common/utilities/time'
import { CARD_PHASE_RU, useCardsStore } from '@/modules/Cards'
import { useHotkeysStore, withKey } from '@/modules/Hotkeys'
import { useAgentStore } from '../store/agentStore'
import { agentKey, useAgentActions, type Locate } from '../useAgent'
import { ChatUsageBar } from './ChatUsageBar'
import { Markdown } from './Markdown'

const TOOL_LABEL: Record<string, string> = {
  media_transcript: 'читаю сценарий…', anki_words: 'смотрю слова в Anki…', pattern_ref: 'смотрю конструкцию…', propose_cards: 'готовлю карточки…',
}

function Proposal({ mediaId, m }: { mediaId: string; m: ChatMessage }) {
  const qc = useQueryClient()
  const words = m.words ?? []
  const [picked, setPicked] = useState<Set<number>>(() => new Set(words.map((_, i) => i)))
  const [busy, setBusy] = useState(false)
  const phase = useCardsStore((s) => (m.proposalId === null ? undefined : s.phases[m.proposalId]))
  const open = m.status === 'pending' || m.status === 'failed'
  const refresh = () => qc.invalidateQueries({ queryKey: agentKey(mediaId) })

  // Only queues the job; status moves to 'adding' and `cards:result` refreshes it when the job ends.
  const add = async () => {
    setBusy(true)
    try {
      await api.cardsAdd(m.proposalId!, [...picked])
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  return (
    <div className="rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container-highest)] p-3">
      <div className="type-label-medium mb-2 text-[var(--md-sys-color-on-surface-variant)]">Предложенные карточки</div>
      {words.map((w, i) => (
        <label key={i} className="flex items-start gap-2 py-1">
          <input type="checkbox" disabled={!open} checked={picked.has(i)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })} className="mt-1 accent-[var(--md-sys-color-primary)]" />
          <span className="type-body-medium"><b>{w.word}</b> — {w.translation}<br /><span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{w.full_sentence}</span></span>
        </label>
      ))}
      {open ? (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy || picked.size === 0} onClick={() => void add()} className="state-layer state-on-primary type-label-large relative rounded-full bg-[var(--md-sys-color-primary)] px-4 py-1.5 text-[var(--md-sys-color-on-primary)] disabled:opacity-50">
            Добавить выбранные
          </button>
          <button type="button" onClick={() => void api.cardsDismiss(m.proposalId!).then(refresh)} className="type-label-large rounded-full px-3 py-1.5 text-[var(--md-sys-color-primary)]">Отклонить</button>
        </div>
      ) : (
        <div className="type-label-medium mt-2 text-[var(--md-sys-color-on-surface-variant)]">{m.status === 'added' ? 'Добавлено в Anki' : m.status === 'dismissed' ? 'Отклонено' : phase ? CARD_PHASE_RU[phase] : 'Добавляется в фоне…'}</div>
      )}
      {m.status === 'failed' && <div className="type-body-small mt-1 text-[var(--md-sys-color-error)]">Не получилось — можно повторить</div>}
    </div>
  )
}

type PanelProps = {
  mediaId: string
  locate: Locate
  /** Live "where am I" line under the title. */
  here: ReactNode
  cueTime: (cueIdx: number) => string | null
  cueText: (cueIdx: number) => string
  onSeekCue: (cueIdx: number) => void
  onSeekTime: (t: number) => void
  /**
   * Rendered while open and through its exit slide (the player screen's `usePresence`); the
   * component itself stays mounted, so an unsent draft survives closing the panel.
   */
  mounted: boolean
  /** The panel root, for that presence. */
  ref?: Ref<HTMLElement>
}

const BUBBLE = 'type-body-medium break-words'

/** Film chat with the agent (480 px, extra-large corners, level-3 surface): one thread per film, every message carries the learner's position. */
export function AgentPanel({ mounted, mediaId, locate, here, cueTime, cueText, onSeekCue, onSeekTime, ref }: PanelProps) {
  const { open, setOpen, live: l } = useAgentStore()
  const hotkey = useHotkeysStore((s) => s.bindings)
  const { ask } = useAgentActions(mediaId, locate)
  const [text, setText] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const history = useQuery({ queryKey: agentKey(mediaId), queryFn: () => api.agentHistory(mediaId), enabled: open })
  // Scroll the message list itself. `scrollIntoView` would also scroll every ancestor, including the
  // overflow-hidden video area: while the panel slides in from off-screen that shifted the film sideways for good.
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight }, [open, history.data, l.text])
  if (!mounted) return null

  const submit = () => {
    const t = text.trim()
    if (!t || l.busy) return
    setText('')
    void ask(t)
  }
  const md = (s: string) => <Markdown text={s} cueTime={cueTime} cueText={cueText} onCue={onSeekCue} />
  const where = (m: ChatMessage) => {
    if (m.at !== null) return { label: formatTime(m.at) + (m.cueIdx !== null ? ` · реплика ${m.cueIdx}` : ''), go: () => onSeekTime(m.at!) }
    if (m.cueIdx !== null && cueTime(m.cueIdx) !== null) return { label: `${cueTime(m.cueIdx)} · реплика ${m.cueIdx}`, go: () => onSeekCue(m.cueIdx!) }
    return null
  }

  return (
    <aside ref={ref} className="m3e-motion-from-right ml-2 flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner-extra-large)] bg-[var(--md-sys-color-surface-container-low)]" style={{ userSelect: 'text' }} aria-label="Агент">
      <div className="flex items-center gap-3 pl-4 pr-2 pt-4 pb-3">
        <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center bg-[var(--md-sys-color-tertiary-container)] text-[var(--md-sys-color-on-tertiary-container)]" style={{ clipPath: shapeClip.burst12, WebkitClipPath: shapeClip.burst12 }}>
          <Icon name="auto_awesome" fill />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="type-title-large type-emph">Агент</h2>
          <div className="type-body-small truncate text-[var(--md-sys-color-on-surface-variant)]">{here}</div>
        </div>
        <IconButton icon="close" label={withKey('Закрыть', hotkey.chat)} onClick={() => setOpen(false)} />
      </div>
      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-4 py-2">
        {history.data?.length === 0 && !l.busy && (
          <p className="type-body-medium m-auto max-w-[340px] text-center text-[var(--md-sys-color-on-surface-variant)]">
            Агент видит, на каком месте фильма ты сейчас. Спроси «что он сейчас сказал?», «почему тут did, а не does?» или попроси карточки по сцене.
          </p>
        )}
        {history.data?.map((m) => {
          if (m.role === 'proposal') return <Proposal key={m.id} mediaId={mediaId} m={m} />
          if (m.role === 'assistant') return <div key={m.id} className={`${BUBBLE} self-stretch`}>{md(m.text)}</div>
          const w = where(m)
          return (
            <div key={m.id} className="flex max-w-[85%] flex-col items-end gap-1 self-end">
              {w && (
                <button type="button" onClick={w.go} title="Перейти к этому месту" className="type-label-small flex items-center gap-1 px-1 text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-primary)]">
                  <Icon name="schedule" size={14} />{w.label}
                </button>
              )}
              <div className={`${BUBBLE} whitespace-pre-wrap rounded-[var(--md-sys-shape-corner-large-increased)] bg-[var(--md-sys-color-secondary-container)] px-3.5 py-2.5 text-[var(--md-sys-color-on-secondary-container)]`}>{m.text}</div>
            </div>
          )
        })}
        {l.busy && (
          <div className={`${BUBBLE} self-stretch`}>
            {l.text ? md(l.text) : <span className="text-[var(--md-sys-color-on-surface-variant)]">{l.tool ? TOOL_LABEL[l.tool] ?? 'работаю…' : 'думаю…'}</span>}
          </div>
        )}
        {l.error && <div className="type-body-small text-[var(--md-sys-color-error)]">{l.error}</div>}
      </div>
      <div className="flex items-end gap-2 p-3 pl-4">
        <textarea
          value={text}
          rows={1}
          placeholder="Спросить про фильм или эту сцену…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          className="type-body-medium max-h-32 min-h-[52px] min-w-0 flex-1 resize-none rounded-[26px] bg-[var(--md-sys-color-surface-container-highest)] px-6 py-3.5"
        />
        <IconButton icon="arrow_upward" fill variant="filled" shape="cookie9" className="!size-[52px]" label="Отправить" disabled={!text.trim() || l.busy} onClick={submit} />
      </div>
      <ChatUsageBar mediaId={mediaId} />
    </aside>
  )
}
