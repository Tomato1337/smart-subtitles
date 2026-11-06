import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { SessionState } from '@/common/types/ipc'
import { IconButton } from '@/common/ui/IconButton'
import { Menu, MenuDivider, MenuItem } from '@/common/ui/Menu'
import { toast } from '@/common/ui/toast'
import { keyLabel, useHotkeysStore, withKey } from '@/modules/Hotkeys'
import { usePlayer } from '@/modules/Player'
import { useAnkiStore } from '@/modules/Anki'
import { useSubsStore } from '@/modules/Subtitles'

function trackLabel(t: SessionState['audioTracks'][number]): string {
  return [t.lang ?? '??', t.codec, `${t.channels}ch`, t.title].filter(Boolean).join(' · ')
}

export function SettingsMenu({ session, onChanged, onTour, onGuide, onHotkeys, onAnnotate, onChooseSubs }: { session: SessionState; onChanged: () => void; onTour: () => void; onGuide: () => void; onHotkeys: () => void; onAnnotate: () => void; onChooseSubs: () => void }) {
  const p = usePlayer()
  const [open, setOpen] = useState(false)
  const [audio, setAudio] = useState(session.audioIndex)
  const subs = useSubsStore(useShallow((s) => ({
    hideMode: s.hideMode, patterns: s.patterns, consent: s.annot?.consent, hasCues: s.cues.length > 0, offset: s.offset, set: s.set,
  })))
  const anki = useAnkiStore(useShallow((s) => ({ labelMode: s.labelMode, setLabelMode: s.setLabelMode })))
  const hotkey = useHotkeysStore((s) => s.bindings)
  // Tutor is an add-on: its menu item only exists while the integration is on.
  const config = useQuery({ queryKey: ['config'], queryFn: api.configGet })
  const tutorEnabled = config.data?.tutor.enabled ?? false

  return (
    <div className="relative">
      <IconButton icon="settings" label="Настройки" data-tour="settings" data-menu-trigger onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} align="right" placement="above" className="w-80">
        <MenuDivider title="Аудиодорожка" />
        {session.audioTracks.map((t) => (
          <MenuItem key={t.index} label={trackLabel(t)} selected={t.index === audio} onClick={() => { setAudio(t.index); p.changeAudio(t.index); onChanged() }} />
        ))}
        <MenuDivider title="Субтитры" />
        <MenuItem label="Выбрать субтитры…" icon="subtitles" onClick={() => { setOpen(false); onChooseSubs() }} />
        <MenuItem
          label="Скрывать субтитры"
          on={subs.hideMode}
          onClick={() => subs.set(subs.hideMode ? { hideMode: false } : { hideMode: true, sidebarOpen: false })}
        />
        <MenuItem label="Конструкции" on={subs.patterns} onClick={() => subs.set({ patterns: !subs.patterns })} />
        {session.llmEnabled && subs.consent !== 'on' && subs.hasCues && (
          <MenuItem label="Разобрать диалоги…" icon="translate" onClick={() => { setOpen(false); onAnnotate() }} />
        )}
        <MenuItem label="Обзор возможностей" icon="tour" onClick={() => { setOpen(false); onTour() }} />
        <MenuItem label={withKey('Как читать подсветку', hotkey.guide)} icon="help" onClick={() => { setOpen(false); onGuide() }} />
        <MenuItem label="Горячие клавиши…" icon="keyboard" onClick={() => { setOpen(false); onHotkeys() }} />
        <MenuDivider title="Подписи из Anki" />
        <MenuItem label="Только новые (new, learning)" selected={anki.labelMode === 'fresh'} onClick={() => anki.setLabelMode('fresh')} />
        <MenuItem label="Все невыученные" selected={anki.labelMode === 'unlearned'} onClick={() => anki.setLabelMode('unlearned')} />
        <MenuItem label="Выключены" selected={anki.labelMode === 'off'} onClick={() => anki.setLabelMode('off')} />
        {tutorEnabled && (
          <>
            <MenuDivider />
            <MenuItem label="Отправить сценарий в tutor" icon="send" onClick={() => {
              setOpen(false)
              api.tutorImportScript(session.mediaId).then((r) => toast(`Сценарий в tutor: «Мои материалы» #${r.id}`)).catch((e) => notify('error', errorText(e)))
            }} />
          </>
        )}
        <MenuItem
          label={`Сдвиг: ${subs.offset.toFixed(1)} с${hotkey.offsetMinus || hotkey.offsetPlus ? ` (${keyLabel(hotkey.offsetMinus)} / ${keyLabel(hotkey.offsetPlus)})` : ''}`}
          icon="sync_alt"
          onClick={() => undefined}
          disabled
        />
      </Menu>
    </div>
  )
}
