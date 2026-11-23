import { Button, Icon, Slider, TextField } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig } from '@/common/types/ipc'
import { SECTION_META } from '../lib/sections'
import { AppStatusChip, SecretField, SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'
import { SubtitleSourcesFields } from './SubtitleSourcesFields'

const OPENSUBTITLES_URL = 'https://www.opensubtitles.com/consumers'

export function SubsSection({
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
  const meta = SECTION_META.subs
  const hasKey = !!cfg.opensubtitles.apiKey.trim()
  const opacityPct = Math.round(cfg.subtitles.idleOpacity * 100)

  const openConsumers = () => {
    api.openUrl(OPENSUBTITLES_URL).catch((e) => notify('error', errorText(e)))
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title={meta.label}
        subtitle={meta.subtitle}
        icon={meta.icon}
        shape={meta.shape}
        tone={hasKey ? 'primary' : 'error'}
      />

      <section
        id="setting-subtitles.sources"
        data-focus-id="subtitles.sources"
        className={`flex flex-col gap-2.5 rounded-[24px] transition-shadow ${
          focusId === 'subtitles.sources' ? 'p-2 ring-2 ring-[var(--md-sys-color-primary)]' : ''
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="type-title-large type-emph">Порядок поиска</h3>
              {changedKeys.has('subtitles.sources') && (
                <AppStatusChip tone="primary" size="sm">
                  изменено
                </AppStatusChip>
              )}
              <code className="type-label-small rounded-[var(--md-sys-shape-corner-extra-small)] bg-[var(--md-sys-color-surface-container-highest)] px-1.5 py-0.5 font-mono text-[var(--md-sys-color-on-surface-variant)]">
                subtitles.sources
              </code>
            </div>
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              Сверху вниз до первого найденного. Перетащите строку за ручку или используйте кнопки и стрелки ↑ / ↓.
            </p>
          </div>
        </div>
        <SubtitleSourcesFields
          sources={cfg.subtitles.sources}
          hasOpenSubtitlesKey={hasKey}
          onChange={(sources) => set('subtitles', { sources })}
        />
      </section>

      <SettingGroup
        title="OpenSubtitles"
        subtitle="Ключа хватает; аккаунт поднимает лимит скачиваний в день."
        action={
          hasKey ? (
            <AppStatusChip tone="success" size="md" icon="check_circle">
              ключ задан
            </AppStatusChip>
          ) : (
            <AppStatusChip tone="error" size="md" icon="error">
              нет ключа
            </AppStatusChip>
          )
        }
      >
        <SettingRow
          focusId="opensubtitles.apiKey"
          highlighted={focusId === 'opensubtitles.apiKey'}
          changed={changedKeys.has('opensubtitles.apiKey')}
          configKey="opensubtitles.apiKey"
          label="API-ключ"
          below={
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[220px] flex-1">
                <SecretField
                  aria-label="API-ключ OpenSubtitles"
                  variant="outlined"
                  leading={<Icon name="key" size={20} />}
                  placeholder="Вставьте API-ключ"
                  value={cfg.opensubtitles.apiKey}
                  autoFocus={focusId === 'opensubtitles.apiKey'}
                  onValueChange={(apiKey) => set('opensubtitles', { apiKey })}
                />
              </div>
              <Button variant="text" trailingIcon="open_in_new" onClick={openConsumers}>
                Где взять
              </Button>
            </div>
          }
        />

        <SettingRow
          focusId="opensubtitles.account"
          highlighted={focusId === 'opensubtitles.account'}
          changed={changedKeys.has('opensubtitles.username') || changedKeys.has('opensubtitles.password')}
          configKey="opensubtitles.username · password"
          label="Аккаунт"
          sub="Необязательно"
          below={
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TextField
                variant="outlined"
                aria-label="Логин"
                placeholder="Логин"
                value={cfg.opensubtitles.username}
                spellCheck={false}
                leading={<Icon name="person" size={20} />}
                onChange={(e) => set('opensubtitles', { username: e.target.value })}
              />
              <SecretField
                aria-label="Пароль OpenSubtitles"
                variant="outlined"
                leading={<Icon name="lock" size={20} />}
                placeholder="Пароль"
                value={cfg.opensubtitles.password}
                onValueChange={(password) => set('opensubtitles', { password })}
              />
            </div>
          }
        />
      </SettingGroup>

      <SettingGroup
        title="Панель «Диалоги»"
        subtitle="Поведение списка реплик в плеере, когда интерфейс скрывается."
      >
        <SettingRow
          focusId="subtitles.idleOpacity"
          highlighted={focusId === 'subtitles.idleOpacity'}
          changed={changedKeys.has('subtitles.idleOpacity')}
          configKey="subtitles.idleOpacity"
          label="Яркость неактивных реплик"
          sub="Когда панели плеера скрыты. При наведении на «Диалоги» и на паузе — всегда 100%."
          control={
            <AppStatusChip tone="primary" size="md" className="tabular-nums">
              {opacityPct}%
            </AppStatusChip>
          }
          below={
            <div className="flex flex-col gap-3">
              <Slider
                size="md"
                min={0}
                max={100}
                step={1}
                value={opacityPct}
                label="Яркость неактивных реплик"
                onChange={(v) => set('subtitles', { idleOpacity: Math.round(v) / 100 })}
              />

              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => set('subtitles', { idleOpacity: 0 })}
                  className="type-body-small text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]"
                >
                  0% · скрыть
                </button>
                <button
                  type="button"
                  onClick={() => set('subtitles', { idleOpacity: 0.36 })}
                  className={`type-label-medium transition-colors ${
                    opacityPct === 36
                      ? 'type-emph text-[var(--md-sys-color-primary)]'
                      : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-primary)]'
                  }`}
                >
                  36% · по умолчанию
                </button>
                <button
                  type="button"
                  onClick={() => set('subtitles', { idleOpacity: 1 })}
                  className="type-body-small text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]"
                >
                  100% · не приглушать
                </button>
              </div>

              <div
                aria-label="Предпросмотр панели «Диалоги»"
                className="flex flex-col gap-1.5 rounded-[16px] bg-[var(--md-sys-color-surface-container-lowest)] p-3.5"
              >
                <div
                  className="flex items-center gap-2.5 px-3 py-1 transition-opacity duration-150"
                  style={{ opacity: cfg.subtitles.idleOpacity }}
                >
                  <span className="type-label-small shrink-0 tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                    29:07
                  </span>
                  <span className="type-body-medium min-w-0 flex-1 text-[var(--md-sys-color-on-surface)]">
                    We&apos;ve already got this on the greatest hits tape.
                  </span>
                </div>

                <div
                  className="flex items-center gap-2.5 rounded-[12px] border border-[var(--md-sys-color-secondary-container)] px-3 py-2"
                  style={{
                    background:
                      'color-mix(in srgb, var(--md-sys-color-secondary-container) 42%, var(--md-sys-color-surface-container-low))',
                    color: 'var(--app-dialog-text)',
                  }}
                >
                  <span className="type-label-small shrink-0 tabular-nums opacity-80">29:10</span>
                  <span className="type-title-small type-emph min-w-0 flex-1">Can I borrow that?</span>
                  <AppStatusChip tone="primary" size="sm">
                    активная · 100%
                  </AppStatusChip>
                </div>

                <div
                  className="flex items-center gap-2.5 px-3 py-1 transition-opacity duration-150"
                  style={{ opacity: cfg.subtitles.idleOpacity }}
                >
                  <span className="type-label-small shrink-0 tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                    29:18
                  </span>
                  <span className="type-body-medium min-w-0 flex-1 text-[var(--md-sys-color-on-surface)]">
                    Close, but no cigar.
                  </span>
                </div>
              </div>
            </div>
          }
        />
      </SettingGroup>
    </div>
  )
}
