import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Dialog, Icon, IconButton, Select, Spinner, Switch, TextField, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, LlmProvider, SetupStatus, SetupStep } from '@/common/types/ipc'
import { IMAGE_BACKENDS, imageRouteLabel, tutorOwnsImages } from './ImageFields'
import { LlmFields } from './LlmFields'
import { CEFR, SecretField, type ApplyConfig } from './SettingsPrimitives'

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

const HINT = 'type-body-small text-[var(--md-sys-color-on-surface-variant)]'

/** First-run wizard: one topic per step using m3e kit controls, plus an agent hand-off. */
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
      <div className="flex shrink-0 items-center justify-between px-6 pt-5 pb-2">
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
        <div className="px-6 pb-6">
          <Spinner label="Загрузка" className="m-6" />
        </div>
      )}
    </Dialog>
  )
}

function Progress({ step }: { step: Step }) {
  return (
    <div className="flex shrink-0 gap-1.5 px-6 pb-4">
      {STEPS.map((s) => (
        <span
          key={s}
          className={`size-1.5 rounded-full ${s === step ? 'bg-[var(--md-sys-color-primary)]' : 'bg-[var(--md-sys-color-outline-variant)]'}`}
        />
      ))}
    </div>
  )
}

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

  const set: ApplyConfig = (section, patch) => setCfg((c) => ({ ...c, [section]: { ...c[section], ...patch } }))
  const go = (delta: number) => onGo(STEPS[STEPS.indexOf(step) + delta])
  const next = () => {
    if (dirty) save.mutate(undefined, { onSuccess: () => go(1) })
    else go(1)
  }

  return (
    <>
      <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain">
        {/* Keep a natural-height column inside the scrollport so short windows scroll instead of squeezing fields. */}
        <div className={`flex flex-col px-6 ${step === 'welcome' ? 'gap-5 pb-6' : 'gap-4 pb-4'}`}>
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
      </div>
      <Footer
        step={step}
        dirty={dirty}
        pending={save.isPending}
        onBack={() => go(-1)}
        onSkip={() => go(1)}
        onNext={next}
      />
    </>
  )
}

function Footer({
  step,
  dirty,
  pending,
  onBack,
  onSkip,
  onNext,
}: {
  step: Step
  dirty: boolean
  pending: boolean
  onBack: () => void
  onSkip: () => void
  onNext: () => void
}) {
  if (step === 'welcome') return null
  const editable = step !== 'done'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--md-sys-color-outline-variant)] px-6 py-4">
      <Button variant="text" onClick={onBack}>Назад</Button>
      <span className="flex-1" />
      {editable && <Button variant="text" onClick={onSkip}>Пропустить</Button>}
      {editable && (
        <Button variant="filled" disabled={pending} onClick={onNext}>
          {dirty ? 'Сохранить и далее' : 'Далее'}
        </Button>
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

function Welcome({
  prompt,
  steps,
  agentMode,
  onAgentMode,
  onStart,
  onFinish,
}: {
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
      <p className="type-body-large">
        Плеер показывает английские субтитры с переводом, подсвечивает идиомы и грамматику и добавляет фразы в Anki.
        Настройка займёт пару минут, любой шаг можно пропустить и вернуться к нему позже через Настройки → «Мастер настройки».
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="filled" onClick={onStart}>Настроить по шагам</Button>
        <Button variant="tonal" onClick={onAgentMode}>Настроить с агентом</Button>
      </div>
      {agentMode && (
        <>
          <p className="type-body-medium">
            Вставьте этот текст своему агенту (Claude Code, Codex, omp…): он прочитает инструкцию и настроит плеер через локальный API.
          </p>
          <TextField multiline readOnly rows={5} aria-label="Промпт для ИИ-агента" variant="outlined" value={prompt} />
          <div>
            <Button variant="tonal" icon="content_copy" onClick={copy}>Скопировать</Button>
          </div>
          <StatusList steps={steps} />
          <div>
            <Button variant="filled" onClick={onFinish}>К итогам</Button>
          </div>
        </>
      )}
    </>
  )
}

function StepLlm({ cfg, providers, set }: { cfg: AppConfig; providers: LlmProvider[] | undefined; set: ApplyConfig }) {
  return (
    <>
      <p className="type-body-medium">
        Без LLM плеер покажет только субтитры. Подойдёт ключ DeepSeek или провайдер, уже настроенный в ваших агентах.
      </p>
      <LlmFields llm={cfg.llm} providers={providers} onChange={(p) => set('llm', p)} />
      <Select
        label="Мой уровень"
        hint="Если Tutor запущен, уровень берётся из него"
        variant="outlined"
        value={cfg.learner.cefr}
        onChange={(e) => set('learner', { cefr: e.target.value })}
      >
        {CEFR.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </Select>
    </>
  )
}

function StepSubs({ cfg, set }: { cfg: AppConfig; set: ApplyConfig }) {
  return (
    <>
      <p className="type-body-medium">
        Ключ OpenSubtitles нужен, чтобы находить субтитры, даже если их нет в раздаче. Получить:{' '}
        <span className="select-all">https://www.opensubtitles.com/consumers</span>.
      </p>
      <SecretField
        label="API-ключ"
        variant="outlined"
        value={cfg.opensubtitles.apiKey}
        onValueChange={(apiKey) => set('opensubtitles', { apiKey })}
      />
      <TextField
        label="Логин"
        variant="outlined"
        value={cfg.opensubtitles.username}
        spellCheck={false}
        onChange={(e) => set('opensubtitles', { username: e.target.value })}
      />
      <SecretField
        label="Пароль"
        variant="outlined"
        value={cfg.opensubtitles.password}
        onValueChange={(password) => set('opensubtitles', { password })}
      />
    </>
  )
}

function StepLampa({
  origins,
  setOrigins,
  port,
}: {
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
      <TextField
        multiline
        rows={3}
        label="Разрешённые адреса Lampa"
        hint="По одному на строку, например https://lampa.example.com"
        variant="outlined"
        value={origins}
        onChange={(e) => setOrigins(e.target.value)}
      />
    </>
  )
}

function StepAnki({ cfg, hint, set }: { cfg: AppConfig; hint: string; set: ApplyConfig }) {
  const ownsImages = tutorOwnsImages(cfg.tutor)
  return (
    <>
      <p className="type-body-medium">
        Карточки создаются прямо в Anki через AnkiConnect (Anki должен быть запущен с дополнением AnkiConnect).
      </p>
      <TextField
        label="Колода"
        variant="outlined"
        value={cfg.anki.deck}
        spellCheck={false}
        onChange={(e) => set('anki', { deck: e.target.value })}
      />
      <Select
        label="Основной провайдер картинок"
        hint={
          ownsImages
            ? 'Основной провайдер берётся из tutor; запасные задаются в Настройки → Картинки.'
            : 'Запасные провайдеры и стиль задаются в Настройки → Картинки.'
        }
        variant="outlined"
        value={cfg.images.backend}
        disabled={ownsImages}
        onChange={(e) => set('images', { backend: e.target.value as AppConfig['images']['backend'] })}
      >
        {IMAGE_BACKENDS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </Select>
      <p className={HINT}>Порядок попыток: {imageRouteLabel(cfg.images, cfg.tutor)}</p>
      <Switch
        label="Быстрое добавление без предпросмотра"
        checked={cfg.anki.quickAdd}
        onChange={(quickAdd) => set('anki', { quickAdd })}
      />
      <p className={HINT}>
        Клик по слову сразу собирает карточку: пять секунд на «Отменить» или «Редактировать», затем карточка
        добавляется в Anki в фоне. Воспроизведение не останавливается.
      </p>
      <Switch
        label="Tutor — необязательный аддон (уровень CEFR, отправка сценария)"
        checked={cfg.tutor.enabled}
        onChange={(enabled) => {
          // Turning ownership off makes the app backend primary again; it must not stay a fallback.
          if (!enabled) set('images', { fallbacks: cfg.images.fallbacks.filter((b) => b !== cfg.images.backend) })
          set('tutor', { enabled })
        }}
      />
      <p className={HINT}>{hint}</p>
      <p className={HINT}>Подробные настройки — в разделе «Anki» и «Картинки».</p>
    </>
  )
}

function Finished({ steps, onFinish }: { steps: SetupStep[]; onFinish: () => void }) {
  return (
    <>
      <StatusList steps={steps} />
      <div>
        <Button variant="filled" onClick={onFinish}>Начать</Button>
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
      ))}
    </ul>
  )
}
