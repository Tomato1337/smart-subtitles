import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@/common/api/tauri'
import type { AppConfig, LlmProvider, TaskLlm } from '@/common/types/ipc'
import { IconButton } from '@/common/ui/IconButton'
import { formatTokens, formatUsd, estimateUsd } from '@/common/utilities/tokens'
import { EFFORT_LABEL, TASKS, WEIGHT_LABEL, type TaskProfile, type Weight } from '../taskProfiles'
import { groupProviders, ModelPicker } from './LlmFields'
import { Field, inputClass } from './SettingsPanel'

const PRIMARY =
 'state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-40'
const TEXT_BUTTON = 'state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]'
const HINT = 'type-body-small text-[var(--md-sys-color-on-surface-variant)]'

const WEIGHT_CHIP: Record<Weight, string> = {
 heavy: 'bg-[var(--md-sys-color-error-container)] text-[var(--md-sys-color-on-error-container)]',
 medium: 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]',
 light: 'bg-[var(--md-sys-color-tertiary-container)] text-[var(--md-sys-color-on-tertiary-container)]',
}

type Apply = <S extends keyof AppConfig>(section: S, patch: Partial<AppConfig[S]>) => void

export type TaskModelsDialogProps = {
 /** The settings panel's draft: the dialog edits it, so there is one save path. */
 cfg: AppConfig
 set: Apply
 onSave: () => void
 dirty: boolean
 saving: boolean
 onClose: () => void
}

/**
 * One card per task: its own provider and model (or the main connection), reasoning effort, and
 * the measured weight of one run at the current price.
 */
export function TaskModelsDialog({ cfg, set, onSave, dirty, saving, onClose }: TaskModelsDialogProps) {
 const providers = useQuery({ queryKey: ['llm-providers'], queryFn: api.llmProviders })

 useEffect(() => {
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
 }, [onClose])

 return (
  <div
   className="fixed inset-0 z-[185] flex items-center justify-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_55%,transparent)]"
   onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}
  >
   <div
    role="dialog"
    aria-label="Модели по задачам"
    className="md-pop flex max-h-[92vh] w-[760px] max-w-[96vw] flex-col bg-[var(--md-sys-color-surface-container-high)]"
    style={{ borderRadius: 'var(--md-sys-shape-corner-extra-large)' }}
   >
    <div className="flex items-center justify-between px-6 pt-5 pb-2">
     <h2 className="type-headline-small">Модели по задачам</h2>
     <IconButton icon="close" label="Закрыть" onClick={onClose} />
    </div>

    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-6 pb-4">
     <p className={HINT}>Каждой задаче можно дать свою модель. По умолчанию все задачи используют основные настройки.</p>
     {TASKS.map((task) => (
      <TaskCard key={task.key} task={task} cfg={cfg} set={set} providers={providers.data} />
     ))}
     <p className={HINT}>Оценки по журналу реальных запросов. Цены: ~/.omp/agent/models.yml, иначе models.dev.</p>
    </div>

    <div className="flex items-center justify-end gap-2 border-t border-[var(--md-sys-color-outline-variant)] px-6 py-4">
     <button type="button" className={TEXT_BUTTON} onClick={onClose}>Закрыть</button>
     <button type="button" className={PRIMARY} disabled={!dirty || saving} onClick={onSave}>
      Сохранить
     </button>
    </div>
   </div>
  </div>
 )
}

function TaskCard({ task, cfg, set, providers }: { task: TaskProfile; cfg: AppConfig; set: Apply; providers: LlmProvider[] | undefined }) {
 const t = cfg.llmTasks[task.key]
 const foreign = !!t.source
 const source = foreign ? t.source : cfg.llm.source
 const provider = foreign ? t.provider : cfg.llm.provider
 const baseUrl = foreign ? '' : cfg.llm.baseUrl
 const model = foreign ? t.model : t.model || cfg.llm.model
 const info = useQuery({
  queryKey: ['llm-model-info', source, provider, baseUrl, model],
  queryFn: () => api.llmModelInfo(source, provider, baseUrl, model),
  enabled: !!model,
  staleTime: 3_600_000,
 })
 const patch = (p: Partial<TaskLlm>) => set('llmTasks', { [task.key]: { ...t, ...p } })
 const found = providers?.find((p) => p.source === t.source && p.id === t.provider)

 const price = info.data
 const priceHint = price?.price
  ? ` · ≈ ${formatUsd(estimateUsd(price.price, task.input, task.cached, task.output))} с этой моделью`
  : price
   ? ' · цена модели неизвестна'
   : ''
 const windowHint = price?.contextWindow ? ` · окно ${formatTokens(price.contextWindow)}` : ''

 return (
  <section className="flex flex-col gap-3 rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container-low)] p-4">
   <div>
    <div className="flex flex-wrap items-center gap-2">
     <h3 className="type-title-small">{task.title}</h3>
     <span className={`type-label-small rounded-full px-2 py-0.5 ${WEIGHT_CHIP[task.weight]}`}>{WEIGHT_LABEL[task.weight]}</span>
    </div>
    <p className={HINT}>{task.about}</p>
   </div>

   <div>
    <p className="type-body-small">
     {`≈ ${formatTokens(task.input)} вход (≈ ${formatTokens(task.cached)} из кэша) · ≈ ${formatTokens(task.output)} выход за ${task.unit}${priceHint}${windowHint}`}
    </p>
    {t.effort !== 'off' && <p className={HINT}>С рассуждением выходных токенов больше; сколько — решает модель.</p>}
   </div>

   <Field label="Провайдер">
    <select
     className={inputClass}
     value={t.source ? `${t.source}\n${t.provider}` : ''}
     onChange={(e) => {
      const v = e.target.value
      if (!v) {
       patch({ source: '', provider: '', model: '' })
       return
      }
      const [source, provider] = v.split('\n')
      const p = providers?.find((x) => x.source === source && x.id === provider)
      patch({ source, provider, model: p?.models[0] ?? '' })
     }}
    >
     <option value="">Как в основных настройках</option>
     {t.source && !found && <option value={`${t.source}\n${t.provider}`}>{`${t.source}/${t.provider} (не найден)`}</option>}
     {groupProviders(providers).map((g) => (
      <optgroup key={g.label} label={g.label}>
       {g.items.map((p) => (
        <option key={`${p.source}\n${p.id}`} value={`${p.source}\n${p.id}`} disabled={!p.hasKey}>
         {p.hasKey ? p.label : `${p.label} — нет ключа`}
        </option>
       ))}
      </optgroup>
     ))}
    </select>
   </Field>

   {foreign ? (
    <ModelPicker
     conn={{ ...cfg.llm, source: t.source, provider: t.provider, model: t.model, baseUrl: '', apiKey: '' }}
     providers={providers}
     model={t.model}
     onModel={(m) => patch({ model: m })}
    />
   ) : (
    <ModelPicker
     conn={cfg.llm}
     providers={providers}
     model={t.model}
     onModel={(m) => patch({ model: m })}
     inherit={cfg.llm.model}
    />
   )}

   <Field label="Рассуждение (effort)" hint="Выключено: дешевле и быстрее">
    <select className={inputClass} value={t.effort} onChange={(e) => patch({ effort: e.target.value as TaskLlm['effort'] })}>
     {(Object.keys(EFFORT_LABEL) as (keyof typeof EFFORT_LABEL)[]).map((id) => (
      <option key={id} value={id}>{EFFORT_LABEL[id]}</option>
     ))}
    </select>
   </Field>
  </section>
 )
}
