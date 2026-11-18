import { useMutation } from '@tanstack/react-query'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import { useSubsStore } from '../store/subsStore'

const LABEL = {
  searching: 'Ищу английские субтитры…',
  downloading: 'Скачиваю субтитры…',
} as const

/** Subtitle acquisition state: progress, "not found" with the chooser, and the sync hint for non-exact matches. */
export function SubsStatusBanner({ mediaId, llmEnabled, onChoose }: { mediaId: string; llmEnabled: boolean; onChoose: () => void }) {
  const status = useSubsStore((s) => s.status)
  const cueCount = useSubsStore((s) => s.cues.length)
  const annot = useSubsStore((s) => s.annot)
  const retry = useMutation({
    mutationFn: () => api.annotSet(mediaId, true),
    onError: (e) => notify('error', errorText(e)),
  })

  const chip = 'type-label-large pointer-events-auto rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-high)] px-4 py-2'
  const items: React.ReactNode[] = []
  if (!llmEnabled) {
    items.push(<div key="llm" className={chip}>LLM не настроен: Настройки → «Перевод и разбор»</div>)
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
        <button type="button" onClick={onChoose} className="state-layer state-on-primary relative rounded-full bg-[var(--md-sys-color-primary)] px-4 py-1 text-[var(--md-sys-color-on-primary)]">
          Выбрать субтитры…
        </button>
      </div>,
    )
  }
  if (status?.state === 'ready' && status.exact === false) {
    items.push(<div key="exact" className={chip}>Подобраны по названию — если рассинхрон, сдвиньте: Z / X</div>)
  }
  // Background analysis: progress while it runs, a retry when some batches were written off.
  if (llmEnabled && annot?.consent === 'on') {
    const failure = annot.failure
    const running = retry.isPending || annot.running
    if (running && !failure?.blocked && (retry.isPending || annot.done < annot.total)) {
      items.push(
        <div
          key="annot"
          className={chip}
          role="progressbar"
          aria-label="Разбор диалогов"
          aria-valuemin={0}
          aria-valuemax={annot.total}
          aria-valuenow={annot.done}
          aria-valuetext={`Разобрано ${annot.done} из ${annot.total}`}
        >
          {retry.isPending || annot.done + annot.failed >= annot.total
            ? 'Повторяю разбор диалогов…'
            : `Разбор диалогов ${annot.done}/${annot.total}`}
        </div>,
      )
    } else if (annot.failed > 0 || failure) {
      items.push(
        <div key="annot" className={`${chip} mx-3 flex max-w-md flex-wrap items-center gap-3`}>
          <div role="status">
            <p>Не разобрано частей: {annot.total - annot.done}</p>
            {failure && <p className="type-body-medium">{failure.message}</p>}
            {failure?.blocked && (
              <p className="type-body-small">Проверьте провайдера в «Настройки → Перевод и разбор», затем откройте фильм заново.</p>
            )}
          </div>
          {!failure?.blocked && (
            <button
              type="button"
              onClick={() => retry.mutate()}
              className="state-layer state-on-primary relative rounded-full bg-[var(--md-sys-color-primary)] px-4 py-1 text-[var(--md-sys-color-on-primary)]"
            >
              Повторить
            </button>
          )}
        </div>,
      )
    }
  }
  if (items.length === 0) return null
  return <div className="pointer-events-none absolute inset-x-0 top-24 flex flex-col items-center gap-2">{items}</div>
}
