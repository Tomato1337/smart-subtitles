import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Dialog, Icon, IconButton, Spinner, Switch, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, LlmProvider, SetupStatus, SetupStep } from '@/common/types/ipc'
import { IMAGE_BACKENDS } from './ImageFields'
import { LlmFields } from './LlmFields'
import { CEFR, Field, Secret, Text, inputClass } from './SettingsPanel'

const STEPS = ['welcome', 'llm', 'opensubtitles', 'lampa', 'anki', 'done'] as const
type Step = (typeof STEPS)[number]

const TITLES: Record<Step, string> = {
  welcome: 'Добро пожаловать в Smart Subtitles',
  llm: 'Перевод и разбор',
  opensubtitles: 'Субтитры',
  lampa: 'Lampa',
  anki: 'Anki и карточки',
  done: 'Готово',
}

const IMPORTANCE_RU: Record<SetupStep['importance'], string> = {
  required: 'обязательно',
  recommended: 'желательно',
  optional: 'необязательно',
}

const PRIMARY =
  'state-layer state-on-primary type-label-large relative flex items-center gap-2 rounded-full bg-[var(--md-sys-color-primary)] px-5 py-2 text-[var(--md-sys-color-on-primary)] disabled:opacity-40'
const TONAL =
  'state-layer type-label-large relative rounded-full bg-[var(--md-sys-color-secondary-container)] px-5 py-2 text-[var(--md-sys-color-on-secondary-container)]'
const TEXT_BUTTON = 'state-layer state-on-surface type-label-large relative rounded-full px-4 py-2 text-[var(--md-sys-color-primary)]'
const HINT = 'type-body-small text-[var(--md-sys-color-on-surface-variant)]'

/** First-run wizard: the same fields as the settings panel, one topic per step, plus an agent hand-off. */
export function SetupWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('welcome')
  const [agentMode, setAgentMode] = useState(false)
  const config = useQuery({ queryKey: ['config'], queryFn: api.configGet })
  const providers = useQuery({ queryKey: ['llm-providers'], queryFn: api.llmProviders })
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setupStatus })

  const saved = config.data
  const status = setup.data

  return (
    <Dialog onClose={onClose} dismissible label="Настройка Smart Subtitles" className="max-h-[90vh] w-[720px] max-w-[96vw] p-0">
      <div className="flex items-center justify-between px-6 pt-5 pb-2">
        <h2 className="type-headline-small">{TITLES[step]}</h2>
        <IconButton icon="close" label="Закрыть" onClick={onClose} />
      </div>
      <Progress step={step} />
      {saved && status ? (
        // Remount on every saved snapshot, including agent edits, so the draft starts from disk.
        <Body
          key={JSON.stringify(saved)}
          saved={saved}
          providers={providers.data}
          setup={status}
          step={step}
          agentMode={agentMode}
          onAgentMode={() => setAgentMode(true)}
          onGo={setStep}
          onClose={onClose}
        />
      ) : (
        <div className="min-h-0 flex-1 px-6 pb-6"><Spinner label="Загрузка" className="m-6" /></div>
      )}
    </Dialog>
  )
}

function Progress({ step }: { step: Step }) {
  return (
    <div className="flex gap-1.5 px-6 pb-3">
      {STEPS.map((s) => (
        <span
          key={s}
          className={`size-1.5 rounded-full ${s === step ? 'bg-[var(--md-sys-color-primary)]' : 'bg-[var(--md-sys-color-outline-variant)]'}`}
        />
      ))}
    </div>
  )
}

type Apply = <S extends keyof AppConfig>(section: S, patch: Partial<AppConfig[S]>) => void

type BodyProps = {
  saved: AppConfig
  providers: LlmProvider[] | undefined
  setup: SetupStatus
  step: Step
  agentMode: boolean
  onAgentMode: () => void
  onGo: (s: Step) => void
  onClose: () => void
}

function Body({ saved, providers, setup, step, agentMode, onAgentMode, onGo, onClose }: BodyProps) {
  const qc = useQueryClient()
  const [cfg, setCfg] = useState(saved)
  // Origins are edited as free text; split only on save so typing a newline is not eaten.
  const [origins, setOrigins] = useState(saved.lampa.origins.join('\n'))
  const draft: AppConfig = { ...cfg, lampa: { origins: origins.split('\n').map((s) => s.trim()).filter(Boolean) } }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const save = useMutation({
    mutationFn: () => api.configSave(draft),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config'] })
      void qc.invalidateQueries({ queryKey: ['setup'] })
    },
    onError: (e) => notify('error', errorText(e)),
  })

  const set: Apply = (section, patch) => setCfg((c) => ({ ...c, [section]: { ...c[section], ...patch } }))
  const go = (delta: number) => onGo(STEPS[STEPS.indexOf(step) + delta])
  const next = () => { if (dirty) save.mutate(undefined, { onSuccess: () => go(1) }); else go(1) }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
        {step === 'welcome' && (
          <Welcome
            prompt={promptFor(setup.guideUrl)}
            steps={setup.steps}
            agentMode={agentMode}
            onAgentMode={onAgentMode}
            onStart={() => onGo('llm')}
            onFinish={() => onGo('done')}
          />
        )}
        {step === 'llm' && <StepLlm cfg={cfg} providers={providers} set={set} />}
        {step === 'opensubtitles' && <StepSubs cfg={cfg} set={set} />}
        {step === 'lampa' && <StepLampa origins={origins} setOrigins={setOrigins} port={setup.port} />}
        {step === 'anki' && <StepAnki cfg={cfg} hint={setup.steps.find((s) => s.id === 'anki')?.hint ?? ''} set={set} />}
        {step === 'done' && <Finished steps={setup.steps} onFinish={onClose} />}
      </div>
      <Footer
        step={step}
        dirty={dirty}
        pending={save.isPending}
        onBack={() => go(-1)}
        onSkip={() => go(1)}
        onNext={next}
      />
    </div>
  )
}

function Footer({ step, dirty, pending, onBack, onSkip, onNext }: {
  step: Step
  dirty: boolean
  pending: boolean
  onBack: () => void
  onSkip: () => void
  onNext: () => void
}) {
  const editable = step !== 'welcome' && step !== 'done'
  return (
    <div className="flex items-center gap-2 border-t border-[var(--md-sys-color-outline-variant)] px-6 py-4">
      {step !== 'welcome' && <button type="button" className={TEXT_BUTTON} onClick={onBack}>Назад</button>}
      <span className="flex-1" />
      {editable && <button type="button" className={TEXT_BUTTON} onClick={onSkip}>Пропустить</button>}
      {editable && (
        <button type="button" className={PRIMARY} disabled={pending} onClick={onNext}>
          {dirty ? 'Сохранить и далее' : 'Далее'}
        </button>
      )}
    </div>
  )
}

function promptFor(guideUrl: string): string {
  return [
    'Помоги мне настроить видеоплеер Smart Subtitles — он уже запущен на этом компьютере.',
    `Инструкция для агентов: ${guideUrl}`,
    `Прочитай её (curl -s ${guideUrl}), проверь через API, что ещё не настроено, и по очереди помоги с каждым пунктом. Ключи и пароли спрашивай у меня и не повторяй их в ответах.`,
  ].join('\n')
}

function Welcome({ prompt, steps, agentMode, onAgentMode, onStart, onFinish }: {
  prompt: string
  steps: SetupStep[]
  agentMode: boolean
  onAgentMode: () => void
  onStart: () => void
  onFinish: () => void
}) {
  const copy = () => {
    navigator.clipboard.writeText(prompt).then(
      () => toast('Промпт скопирован'),
      () => notify('warn', 'Не удалось скопировать — выделите текст вручную'),
    )
  }
  const deps = steps.find((s) => s.id === 'deps')
  return (
    <>
      {deps && !deps.done && (
        <p className="type-body-medium rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-error-container)] px-4 py-3 text-[var(--md-sys-color-on-error-container)]">
          {deps.hint}
        </p>
      )}
      <p className="type-body-medium">
        Плеер показывает английские субтитры с переводом, подсвечивает идиомы и грамматику и добавляет фразы в Anki.
        Настройка займёт пару минут, любой шаг можно пропустить и вернуться к нему позже через ⚙ → «Мастер настройки».
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={PRIMARY} onClick={onStart}>Настроить по шагам</button>
        <button type="button" className={TONAL} onClick={onAgentMode}>Настроить с агентом</button>
      </div>
      {agentMode && (
        <>
          <p className="type-body-medium">
            Вставьте этот текст своему агенту (Claude Code, Codex, omp…): он прочитает инструкцию и настроит плеер через локальный API.
          </p>
          <textarea readOnly rows={5} value={prompt} className={`${inputClass} resize-y`} />
          <div>
            <button type="button" className={TONAL} onClick={copy}>Скопировать</button>
          </div>
          <StatusList steps={steps} />
          <div>
            <button type="button" className={PRIMARY} onClick={onFinish}>К итогам</button>
          </div>
        </>
      )}
    </>
  )
}

function StepLlm({ cfg, providers, set }: { cfg: AppConfig; providers: LlmProvider[] | undefined; set: Apply }) {
  return (
    <>
      <p className="type-body-medium">
        Без LLM плеер покажет только субтитры. Подойдёт ключ DeepSeek или провайдер, уже настроенный в ваших агентах.
      </p>
      <LlmFields llm={cfg.llm} providers={providers} onChange={(p) => set('llm', p)} />
      <Field label="Мой уровень" hint="Если Tutor запущен, уровень берётся из него">
        <select value={cfg.learner.cefr} onChange={(e) => set('learner', { cefr: e.target.value })} className={inputClass}>
          {CEFR.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Field>
    </>
  )
}

function StepSubs({ cfg, set }: { cfg: AppConfig; set: Apply }) {
  return (
    <>
      <p className="type-body-medium">
        Ключ OpenSubtitles нужен, чтобы находить субтитры, даже если их нет в раздаче. Получить:{' '}
        <span className="select-all">https://www.opensubtitles.com/consumers</span>.
      </p>
      <Field label="API-ключ">
        <Secret value={cfg.opensubtitles.apiKey} onChange={(apiKey) => set('opensubtitles', { apiKey })} />
      </Field>
      <Field label="Логин">
        <Text value={cfg.opensubtitles.username} onChange={(username) => set('opensubtitles', { username })} />
      </Field>
      <Field label="Пароль">
        <Secret value={cfg.opensubtitles.password} onChange={(password) => set('opensubtitles', { password })} />
      </Field>
    </>
  )
}

function StepLampa({ origins, setOrigins, port }: {
  origins: string
  setOrigins: (v: string) => void
  port: number
}) {
  return (
    <>
      <p className="type-body-medium">
        Чтобы открывать фильмы из Lampa, добавьте в Lampa плагин и впишите сюда её адрес. Плагин для Lampa по http:{' '}
        <span className="select-all">http://127.0.0.1:{port}/lampa/smartsubs.js</span>
      </p>
      <Field label="Разрешённые адреса Lampa" hint="По одному на строку, например https://lampa.example.com">
        <textarea value={origins} rows={3} onChange={(e) => setOrigins(e.target.value)} className={`${inputClass} resize-y`} />
      </Field>
    </>
  )
}

function StepAnki({ cfg, hint, set }: { cfg: AppConfig; hint: string; set: Apply }) {
  return (
    <>
      <p className="type-body-medium">
        Карточки создаются прямо в Anki через AnkiConnect (Anki должен быть запущен с дополнением AnkiConnect).
      </p>
      <Field label="Колода">
        <Text value={cfg.anki.deck} onChange={(deck) => set('anki', { deck })} />
      </Field>
      <Field label="Картинки">
        <select
          className={inputClass}
          value={cfg.images.backend}
          onChange={(e) => set('images', { backend: e.target.value as AppConfig['images']['backend'] })}
        >
          {IMAGE_BACKENDS.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </Field>
      <Switch
        label="Tutor — необязательный аддон (уровень CEFR, отправка сценария)"
        checked={cfg.tutor.enabled}
        onChange={(enabled) => set('tutor', { enabled })}
      />
      <p className={HINT}>{hint}</p>
      <p className={HINT}>Подробные настройки — в панели настроек → Anki и карточки.</p>
    </>
  )
}

function Finished({ steps, onFinish }: { steps: SetupStep[]; onFinish: () => void }) {
  return (
    <>
      <StatusList steps={steps} />
      <div>
        <button type="button" className={PRIMARY} onClick={onFinish}>Начать</button>
      </div>
    </>
  )
}

function StatusList({ steps }: { steps: SetupStep[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2">
          <span className={`flex ${s.done ? 'text-[var(--md-sys-color-primary)]' : 'text-[var(--md-sys-color-on-surface-variant)]'}`}>
            <Icon name={s.done ? 'check_circle' : 'radio_button_unchecked'} size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2">
              <span className="type-title-small">{s.title}</span>
              <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">{IMPORTANCE_RU[s.importance]}</span>
            </div>
            <span className={HINT}>{s.hint}</span>
          </div>
        </li>
      ))
      }
    </ul >
  )
}
