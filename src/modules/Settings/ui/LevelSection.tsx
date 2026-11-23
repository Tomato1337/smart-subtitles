import { Button, Segmented, Switch } from '@tomato1337/m3e-react'
import type { AppConfig } from '@/common/types/ipc'
import { SECTION_META } from '../lib/sections'
import { CEFR, SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'

const CEFR_OPTIONS = CEFR.map((l) => ({ value: l, label: l }))

type CefrSample = {
  before: string
  colloc: string
  middle: string
  idiom: string
  after: string
  ru: string
  note: string
}

const SAMPLES: Record<string, CefrSample> = {
  A1: {
    before: "I'm ",
    colloc: 'looking forward to',
    middle: ' seeing you, ',
    idiom: 'by the way',
    after: '.',
    ru: 'С нетерпением жду встречи с тобой, кстати.',
    note: 'На A1 подсвечиваются почти все устойчивые сочетания и базовые фразовые глаголы.',
  },
  A2: {
    before: 'We should ',
    colloc: 'make up our minds',
    middle: ' before it is ',
    idiom: 'out of hand',
    after: '.',
    ru: 'Нам стоит решиться, пока всё не вышло из-под контроля.',
    note: 'Простые слова уровня A1 не отвлекают; выражения выше A2 объясняются простым языком.',
  },
  B1: {
    before: "I've ",
    colloc: 'been alone',
    middle: ' for ',
    idiom: 'as long as I can remember',
    after: '.',
    ru: 'Я одна столько, сколько себя помню.',
    note: 'Слова A1–A2 не подсвечиваются; выражения выше B2 объясняются проще.',
  },
  B2: {
    before: 'He decided to ',
    colloc: 'take it with a grain of salt',
    middle: ' and ',
    idiom: 'call it a day',
    after: '.',
    ru: 'Он решил отнестись к этому скептически и закончить на сегодня.',
    note: 'Подсвечиваются преимущественно идиомы, сленг и редкие коллокации уровня B2+.',
  },
  C1: {
    before: 'Her argument ',
    colloc: 'held water',
    middle: ', though it ',
    idiom: 'flew in the face of',
    after: ' convention.',
    ru: 'Её довод выдержал проверку, хотя и противоречил традициям.',
    note: 'Лексика B1–B2 считается знакомой; акцент на тонкой идиоматике и редукциях.',
  },
  C2: {
    before: 'They ',
    colloc: 'skated on thin ice',
    middle: ' and nearly ',
    idiom: 'upset the applecart',
    after: '.',
    ru: 'Они ходили по тонкому льду и чуть не расстроили все планы.',
    note: 'Подсвечиваются только редкие идиомы, культурные отсылки и неформальный сленг.',
  },
}

export function LevelSection({
  cfg,
  set,
  changedKeys,
  focusId,
}: {
  cfg: AppConfig
  set: ApplyConfig
  changedKeys: Set<string>
  focusId?: string
}) {
  const meta = SECTION_META.level
  const sample = SAMPLES[cfg.learner.cefr] ?? SAMPLES.B1

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader title={meta.label} subtitle={meta.subtitle} icon={meta.icon} shape={meta.shape} tone={meta.tone} />

      <SettingGroup title="Мой уровень">
        <SettingRow
          focusId="learner.cefr"
          highlighted={focusId === 'learner.cefr'}
          changed={changedKeys.has('learner.cefr')}
          configKey="learner.cefr"
          label="CEFR"
          sub={
            cfg.tutor.enabled
              ? 'Tutor включён — при наличии профиля в Tutor уровень берётся оттуда.'
              : 'Если включён Tutor, уровень берётся из него.'
          }
          control={
            <Segmented
              label="Уровень CEFR"
              value={cfg.learner.cefr}
              options={CEFR_OPTIONS}
              onChange={(cefr) => set('learner', { cefr })}
            />
          }
        />

        <SettingRow
          label="Предпросмотр"
          below={
            <div className="flex flex-col gap-3 rounded-[16px] bg-[var(--md-sys-color-surface-container-lowest)] p-5">
              <span className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">
                Так это выглядит на {cfg.learner.cefr}
              </span>
              <p className="type-headline-small type-emph leading-snug">
                {sample.before}
                <span
                  style={{
                    textDecoration: 'underline',
                    textDecorationColor: 'var(--app-kind-collocation)',
                    textDecorationThickness: '2px',
                    textUnderlineOffset: '0.22em',
                  }}
                >
                  {sample.colloc}
                </span>
                {sample.middle}
                <span
                  style={{
                    textDecoration: 'underline',
                    textDecorationColor: 'var(--app-kind-idiom)',
                    textDecorationThickness: '2px',
                    textUnderlineOffset: '0.22em',
                  }}
                >
                  {sample.idiom}
                </span>
                {sample.after}
              </p>
              <p className="type-body-large text-[var(--md-sys-color-on-surface-variant)]">{sample.ru}</p>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <LegendMark color="var(--app-kind-idiom)" label="идиома" />
                <LegendMark color="var(--app-kind-collocation)" label="сочетание" />
                <LegendMark color="var(--app-kind-phrasal-verb)" label="фразовый глагол" />
              </div>
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{sample.note}</p>
            </div>
          }
        />
      </SettingGroup>

      <SettingGroup
        title="Разбор диалогов"
        subtitle="Разбор переводит все реплики фильма фоном; стоимость видна до запуска."
      >
        <SettingRow
          focusId="annot.auto"
          highlighted={focusId === 'annot.auto'}
          changed={changedKeys.has('annot.auto')}
          configKey="annot.auto"
          label="Начинать без вопроса"
          sub="Только пока модель разбора совпадает с запомненной."
          control={
            <Switch
              ariaLabel="Начинать без вопроса"
              checked={cfg.annot.auto}
              onChange={(auto) => set('annot', { auto })}
            />
          }
        />

        <SettingRow
          focusId="annot.rememberedModel"
          highlighted={focusId === 'annot.rememberedModel'}
          changed={changedKeys.has('annot.rememberedModel')}
          configKey="annot.rememberedModel"
          label="Запомненная модель"
          sub={cfg.annot.rememberedModel || 'Ничего не запомнено — перед разбором будет вопрос'}
          control={
            <Button
              variant="outlined"
              icon="delete"
              disabled={!cfg.annot.rememberedModel}
              onClick={() => set('annot', { rememberedModel: '' })}
            >
              Забыть
            </Button>
          }
        />
      </SettingGroup>
    </div>
  )
}

function LegendMark({ color, label }: { color: string; label: string }) {
  return (
    <span className="type-body-small inline-flex items-center gap-1.5 text-[var(--md-sys-color-on-surface-variant)]">
      <span className="h-[3px] w-4 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}
