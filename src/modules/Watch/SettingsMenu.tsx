import { useState } from 'react'
import { api, errorText } from '@/common/api/tauri'
import type { SessionState } from '@/common/types/ipc'
import { IconButton } from '@/common/ui/IconButton'
import { Menu, MenuDivider, MenuItem } from '@/common/ui/Menu'
import { toast } from '@/common/ui/toast'
import { usePlayer } from '@/modules/Player'
import { useAnkiStore } from '@/modules/Anki'
import { useSubsStore } from '@/modules/Subtitles'

function trackLabel(t: SessionState['audioTracks'][number]): string {
  return [t.lang ?? '??', t.codec, `${t.channels}ch`, t.title].filter(Boolean).join(' · ')
}

export function SettingsMenu({ session, onChanged, onGuide }: { session: SessionState; onChanged: () => void; onGuide: () => void }) {
  const p = usePlayer()
  const [open, setOpen] = useState(false)
  const [audio, setAudio] = useState(session.audioIndex)
  const subs = useSubsStore()
  const anki = useAnkiStore()

  return (
    <div className="relative">
      <IconButton icon="settings" label="Настройки" data-menu-trigger onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} align="right" placement="above" className="w-80">
        <MenuDivider title="Аудиодорожка" />
        {session.audioTracks.map((t) => (
          <MenuItem key={t.index} label={trackLabel(t)} selected={t.index === audio} onClick={() => { setAudio(t.index); p.changeAudio(t.index); onChanged() }} />
        ))}
        <MenuDivider title="Субтитры" />
        <MenuItem
          label="Скрывать субтитры"
          on={subs.hideMode}
          onClick={() => subs.set(subs.hideMode ? { hideMode: false } : { hideMode: true, sidebarOpen: false })}
        />
        <MenuItem label="Конструкции" on={subs.patterns} onClick={() => subs.set({ patterns: !subs.patterns })} />
        <MenuItem label="Как читать подсветку (H)" icon="help" onClick={() => { setOpen(false); onGuide() }} />
        <MenuDivider title="Подписи из Anki" />
        <MenuItem label="Только новые (new, learning)" selected={anki.labelMode === 'fresh'} onClick={() => anki.setLabelMode('fresh')} />
        <MenuItem label="Все невыученные" selected={anki.labelMode === 'unlearned'} onClick={() => anki.setLabelMode('unlearned')} />
        <MenuItem label="Выключены" selected={anki.labelMode === 'off'} onClick={() => anki.setLabelMode('off')} />
        <MenuDivider />
        <MenuItem label="Отправить сценарий в tutor" icon="send" onClick={() => {
          setOpen(false)
          api.tutorImportScript(session.mediaId).then((r) => toast(`Сценарий в tutor: «Мои материалы» #${r.id}`)).catch((e) => toast(errorText(e)))
        }} />
        <MenuItem label={`Сдвиг: ${subs.offset.toFixed(1)} с (Z / X)`} icon="sync_alt" onClick={() => undefined} disabled />
      </Menu>
    </div>
  )
}
