import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { IconButton } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, LlmProvider } from '@/common/types/ipc'
import { useDebounced } from '@/common/utilities/useDebounced'
import { Field, Secret, Text, inputClass } from './SettingsPanel'

type Llm = AppConfig['llm']

/** Option value for «Другая модель…»; `\n` divides source and provider ids. */
const CUSTOM = '__custom__'

/** A key of its own, or an imported provider whose config still has one. */
export function llmReady(llm: Llm, providers: LlmProvider[] | undefined): boolean {
 if (!llm.source) return !!llm.apiKey
 return !!providers?.some((p) => p.source === llm.source && p.id === llm.provider && p.hasKey)
}

/** Identity of the connection a model list belongs to; ignores `model`, which does not affect it. */
const connKey = (l: Llm) => JSON.stringify({ source: l.source, provider: l.provider, baseUrl: l.baseUrl, apiKey: l.apiKey, api: l.api })

/** Providers grouped by the agent they were imported from, in discovery order. */
export function groupProviders(providers: LlmProvider[] | undefined): { label: string; items: LlmProvider[] }[] {
 const out: { label: string; items: LlmProvider[] }[] = []
 for (const p of providers ?? []) {
  const g = out.find((g) => g.label === p.sourceLabel)
  if (g) g.items.push(p)
  else out.push({ label: p.sourceLabel, items: [p] })
 }
 return out
}

/**
 * Model select plus a manual fallback, fed by the provider's live `/models` list. `inherit` adds
 * an empty value that means "the main settings' model", for the per-task pickers.
 */
export function ModelPicker({ conn, providers, model, onModel, inherit }: { conn: Llm; providers: LlmProvider[] | undefined; model: string; onModel: (m: string) => void; inherit?: string }) {
 const [custom, setCustom] = useState(false)
 const selected = providers?.find((p) => p.source === conn.source && p.id === conn.provider)
 const key = connKey(conn)
 const draft = useDebounced(conn, 600)
 const connection = connKey(draft)
 const enabled = draft.source
  ? !!providers?.some((p) => p.source === draft.source && p.id === draft.provider && p.hasKey)
  : !!(draft.baseUrl && draft.apiKey)
 const query = useQuery({
  queryKey: ['llm-models', connection],
  queryFn: () => api.llmModels(draft),
  enabled,
  staleTime: 300_000,
  retry: false,
 })
 // Until the debounce catches up, `query.data` still belongs to the previous provider.
 const list = (connection === key ? query.data : undefined) ?? selected?.models ?? []
 const hint = query.isFetching
  ? 'Загружаю список моделей…'
  : query.error
   ? `${errorText(query.error)}. Модель можно вписать вручную`
   : `Моделей: ${list.length}`

 // An empty model with `inherit` means the main connection's model: that is what a real call would use.
 const pingModel = inherit !== undefined && !model ? inherit : model
 // One tiny request with the live draft connection: the answer proves the key, the model id and the host all work.
 const ping = useMutation({ mutationFn: () => api.llmPing({ ...conn, model: pingModel }, pingModel) })
 const resetPing = ping.reset
 // A stale "отвечает" must not survive a model or connection change.
 useEffect(() => { resetPing() }, [resetPing, key, pingModel])
 const took = ping.data ? (ping.data.ms < 1000 ? `${ping.data.ms} мс` : `${(ping.data.ms / 1000).toFixed(1)} с`) : ''
 const reply = ping.data?.reply.replace(/\s+/g, ' ')

 return (
  <>
   <div className="flex items-start gap-1">
    <div className="min-w-0 flex-1">
     <Field label="Модель" hint={hint}>
      {list.length > 0 && !custom ? (
       <select
        className={inputClass}
        value={model}
        onChange={(e) => {
         if (e.target.value === CUSTOM) setCustom(true)
         else onModel(e.target.value)
        }}
       >
        {inherit !== undefined && <option value="">{inherit ? `Как в основных (${inherit})` : 'Как в основных'}</option>}
        {!!model && !list.includes(model) && <option value={model}>{`${model} (нет в списке)`}</option>}
        {list.map((m) => (
         <option key={m} value={m}>{m}</option>
        ))}
        <option value={CUSTOM}>Другая модель…</option>
       </select>
      ) : (
       <Text value={model} onChange={onModel} />
      )}
      {custom && list.length > 0 && (
       <button type="button" onClick={() => setCustom(false)} className="type-body-small self-start text-[var(--md-sys-color-primary)]">
        Вписать вручную
       </button>
      )}
     </Field>
    </div>
    <div className="flex gap-1 pt-6">
     <IconButton icon="refresh" label="Обновить список моделей" tipPos="left" disabled={!enabled} onClick={() => void query.refetch()} />
     <IconButton
      icon="network_check"
      label="Проверить, отвечает ли модель"
      tipPos="left"
      disabled={!enabled || !pingModel.trim() || ping.isPending}
      onClick={() => ping.mutate()}
     />
    </div>
   </div>
   {ping.isPending && <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Проверяю модель…</p>}
   {ping.data && (
    <p className="type-body-small text-[var(--md-sys-color-primary)]">
     {`Отвечает за ${took}${reply ? `: «${reply}»` : ''}`}
    </p>
   )}
   {ping.error && (
    <p className="type-body-small break-words text-[var(--md-sys-color-error)]" title={errorText(ping.error)}>
     Не отвечает: {errorText(ping.error)}
    </p>
   )}
  </>
 )
}

/**
  * Provider picker: «Вручную» keeps the baseUrl/apiKey fields, imported providers are read from
  * the other coding agents' own configs, so a rotated key needs no re-entry here.
  */
export function LlmFields({ llm, providers, onChange }: { llm: Llm; providers: LlmProvider[] | undefined; onChange: (patch: Partial<Llm>) => void }) {
 const selected = providers?.find((p) => p.source === llm.source && p.id === llm.provider)
 const groups = useMemo(() => groupProviders(providers), [providers])

 const value = llm.source ? `${llm.source}\n${llm.provider}` : ''

 return (
  <>
   <Field label="Провайдер">
    <select
     className={inputClass}
     value={value}
     onChange={(e) => {
      const v = e.target.value
      if (!v) {
       onChange({ source: '', provider: '' })
       return
      }
      const [source, provider] = v.split('\n')
      const p = providers?.find((x) => x.source === source && x.id === provider)
      const patch: Partial<Llm> = { source, provider }
      if (p && p.models.length > 0 && !p.models.includes(llm.model)) patch.model = p.models[0]
      onChange(patch)
     }}
    >
     <option value="">Вручную</option>
     {llm.source && !selected && <option value={value}>{`${llm.source}/${llm.provider} (не найден)`}</option>}
     {groups.map((g) => (
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

   {selected ? (
    <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
     {selected.hasKey
      ? `${selected.baseUrl} · ${selected.api === 'anthropic' ? 'Anthropic' : 'OpenAI-совместимый'} · ключ из ${selected.file}`
      : `В ${selected.file} нет API-ключа для этого провайдера`}
    </p>
   ) : (
    !llm.source && (
     <>
      <Field label="API-ключ">
       <Secret value={llm.apiKey} onChange={(apiKey) => onChange({ apiKey })} placeholder="sk-…" />
      </Field>
      <Field label="Адрес API">
       <Text value={llm.baseUrl} onChange={(baseUrl) => onChange({ baseUrl })} />
      </Field>
      <Field label="Протокол">
       <select className={inputClass} value={llm.api} onChange={(e) => onChange({ api: e.target.value as Llm['api'] })}>
        <option value="openai">OpenAI-совместимый</option>
        <option value="anthropic">Anthropic</option>
       </select>
      </Field>
     </>
    )
   )}

   <ModelPicker conn={llm} providers={providers} model={llm.model} onModel={(model) => onChange({ model })} />
  </>
 )
}
