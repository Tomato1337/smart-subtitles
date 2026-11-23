import { useState } from 'react'
import { Button, Icon, IconButton, TextField } from '@tomato1337/m3e-react'
import type { AppConfig, SystemInfo } from '@/common/types/ipc'
import { SECTION_META } from '../lib/sections'
import { AppStatusChip, CopyBox, SecretField, SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'

function formatLastSeen(unixSec: number | undefined): string | null {
  if (!unixSec) return null
  const diffSec = Math.max(0, Math.round(Date.now() / 1000 - unixSec))
  if (diffSec < 60) return 'открывал фильм только что'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `открывал фильм ${diffMin} мин назад`
  const diffHours = Math.round(diffMin / 60)
  if (diffHours < 24) return `открывал фильм ${diffHours} ч назад`
  return `открывал фильм ${Math.round(diffHours / 24)} дн назад`
}

function originError(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.origin !== s) return 'Укажите только origin без пути и слеша в конце (например https://lampa.example.com)'
    return null
  } catch {
    return 'Нужен полный адрес с протоколом http:// или https://'
  }
}

function parsePort(raw: string): { port: number | null; error: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { port: null, error: 'Укажите порт от 1 до 65535' }
  if (!/^\d+$/.test(trimmed)) return { port: null, error: 'Только целое число 1–65535' }
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: null, error: 'Допустимый диапазон: 1–65535' }
  }
  return { port, error: null }
}

export function LampaSection({
  cfg,
  set,
  systemInfo,
  changedKeys,
  focusId,
}: {
  cfg: AppConfig
  set: ApplyConfig
  systemInfo?: SystemInfo
  changedKeys: Set<string>
  focusId?: string
}) {
  const meta = SECTION_META.lampa
  const [newOrigin, setNewOrigin] = useState('')
  const [portText, setPortText] = useState(() => (Number.isFinite(cfg.server.port) ? String(cfg.server.port) : ''))
  const [prevCfgPort, setPrevCfgPort] = useState(cfg.server.port)
  if (cfg.server.port !== prevCfgPort) {
    setPrevCfgPort(cfg.server.port)
    setPortText(Number.isFinite(cfg.server.port) ? String(cfg.server.port) : '')
  }
  const portErr = parsePort(portText).error
  const port = systemInfo?.listenPort ?? cfg.server.port
  const pluginUrl = `http://127.0.0.1:${port}/lampa/smartsubs.js`
  const hasOrigins = cfg.lampa.origins.length > 0
  const hasSeen = !!systemInfo && Object.keys(systemInfo.lampaLastSeen).length > 0
  const validationErr = originError(newOrigin)

  const addOrigin = () => {
    const trimmed = newOrigin.trim()
    if (!trimmed) return
    if (cfg.lampa.origins.includes(trimmed)) {
      setNewOrigin('')
      return
    }
    set('lampa', { origins: [...cfg.lampa.origins, trimmed] })
    setNewOrigin('')
  }

  const removeOrigin = (origin: string) => {
    set('lampa', { origins: cfg.lampa.origins.filter((o) => o !== origin) })
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader title={meta.label} subtitle={meta.subtitle} icon={meta.icon} shape={meta.shape} tone={meta.tone} />

      <SettingGroup
        title="Lampa"
        subtitle="Без адреса плагин получит отказ (403)."
        action={
          !hasOrigins ? (
            <AppStatusChip tone="error" size="md" icon="error">
              нет адреса
            </AppStatusChip>
          ) : hasSeen ? (
            <AppStatusChip tone="success" size="md" icon="check_circle">
              подключена
            </AppStatusChip>
          ) : (
            <AppStatusChip tone="primary" size="md" icon="check_circle">
              адресов: {cfg.lampa.origins.length}
            </AppStatusChip>
          )
        }
      >
        <SettingRow
          focusId="lampa.origins"
          highlighted={focusId === 'lampa.origins'}
          changed={changedKeys.has('lampa.origins')}
          configKey="lampa.origins"
          label="Разрешённые адреса"
          below={
            <div className="flex flex-col gap-2">
              {cfg.lampa.origins.map((origin) => {
                const seen = formatLastSeen(systemInfo?.lampaLastSeen[origin])
                return (
                  <div
                    key={origin}
                    className="flex min-h-12 flex-wrap items-center gap-3 rounded-[12px] bg-[var(--md-sys-color-surface-container-high)] py-1.5 pr-1.5 pl-4"
                  >
                    <Icon name="language" size={20} className="shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
                    <span className="type-body-large min-w-0 flex-1 break-all">{origin}</span>
                    {seen && (
                      <AppStatusChip tone="neutral" size="sm">
                        {seen}
                      </AppStatusChip>
                    )}
                    <IconButton icon="close" label={`Удалить ${origin}`} onClick={() => removeOrigin(origin)} />
                  </div>
                )
              })}

              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-[220px] flex-1">
                  <TextField
                    aria-label="Новый адрес Lampa"
                    variant="outlined"
                    leading={<Icon name="add_link" size={20} />}
                    placeholder="https://lampa.example.com"
                    value={newOrigin}
                    error={validationErr ?? undefined}
                    spellCheck={false}
                    autoFocus={focusId === 'lampa.origins'}
                    onChange={(e) => setNewOrigin(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addOrigin()
                      }
                    }}
                  />
                </div>
                <Button
                  variant="tonal"
                  icon="add"
                  disabled={!newOrigin.trim() || !!validationErr}
                  onClick={addOrigin}
                >
                  Добавить
                </Button>
              </div>
            </div>
          }
        />

        <SettingRow
          focusId="lampa.plugin"
          highlighted={focusId === 'lampa.plugin'}
          label="Плагин"
          sub="Добавьте адрес в Lampa → Настройки → Расширения."
          below={<CopyBox value={pluginUrl} copiedMessage="Адрес плагина скопирован" />}
        />
      </SettingGroup>

      <SettingGroup title="TorrServer" subtitle="Нужен, только если TorrServer закрыт паролем.">
        <SettingRow
          focusId="torrserver.baseUrl"
          highlighted={focusId === 'torrserver.baseUrl'}
          changed={changedKeys.has('torrserver.baseUrl')}
          configKey="torrserver.baseUrl"
          label="Адрес"
          sub="Например https://example.com/tor"
          control={
            <div className="w-full sm:w-[320px]">
              <TextField
                aria-label="Адрес TorrServer"
                variant="outlined"
                placeholder="https://…"
                value={cfg.torrserver.baseUrl}
                spellCheck={false}
                onChange={(e) => set('torrserver', { baseUrl: e.target.value })}
              />
            </div>
          }
        />

        <SettingRow
          focusId="torrserver.auth"
          highlighted={focusId === 'torrserver.auth'}
          changed={changedKeys.has('torrserver.username') || changedKeys.has('torrserver.password')}
          configKey="torrserver.username · password"
          label="Basic-auth"
          below={
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TextField
                aria-label="Логин TorrServer"
                variant="outlined"
                leading={<Icon name="person" size={20} />}
                placeholder="Логин"
                value={cfg.torrserver.username}
                spellCheck={false}
                onChange={(e) => set('torrserver', { username: e.target.value })}
              />
              <SecretField
                aria-label="Пароль TorrServer"
                variant="outlined"
                leading={<Icon name="lock" size={20} />}
                placeholder="Пароль"
                value={cfg.torrserver.password}
                onValueChange={(password) => set('torrserver', { password })}
              />
            </div>
          }
        />
      </SettingGroup>

      <SettingGroup title="Сервер приложения">
        <SettingRow
          focusId="server.port"
          highlighted={focusId === 'server.port'}
          changed={changedKeys.has('server.port')}
          configKey="server.port"
          label="Порт"
          sub="Lampa и агенты обращаются к 127.0.0.1 на этот порт."
          control={
            <div className="flex flex-wrap items-start gap-2">
              <AppStatusChip tone="warning" size="md" className="mt-1">
                после перезапуска
              </AppStatusChip>
              <div className="w-[160px]">
                <TextField
                  aria-label="Порт сервера"
                  inputMode="numeric"
                  variant="outlined"
                  value={portText}
                  error={portErr ?? undefined}
                  onChange={(e) => {
                    const next = e.target.value
                    setPortText(next)
                    const parsed = parsePort(next)
                    if (parsed.port !== null) set('server', { port: parsed.port })
                  }}
                />
              </div>
            </div>
          }
        />
      </SettingGroup>
    </div>
  )
}
