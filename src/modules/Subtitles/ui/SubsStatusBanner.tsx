import { open } from '@tauri-apps/plugin-dialog'
import { api, errorText } from '@/common/api/tauri'
import { toast } from '@/common/ui/toast'
import { useSubsStore } from '../store/subsStore'

const LABEL = {
  searching: 'Ищу английские субтитры…',
  downloading: 'Скачиваю субтитры…',
} as const

/** Subtitle acquisition state: progress, "not found" with manual load, and the sync hint for non-exact matches. */
export function SubsStatusBanner({ mediaId, llmEnabled }: { mediaId: string; llmEnabled: boolean }) {
  const status = useSubsStore((s) => s.status)
  const cueCount = useSubsStore((s) => s.cues.length)

  const load = async () => {
    const path = await open({ multiple: false, filters: [{ name: 'Субтитры', extensions: ['srt', 'vtt', 'ass', 'ssa'] }] })
    if (typeof path !== 'string') return
    api.subsLoadFile(mediaId, path).catch((e) => toast(errorText(e)))
  }

  const chip = 'type-label-large pointer-events-auto rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-high)] px-4 py-2'
  const items: React.ReactNode[] = []
  if (!llmEnabled) {
    items.push(<div key="llm" className={chip}>Нет ключа DeepSeek: ~/.config/smart-subtitle/config.json → llm.apiKey</div>)
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
        <button type="button" onClick={() => void load()} className="state-layer state-on-primary relative rounded-full bg-[var(--md-sys-color-primary)] px-4 py-1 text-[var(--md-sys-color-on-primary)]">
          Загрузить .srt…
        </button>
      </div>,
    )
  }
  if (status?.state === 'ready' && status.exact === false) {
    items.push(<div key="exact" className={chip}>Подобраны по названию — если рассинхрон, сдвиньте: Z / X</div>)
  }
  if (items.length === 0) return null
  return <div className="pointer-events-none absolute inset-x-0 top-24 flex flex-col items-center gap-2">{items}</div>
}
