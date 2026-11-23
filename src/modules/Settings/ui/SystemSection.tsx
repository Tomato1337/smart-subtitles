import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Kbd, Switch, TextField, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, DepsStatus, SystemInfo } from '@/common/types/ipc'
import { keyLabel, useHotkeysStore } from '@/modules/Hotkeys'
import { HighlightGuide, resetTour } from '@/modules/Watch'
import { SECTION_META } from '../lib/sections'
import { AppStatusChip, CopyBox, SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'

/** Tutor's own note type: picked automatically when the add-on is switched on. */
const TUTOR_NOTE_TYPE = 'EF Tutor — Vocab'

export function SystemSection({
  cfg,
  set,
  systemInfo,
  deps,
  changedKeys,
  focusId,
  onOpenWizard,
}: {
  cfg: AppConfig
  set: ApplyConfig
  systemInfo?: SystemInfo
  deps?: DepsStatus
  changedKeys: Set<string>
  focusId?: string
  onOpenWizard: () => void
}) {
  const meta = SECTION_META.system
  const [guideOpen, setGuideOpen] = useState(false)
  const guideKey = useHotkeysStore((s) => s.bindings.guide)
  const catalog = useQuery({ queryKey: ['anki-catalog'], queryFn: api.ankiCatalog, retry: false, staleTime: 30_000 })
  const typeList = catalog.data?.noteTypes ?? []

  const port = systemInfo?.listenPort ?? cfg.server.port
  const guideUrl = `http://127.0.0.1:${port}/llms.txt`

  const setTutorEnabled = (enabled: boolean) => {
    // Turning an inherited primary back into an app-owned one must not leave it twice in the route.
    if (!enabled) set('images', { fallbacks: cfg.images.fallbacks.filter((b) => b !== cfg.images.backend) })
    set('tutor', { enabled })
    const hasTutorType = typeList.some((t) => t.name === TUTOR_NOTE_TYPE)
    if (enabled && hasTutorType && cfg.anki.noteType !== TUTOR_NOTE_TYPE) {
      set('anki', { noteType: TUTOR_NOTE_TYPE })
      toast(`Тип заметки переключён на ${TUTOR_NOTE_TYPE}`)
    }
  }

  const setUseImageSettings = (useImageSettings: boolean) => {
    if (!useImageSettings) set('images', { fallbacks: cfg.images.fallbacks.filter((b) => b !== cfg.images.backend) })
    set('tutor', { useImageSettings })
  }

  const openDir = (kind: 'config' | 'logs') => {
    api.openDir(kind).catch((e) => notify('error', errorText(e)))
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader title={meta.label} subtitle={meta.subtitle} icon={meta.icon} shape={meta.shape} tone={meta.tone} />

      <SettingGroup title="Помощь">
        <SettingRow
          focusId="system.wizard"
          highlighted={focusId === 'system.wizard'}
          icon="auto_fix_high"
          label="Мастер настройки"
          sub="Проверит, что уже есть на компьютере, и спросит недостающее."
          control={
            <Button variant="tonal" icon="auto_fix_high" onClick={onOpenWizard}>
              Открыть мастер
            </Button>
          }
        />

        <SettingRow
          focusId="system.tour"
          highlighted={focusId === 'system.tour'}
          icon="explore"
          label="Тур по приложению"
          sub="Главные экраны плеера за 2 минуты; запустится при следующем открытии фильма."
          control={
            <Button
              variant="tonal"
              icon="explore"
              onClick={() => {
                resetTour()
                toast('Тур запустится при следующем открытии фильма')
              }}
            >
              Пройти тур
            </Button>
          }
        />

        <SettingRow
          focusId="system.guide"
          highlighted={focusId === 'system.guide'}
          icon="palette"
          label="Как читать подсветку"
          sub="Цвета, подчёркивания выражений, конструкции и метки Anki."
          control={
            <div className="flex items-center gap-2">
              {guideKey !== null && <Kbd size="md">{keyLabel(guideKey)}</Kbd>}
              <Button variant="tonal" onClick={() => setGuideOpen(true)}>
                Открыть
              </Button>
            </div>
          }
        />
      </SettingGroup>

      <SettingGroup title="Для ИИ-агентов" subtitle="Агент может настроить приложение сам — дайте ему этот адрес.">
        <SettingRow
          focusId="system.agentApi"
          highlighted={focusId === 'system.agentApi'}
          label="API настройки"
          sub="Ключи в ответах API скрыты как ***."
          below={<CopyBox value={guideUrl} leadingIcon="smart_toy" copiedMessage="Адрес инструкции скопирован" />}
        />
      </SettingGroup>

      {deps && (
        <SettingGroup title="Системные зависимости">
          {deps.deps.map((d, i) => (
            <SettingRow
              key={d.id}
              focusId={i === 0 ? 'system.deps' : undefined}
              highlighted={focusId === 'system.deps'}
              icon={d.found ? 'check_circle' : d.importance === 'required' ? 'error' : 'info'}
              label={d.title}
              sub={d.found ? d.purpose : `${d.purpose} — ${d.hint}`}
              control={
                <AppStatusChip
                  tone={d.found ? 'success' : d.importance === 'required' ? 'error' : 'warning'}
                  size="md"
                  icon={d.found ? 'check_circle' : 'warning'}
                >
                  {d.found ? 'найден' : d.importance === 'required' ? 'нужен' : 'необязательно'}
                </AppStatusChip>
              }
            />
          ))}
        </SettingGroup>
      )}

      <SettingGroup
        title="Видео"
        action={
          systemInfo ? (
            systemInfo.vaapiOk ? (
              <AppStatusChip tone="success" size="md" icon="check_circle">
                самопроверка пройдена
              </AppStatusChip>
            ) : (
              <AppStatusChip tone="neutral" size="md" icon="remove">
                VAAPI не активен
              </AppStatusChip>
            )
          ) : undefined
        }
      >
        <SettingRow
          focusId="ffmpeg.vaapiDevice"
          highlighted={focusId === 'ffmpeg.vaapiDevice'}
          changed={changedKeys.has('ffmpeg.vaapiDevice')}
          configKey="ffmpeg.vaapiDevice"
          label="Устройство VAAPI"
          sub="Аппаратное декодирование и HDR на Linux; на macOS и Windows не используется."
          control={
            <div className="w-full sm:w-[260px]">
              <TextField
                aria-label="Устройство VAAPI"
                variant="outlined"
                value={cfg.ffmpeg.vaapiDevice}
                spellCheck={false}
                onChange={(e) => set('ffmpeg', { vaapiDevice: e.target.value })}
              />
            </div>
          }
        />
      </SettingGroup>

      <SettingGroup title="Tutor" subtitle="Необязательное дополнение: уровень CEFR и свои настройки картинок.">
        <SettingRow
          focusId="tutor.enabled"
          highlighted={
            focusId === 'tutor.enabled' ||
            (!cfg.tutor.enabled && (focusId === 'tutor.connection' || focusId === 'tutor.useImageSettings'))
          }
          changed={changedKeys.has('tutor.enabled')}
          configKey="tutor.enabled"
          icon="school"
          label={
            <>
              Использовать Tutor
              {!cfg.tutor.enabled && (
                <>
                  <span data-focus-id="tutor.connection" aria-hidden="true" />
                  <span data-focus-id="tutor.useImageSettings" aria-hidden="true" />
                </>
              )}
            </>
          }
          sub={`${cfg.tutor.root} · ${cfg.tutor.apiUrl}`}
          control={
            <Switch ariaLabel="Использовать Tutor" checked={cfg.tutor.enabled} onChange={setTutorEnabled} />
          }
        />

        {cfg.tutor.enabled && (
          <>
            <SettingRow
              focusId="tutor.connection"
              highlighted={focusId === 'tutor.connection'}
              changed={changedKeys.has('tutor.root') || changedKeys.has('tutor.apiUrl')}
              configKey="tutor.root · tutor.apiUrl"
              label="Папка и адрес API Tutor"
              below={
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <TextField
                    label="Папка tutor"
                    variant="outlined"
                    value={cfg.tutor.root}
                    spellCheck={false}
                    onChange={(e) => set('tutor', { root: e.target.value })}
                  />
                  <TextField
                    label="Адрес Tutor API"
                    variant="outlined"
                    value={cfg.tutor.apiUrl}
                    spellCheck={false}
                    onChange={(e) => set('tutor', { apiUrl: e.target.value })}
                  />
                </div>
              }
            />

            <SettingRow
              focusId="tutor.useImageSettings"
              highlighted={focusId === 'tutor.useImageSettings'}
              changed={changedKeys.has('tutor.useImageSettings')}
              configKey="tutor.useImageSettings"
              label="Брать настройки картинок из Tutor"
              sub="Основной провайдер картинок будет использоваться из Tutor; запасные останутся из раздела «Картинки»."
              control={
                <Switch
                  ariaLabel="Брать настройки картинок из Tutor"
                  checked={cfg.tutor.useImageSettings}
                  onChange={setUseImageSettings}
                />
              }
            />
          </>
        )}
      </SettingGroup>

      <SettingGroup title="Данные">
        <SettingRow
          focusId="system.logs"
          highlighted={focusId === 'system.logs'}
          icon="description"
          label="Журналы"
          sub={
            systemInfo?.logsDir
              ? `${systemInfo.logsDir} · app, llm, ffmpeg, asr, events — секреты скрыты.`
              : 'app, llm, ffmpeg, asr, events — секреты в них скрыты.'
          }
          control={
            <Button variant="outlined" icon="folder_open" onClick={() => openDir('logs')}>
              Открыть папку
            </Button>
          }
        />

        <SettingRow
          focusId="system.configDir"
          highlighted={focusId === 'system.configDir'}
          icon="folder"
          label="Настройки и база"
          sub={`${systemInfo?.configDir ?? '~/.config/smart-subtitle'} · config.json, data.db`}
          control={
            <Button variant="outlined" icon="folder_open" onClick={() => openDir('config')}>
              Открыть папку
            </Button>
          }
        />
      </SettingGroup>

      <HighlightGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </div>
  )
}
