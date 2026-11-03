import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig } from '@/common/types/ipc'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { toast } from '@/common/ui/toast'

const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const OPEN_KEY = 'smartsubs.settingsOpen'

/**
  * Every config.json field, editable from the home screen and applied without restart (except the port).
  * Collapses to a rail; the choice survives restarts, an unsaved draft survives collapsing.
  */
export function SettingsPanel() {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== '0')
  const toggle = () => setOpen((o) => { localStorage.setItem(OPEN_KEY, o ? '0' : '1'); return !o })
  const query = useQuery({ queryKey: ['config'], queryFn: api.configGet })
  const c = query.data
  // Settings that block a core feature until filled in; their count marks the collapsed rail.
  const missing = c ? [c.llm.apiKey, c.opensubtitles.apiKey, c.lampa.origins.length].filter((v) => !v).length : 0

  return (
    <aside
      className={`relative h-full shrink-0 overflow-hidden border-l border-[var(--md-sys-color-outline-variant)] transition-[width] duration-300 ease-[var(--md-sys-motion-emphasized-decelerate)] motion-reduce:transition-none ${open ? 'w-[440px]' : 'w-16'}`}
    >
      <div
        inert={open}
        className={`absolute inset-x-0 top-4 flex justify-center transition-opacity duration-200 motion-reduce:transition-none ${open ? 'pointer-events-none opacity-0' : 'opacity-100 delay-100'}`}
      >
        <div className="relative">
          <IconButton icon="settings" label="Настройки" onClick={toggle} />
          {missing > 0 && (
            <span className="type-label-small pointer-events-none absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-[var(--md-sys-color-error)] text-[var(--md-sys-color-on-error)]">
              {missing}
            </span>
          )}
        </div>
      </div>
      {/* Fixed width: the content does not reflow while the aside animates, it is only clipped. */}
      <div
        inert={!open}
        className={`flex h-full w-[440px] flex-col transition-opacity duration-200 motion-reduce:transition-none ${open ? 'opacity-100 delay-75' : 'pointer-events-none opacity-0'}`}
      >
        {query.error ? (
          <p className="type-body-medium p-6 text-[var(--md-sys-color-error)]">{errorText(query.error)}</p>
        ) : !c ? (
          <div className="md-spinner m-6" />
        ) : (
          // Remount on every saved snapshot so the draft starts from what is on disk.
          <Form key={JSON.stringify(c)} saved={c} onCollapse={toggle} />
        )}
      </div>
    </aside>
  )
}

function Form({ saved, onCollapse }: { saved: AppConfig; onCollapse: () => void }) {
  const qc = useQueryClient()
  const [cfg, setCfg] = useState(saved)
  // Origins are edited as free text; split only on save so typing a newline is not eaten.
  const [origins, setOrigins] = useState(saved.lampa.origins.join('\n'))
  const draft: AppConfig = { ...cfg, lampa: { origins: origins.split('\n').map((s) => s.trim()).filter(Boolean) } }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const save = useMutation({
    mutationFn: () => api.configSave(draft),
    onSuccess: (restart) => {
      toast(restart ? 'Сохранено. Новый порт заработает после перезапуска приложения' : 'Настройки сохранены')
      void qc.invalidateQueries({ queryKey: ['config'] })
    },
    onError: (e) => toast(errorText(e)),
  })

  const set = <S extends keyof AppConfig>(section: S, patch: Partial<AppConfig[S]>) =>
    setCfg((c) => ({ ...c, [section]: { ...c[section], ...patch } }))

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(e) => { e.preventDefault(); if (dirty) save.mutate() }}
    >
      <div className="flex items-center justify-between gap-2 py-4 pr-6 pl-3">
        <div className="flex items-center gap-1">
          <IconButton icon="right_panel_close" label="Свернуть настройки" onClick={onCollapse} />
          <h2 className="type-title-large">Настройки</h2>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!dirty || save.isPending}
            onClick={() => { setCfg(saved); setOrigins(saved.lampa.origins.join('\n')) }}
            className="state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)] disabled:opacity-40"
          >
            Отменить
          </button>
          <button
            type="submit"
            disabled={!dirty || save.isPending}
            className="state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-40"
          >
            <Icon name="save" size={18} /> Сохранить
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-6">
        <Section icon="translate" title="Перевод и разбор (DeepSeek)" ok={!!cfg.llm.apiKey} missing="Без ключа нет перевода, подсветки и чата">
          <Field label="API-ключ"><Secret value={cfg.llm.apiKey} onChange={(apiKey) => set('llm', { apiKey })} placeholder="sk-…" /></Field>
          <Field label="Модель"><Text value={cfg.llm.model} onChange={(model) => set('llm', { model })} /></Field>
          <Field label="Адрес API"><Text value={cfg.llm.baseUrl} onChange={(baseUrl) => set('llm', { baseUrl })} /></Field>
          <Field label="Мой уровень" hint="Если Tutor запущен, уровень берётся из него">
            <select value={cfg.learner.cefr} onChange={(e) => set('learner', { cefr: e.target.value })} className={inputClass}>
              {CEFR.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </Field>
        </Section>

        <Section icon="subtitles" title="Субтитры (OpenSubtitles)" ok={!!cfg.opensubtitles.apiKey} missing="Без ключа субтитры только из раздачи или файла">
          <Field label="API-ключ"><Secret value={cfg.opensubtitles.apiKey} onChange={(apiKey) => set('opensubtitles', { apiKey })} /></Field>
          <Field label="Логин" hint="Необязательно: с аккаунтом больше скачиваний в день"><Text value={cfg.opensubtitles.username} onChange={(username) => set('opensubtitles', { username })} /></Field>
          <Field label="Пароль"><Secret value={cfg.opensubtitles.password} onChange={(password) => set('opensubtitles', { password })} /></Field>
        </Section>

        <Section icon="cloud_download" title="TorrServer">
          <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Нужен, только если TorrServer закрыт паролем</p>
          <Field label="Адрес" hint="Например https://example.com/tor"><Text value={cfg.torrserver.baseUrl} onChange={(baseUrl) => set('torrserver', { baseUrl })} /></Field>
          <Field label="Логин"><Text value={cfg.torrserver.username} onChange={(username) => set('torrserver', { username })} /></Field>
          <Field label="Пароль"><Secret value={cfg.torrserver.password} onChange={(password) => set('torrserver', { password })} /></Field>
        </Section>

        <Section icon="style" title="Anki и Tutor">
          <Field label="Колода Anki"><Text value={cfg.tutor.deck} onChange={(deck) => set('tutor', { deck })} /></Field>
          <Field label="Адрес Tutor API"><Text value={cfg.tutor.apiUrl} onChange={(apiUrl) => set('tutor', { apiUrl })} /></Field>
          <Field label="Папка Tutor"><Text value={cfg.tutor.root} onChange={(root) => set('tutor', { root })} /></Field>
        </Section>

        <Section icon="live_tv" title="Lampa" ok={draft.lampa.origins.length > 0} missing="Добавьте адрес своей Lampa, иначе она не сможет открыть фильм">
          <Field label="Разрешённые адреса Lampa" hint="По одному на строку, например https://lampa.example.com">
            <textarea value={origins} rows={3} onChange={(e) => setOrigins(e.target.value)} className={`${inputClass} resize-y`} />
          </Field>
          <Field label="Порт приложения" hint="Меняется после перезапуска">
            <input
              type="number"
              min={1}
              max={65535}
              value={cfg.server.port}
              onChange={(e) => set('server', { port: Number(e.target.value) })}
              className={inputClass}
            />
          </Field>
        </Section>

        <Section icon="memory" title="Видео">
          <Field label="Устройство VAAPI" hint="Аппаратное декодирование на Linux; на macOS не используется">
            <Text value={cfg.ffmpeg.vaapiDevice} onChange={(vaapiDevice) => set('ffmpeg', { vaapiDevice })} />
          </Field>
        </Section>
      </div>
    </form>
  )
}

const inputClass = 'type-body-medium w-full rounded-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-surface-container-highest)] px-3 py-2 outline-none focus:ring-2 focus:ring-[var(--md-sys-color-primary)]'

/** Collapsible group; starts expanded only when something in it still needs filling in. */
function Section({ icon, title, ok = true, missing, children }: { icon: string; title: string; ok?: boolean; missing?: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(!ok)
  return (
    <section className="flex flex-col rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container-low)]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="state-layer state-on-surface relative flex items-center gap-2 rounded-[var(--md-sys-shape-corner-large)] p-4 text-left"
      >
        <span className="flex text-[var(--md-sys-color-primary)]"><Icon name={icon} size={20} /></span>
        <h3 className="type-title-small flex-1">{title}</h3>
        {!ok && (
          <span className="type-label-small rounded-full bg-[var(--md-sys-color-error-container)] px-2 py-0.5 text-[var(--md-sys-color-on-error-container)]">не настроено</span>
        )}
        <span className={`flex text-[var(--md-sys-color-on-surface-variant)] transition-transform duration-300 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}>
          <Icon name="expand_more" size={20} />
        </span>
      </button>
      {/* 0fr→1fr rows animate the height to the content's natural size. */}
      <div
        inert={!expanded}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--md-sys-motion-emphasized-decelerate)] motion-reduce:transition-none ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-3 px-4 pt-0.5 pb-4">
            {!ok && missing && <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{missing}</p>}
            {children}
          </div>
        </div>
      </div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">{label}</span>
      {children}
      {hint && <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{hint}</span>}
    </label>
  )
}

function Text({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} className={inputClass} />
}

function Secret({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} pr-10`}
      />
      <button
        type="button"
        aria-label={shown ? 'Скрыть' : 'Показать'}
        onClick={() => setShown((s) => !s)}
        className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--md-sys-color-on-surface-variant)]"
      >
        <Icon name={shown ? 'visibility_off' : 'visibility'} size={18} />
      </button>
    </div>
  )
}
