import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, Presence } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import { keyLabel, useHotkeysStore } from '@/modules/Hotkeys'
import {
  createExactHintTimer,
  dismissExactHint,
  EXACT_HINT_MS,
  formatSyncHint,
  syncExactHint,
  type ExactHintState,
  type ExactHintTimer,
} from '../lib/exactHint'
import { useSubsStore } from '../store/subsStore'

const LABEL = {
  searching: 'Ищу английские субтитры…',
  downloading: 'Скачиваю субтитры…',
} as const

/** Subtitle acquisition state: progress, "not found" with the chooser, and auto-hiding sync hint for non-exact matches. */
export function SubsStatusBanner({ mediaId, llmEnabled, onChoose }: { mediaId: string; llmEnabled: boolean; onChoose: () => void }) {
  const status = useSubsStore((s) => s.status)
  const cueCount = useSubsStore((s) => s.cues.length)
  const offset = useSubsStore((s) => s.offset)
  const annot = useSubsStore((s) => s.annot)
  const embedded = useSubsStore((s) => s.embedded)
  const offsetMinus = useHotkeysStore((s) => s.bindings.offsetMinus)
  const offsetPlus = useHotkeysStore((s) => s.bindings.offsetPlus)

  const [exactHint, setExactHint] = useState<ExactHintState | null>(null)
  const [hintPaused, setHintPaused] = useState(false)
  const hintTimerRef = useRef<ExactHintTimer | null>(null)

  const nextHint = syncExactHint(exactHint, status, offset)
  if (nextHint !== exactHint) {
    setExactHint(nextHint)
    if (!nextHint || nextHint.dismissed) setHintPaused(false)
  }

  const showExactHint = exactHint !== null && !exactHint.dismissed
  const hintStatus = exactHint?.status ?? null

  useEffect(() => {
    if (!showExactHint) {
      hintTimerRef.current = null
      return
    }
    const timer = createExactHintTimer(EXACT_HINT_MS, () => {
      setExactHint((cur) => dismissExactHint(cur))
      setHintPaused(false)
    })
    hintTimerRef.current = timer
    return () => {
      timer.dispose()
      if (hintTimerRef.current === timer) hintTimerRef.current = null
    }
  }, [showExactHint, hintStatus])

  useEffect(() => {
    if (!showExactHint) return
    const timer = hintTimerRef.current
    if (!timer) return
    if (hintPaused) timer.pause()
    else timer.resume()
  }, [showExactHint, hintStatus, hintPaused])

  const retry = useMutation({
    mutationFn: () => api.annotSet(mediaId, true),
    onError: (e) => notify('error', errorText(e)),
  })

  const chip = 'type-label-large pointer-events-auto rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-high)] px-4 py-2'
  const growing = embedded?.phase === 'loading' || embedded?.phase === 'confirm'
  const items: React.ReactNode[] = []
  if (!llmEnabled) {
    items.push(<div key="llm" className={chip}>LLM не настроен: Настройки → «Модели ИИ»</div>)
  }
  if (status && status.state !== 'ready' && status.state !== 'none') {
    const pct = status.progress !== undefined ? ` ${Math.round(status.progress * 100)}%` : ''
    items.push(
      <div key="st" className={chip}>
        {status.message ?? LABEL[status.state]}{pct}
      </div>,
    )
  }
  if (status?.state === 'none' && cueCount === 0) {
    items.push(
      <div key="none" className={`${chip} flex items-center gap-3`}>
        <span>Английские субтитры не найдены</span>
        <Button variant="filled" size="xs" onClick={onChoose}>
          Выбрать субтитры…
        </Button>
      </div>,
    )
  }
  // Background analysis: progress while it runs, a retry when some batches were written off.
  if (llmEnabled && annot?.consent === 'on') {
    const failure = annot.failure
    const running = retry.isPending || annot.running
    if (running && !failure?.blocked && (retry.isPending || annot.done < annot.total || (growing && annot.total > 0))) {
      const text = retry.isPending
        ? 'Повторяю разбор диалогов…'
        : !growing && annot.failed > 0 && annot.done + annot.failed >= annot.total
          ? (annot.done > 0 ? `Повторяю разбор диалогов ${annot.done}/${annot.total}…` : 'Повторяю разбор диалогов…')
          : `Разбор диалогов ${annot.done}/${annot.total}`
      items.push(
        <div
          key="annot"
          className={chip}
          role="progressbar"
          aria-label="Разбор диалогов"
          aria-valuemin={0}
          aria-valuemax={annot.total}
          aria-valuenow={annot.done}
          aria-valuetext={annot.total > 0 ? `Разобрано ${annot.done} из ${annot.total}` : 'Повторяю разбор диалогов…'}
        >
          {text}
        </div>,
      )
    } else if (annot.failed > 0 || failure) {
      items.push(
        <div key="annot" className={`${chip} mx-3 flex max-w-md flex-wrap items-center gap-3`}>
          <div role="status" className="min-w-0">
            <p>Не разобрано частей: {annot.total - annot.done}</p>
            {failure && <p className="type-body-medium break-words [overflow-wrap:anywhere]">{failure.message}</p>}
            {failure?.blocked && (
              <p className="type-body-small">Проверьте провайдера в «Настройки → Модели ИИ», затем откройте фильм заново.</p>
            )}
          </div>
          {!failure?.blocked && (
            <Button variant="filled" size="xs" onClick={() => retry.mutate()}>
              Повторить
            </Button>
          )}
        </div>,
      )
    }
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex flex-col items-center gap-2">
      {items}
      <Presence>
        {showExactHint && (
          <div
            role="status"
            className={`${chip} m3e-motion-pop flex items-center gap-2 py-1.5 pr-1.5 pl-4`}
            onPointerEnter={() => setHintPaused(true)}
            onPointerLeave={() => setHintPaused(false)}
            onFocus={() => setHintPaused(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHintPaused(false)
            }}
          >
            <span>
              {formatSyncHint(
                offsetMinus ? keyLabel(offsetMinus) : null,
                offsetPlus ? keyLabel(offsetPlus) : null,
              )}
            </span>
            <IconButton
              icon="close"
              size="sm"
              label="Скрыть подсказку"
              noTip
              onClick={() => {
                setExactHint((cur) => dismissExactHint(cur))
                setHintPaused(false)
              }}
            />
          </div>
        )}
      </Presence>
    </div>
  )
}
